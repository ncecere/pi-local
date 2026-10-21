package models

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/ncecere/pi-local/internal/appdb"
	"github.com/ncecere/pi-local/internal/secrets"
)

func priceCatalog(t *testing.T) *Catalog {
	t.Helper()
	db, err := appdb.Open(context.Background(), filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	c := New(db, secrets.NewMemory())
	for _, p := range []struct{ id, name, kind, base string }{
		{"anthropic", "Anthropic", "anthropic", "https://api.anthropic.com"},
		{"ollama", "Ollama", "openai-compatible", "http://localhost:11434/v1"},
	} {
		k, n, b, id := p.kind, p.name, p.base, p.id
		if _, err := c.CreateProvider(context.Background(), ProviderInput{ID: &id, Name: &n, Kind: &k, BaseURL: &b}); err != nil {
			t.Fatal(err)
		}
	}
	return c
}

func num(v float64) json.RawMessage { raw, _ := json.Marshal(v); return raw }

func str(m *Model) string {
	if m.PriceSource == nil {
		return "-"
	}
	return *m.PriceSource
}

func TestAModelAddedWithoutPricesGetsItsListPrices(t *testing.T) {
	ctx := context.Background()
	c := priceCatalog(t)
	m, err := c.PutModel(ctx, "anthropic", "claude-sonnet-4-5-20250929", ModelInput{})
	if err != nil {
		t.Fatal(err)
	}
	if m.InputPrice == nil || *m.InputPrice != 3 || *m.OutputPrice != 15 || *m.CacheReadPrice != 0.30 || *m.CacheWritePrice != 3.75 || str(m) != "list" || !m.HasListPrice {
		t.Fatalf("a new model: %+v", m)
	}

	// One the list doesn't know is left unpriced, without an error.
	m, err = c.PutModel(ctx, "anthropic", "my-private-model", ModelInput{})
	if err != nil || m.InputPrice != nil || str(m) != "-" || m.HasListPrice {
		t.Fatalf("an unknown model: %+v %v", m, err)
	}

	// Prices given with it are the person's, even equal to the list's.
	m, err = c.PutModel(ctx, "anthropic", "claude-haiku-4-5", ModelInput{InputPrice: num(1), OutputPrice: num(5)})
	if err != nil || str(m) != "you" || m.CacheReadPrice != nil {
		t.Fatalf("a priced new model: %+v %v", m, err)
	}

	// Nulls, as an empty form sends them, are no prices either.
	m, err = c.PutModel(ctx, "anthropic", "claude-opus-4-5", ModelInput{InputPrice: json.RawMessage("null"), OutputPrice: json.RawMessage("null")})
	if err != nil || m.InputPrice == nil || *m.InputPrice != 5 || str(m) != "list" {
		t.Fatalf("a new model with null prices: %+v %v", m, err)
	}

	// A local server's model named like a paid one isn't priced.
	m, err = c.PutModel(ctx, "ollama", "gpt-4o", ModelInput{})
	if err != nil || m.InputPrice != nil || m.HasListPrice {
		t.Fatalf("a local model: %+v %v", m, err)
	}
	if _, err := c.PutModel(ctx, "ollama", "gpt-4o", ModelInput{PriceFromList: ptr2(true)}); err == nil {
		t.Fatal("list prices for a local model should be refused")
	}
}

func ptr2[T any](v T) *T { return &v }

func TestChangingPricesMarksThemAsTheirs(t *testing.T) {
	ctx := context.Background()
	c := priceCatalog(t)
	c.PutModel(ctx, "anthropic", "claude-sonnet-4-5", ModelInput{})

	// Editing a price: yours now.
	m, err := c.PutModel(ctx, "anthropic", "claude-sonnet-4-5", ModelInput{OutputPrice: num(16)})
	if err != nil || str(m) != "you" || *m.OutputPrice != 16 || *m.InputPrice != 3 {
		t.Fatalf("after an edit: %+v %v", m, err)
	}
	// An edit that isn't about prices leaves them and their source alone.
	m, err = c.PutModel(ctx, "anthropic", "claude-sonnet-4-5", ModelInput{Name: ptr2("Sonnet")})
	if err != nil || str(m) != "you" || *m.OutputPrice != 16 {
		t.Fatalf("a rename: %+v %v", m, err)
	}
	// Sending the prices it already has (the edit form does) isn't an edit of them.
	c.PutModel(ctx, "anthropic", "claude-haiku-4-5", ModelInput{PriceFromList: ptr2(true)})
	m, err = c.PutModel(ctx, "anthropic", "claude-haiku-4-5", ModelInput{InputPrice: num(1), OutputPrice: num(5), CacheReadPrice: num(0.10), CacheWritePrice: num(1.25), Name: ptr2("Haiku")})
	if err != nil || str(m) != "list" {
		t.Fatalf("the same prices again: %+v %v", m, err)
	}
	// Back to the list's.
	m, err = c.PutModel(ctx, "anthropic", "claude-sonnet-4-5", ModelInput{PriceFromList: ptr2(true)})
	if err != nil || str(m) != "list" || *m.OutputPrice != 15 || *m.CacheReadPrice != 0.30 {
		t.Fatalf("list prices again: %+v %v", m, err)
	}
	// Cleared: unpriced, and no source.
	m, err = c.PutModel(ctx, "anthropic", "claude-sonnet-4-5", ModelInput{InputPrice: json.RawMessage("null"), OutputPrice: json.RawMessage("null")})
	if err != nil || m.InputPrice != nil || m.CacheReadPrice != nil || str(m) != "-" {
		t.Fatalf("cleared: %+v %v", m, err)
	}
	// Asking for a list price a model hasn't got is an error that says so.
	c.PutModel(ctx, "anthropic", "mystery", ModelInput{})
	_, err = c.PutModel(ctx, "anthropic", "mystery", ModelInput{PriceFromList: ptr2(true)})
	if e, ok := err.(*Error); !ok || e.Code != "no_list_price" {
		t.Fatalf("list prices for an unknown model: %v", err)
	}
	// Prices that make no sense are refused.
	if _, err := c.PutModel(ctx, "anthropic", "mystery", ModelInput{CacheReadPrice: num(-1)}); err == nil {
		t.Fatal("a negative price")
	}
}
