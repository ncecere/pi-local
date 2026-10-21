package models

import (
	"regexp"
	"strings"
)

// ListPrice is a model's published list price in US dollars per million tokens. CacheRead and CacheWrite are nil when
// the service publishes none (cached tokens are then counted as input).
type ListPrice struct {
	Input      float64
	Output     float64
	CacheRead  *float64
	CacheWrite *float64
}

// PriceSource says where a model's prices came from: PriceList (this table) or PriceYou (typed in Settings → Models).
const (
	PriceList = "list"
	PriceYou  = "you"
)

// PriceListChecked is when the table was last checked against the services' own pricing pages.
const PriceListChecked = "2026-10-21"

func f(v float64) *float64 { return &v }

// The table is keyed by a normalized model ID (see normalizeModelID): lowercase, no provider prefix, no dated suffix,
// dots as dashes. Only flat list prices of generally available models are here. Prices that are promotional, change
// on a date already announced, or depend on the time of day are left out rather than guessed; so are models whose
// price depends on something not in the ID. A model that is not here is simply unpriced until the person sets prices.
//
// Where a service has one price for short prompts and a higher one for long prompts (OpenAI over 272K tokens, Gemini
// Pro over 200K), the short-prompt price is used, so a long-prompt estimate is a little low.
//
// Sources, each checked on PriceListChecked: platform.claude.com/docs/en/about-claude/pricing (cache write is the
// five-minute price), platform.openai.com/docs/pricing (Standard processing), ai.google.dev/gemini-api/docs/pricing
// (Standard, paid tier), docs.mistral.ai model cards, api-docs.deepseek.com/quick_start/pricing.
var priceList = map[string]ListPrice{
	// Anthropic.
	"claude-opus-5-5":   {4, 20, f(0.20), f(5)},
	"claude-opus-5":     {5, 25, f(0.50), f(6.25)},
	"claude-opus-4-8":   {5, 25, f(0.50), f(6.25)},
	"claude-opus-4-7":   {5, 25, f(0.50), f(6.25)},
	"claude-opus-4-6":   {5, 25, f(0.50), f(6.25)},
	"claude-opus-4-5":   {5, 25, f(0.50), f(6.25)},
	"claude-opus-4-1":   {15, 75, f(1.50), f(18.75)},
	"claude-opus-4":     {15, 75, f(1.50), f(18.75)},
	"claude-opus-4-0":   {15, 75, f(1.50), f(18.75)},
	"claude-sonnet-5-5": {2, 10, f(0.10), f(2.50)},
	"claude-sonnet-5":   {2, 10, f(0.20), f(2.50)},
	"claude-sonnet-4-6": {3, 15, f(0.30), f(3.75)},
	"claude-sonnet-4-5": {3, 15, f(0.30), f(3.75)},
	"claude-sonnet-4":   {3, 15, f(0.30), f(3.75)},
	"claude-sonnet-4-0": {3, 15, f(0.30), f(3.75)},
	"claude-haiku-4-5":  {1, 5, f(0.10), f(1.25)},
	"claude-3-5-haiku":  {0.80, 4, f(0.08), f(1)},
	"claude-haiku-3-5":  {0.80, 4, f(0.08), f(1)},

	// OpenAI.
	"gpt-6-astra":       {10, 50, f(1), nil},
	"gpt-6-1-sol":       {2, 10, f(0.10), nil},
	"gpt-6-sol":         {2, 10, f(0.20), nil},
	"gpt-6-luna":        {0.10, 0.50, f(0.01), nil},
	"gpt-5-6-terra":     {2, 12, f(0.20), nil},
	"gpt-5-6-luna":      {0.20, 1.20, f(0.02), nil},
	"gpt-5-5":           {5, 30, f(0.50), nil},
	"gpt-5-5-pro":       {30, 180, nil, nil},
	"gpt-5-4":           {2.50, 15, f(0.25), nil},
	"gpt-5-4-pro":       {30, 180, nil, nil},
	"gpt-5-4-mini":      {0.75, 4.50, f(0.075), nil},
	"gpt-5-4-nano":      {0.20, 1.25, f(0.02), nil},
	"gpt-5-2":           {1.75, 14, f(0.175), nil},
	"gpt-5-2-pro":       {21, 168, nil, nil},
	"gpt-5-1":           {1.25, 10, f(0.125), nil},
	"gpt-5":             {1.25, 10, f(0.125), nil},
	"gpt-5-mini":        {0.25, 2, f(0.025), nil},
	"gpt-5-nano":        {0.05, 0.40, f(0.005), nil},
	"gpt-5-pro":         {15, 120, nil, nil},
	"gpt-4-1":           {2, 8, f(0.50), nil},
	"gpt-4-1-mini":      {0.40, 1.60, f(0.10), nil},
	"gpt-4-1-nano":      {0.10, 0.40, f(0.025), nil},
	"gpt-4o":            {2.50, 10, f(1.25), nil},
	"gpt-4o-2024-05-13": {5, 15, nil, nil},
	"gpt-4o-mini":       {0.15, 0.60, f(0.075), nil},
	"o1":                {15, 60, f(7.50), nil},
	"o1-pro":            {150, 600, nil, nil},
	"o3":                {2, 8, f(0.50), nil},
	"o3-pro":            {20, 80, nil, nil},
	"o3-mini":           {1.10, 4.40, f(0.55), nil},
	"o4-mini":           {1.10, 4.40, f(0.275), nil},
	"gpt-4-turbo":       {10, 30, nil, nil},
	"gpt-4-0613":        {30, 60, nil, nil},
	"gpt-3-5-turbo":     {0.50, 1.50, nil, nil},

	// Google (Gemini API).
	"gemini-3-1-pro-preview": {2, 12, f(0.20), nil},
	"gemini-3-flash-preview": {0.50, 3, f(0.05), nil},
	"gemini-3-1-flash-lite":  {0.25, 1.50, f(0.025), nil},
	"gemini-3-5-flash-lite":  {0.30, 2.50, f(0.03), nil},
	"gemini-2-5-pro":         {1.25, 10, f(0.125), nil},
	"gemini-2-5-flash":       {0.30, 2.50, f(0.03), nil},
	"gemini-2-5-flash-lite":  {0.10, 0.40, f(0.01), nil},

	// Mistral (the -latest names are the model they point to now).
	"mistral-large-2512":    {0.50, 1.50, nil, nil},
	"mistral-large-latest":  {0.50, 1.50, nil, nil},
	"mistral-medium-3-5":    {1.50, 7.50, nil, nil},
	"mistral-medium-latest": {1.50, 7.50, nil, nil},
	"mistral-small-2603":    {0.15, 0.60, nil, nil},
	"mistral-small-latest":  {0.15, 0.60, nil, nil},

	// DeepSeek. Its prices are half as much off-peak; these are the peak prices, so an estimate errs high.
	"deepseek-flash":    {0.30, 1.20, f(0.006), nil},
	"deepseek-v4-flash": {0.30, 1.20, f(0.006), nil},
	"deepseek-v4-pro":   {1.32, 3.96, f(0.044), nil},
}

var (
	// Bedrock and Vertex regions and vendors in front of a model name: "us.anthropic.claude-…", "anthropic.claude-…".
	vendorPrefix = regexp.MustCompile(`^(?:(?:us|eu|apac|au|jp|global)\.)?(?:anthropic|amazon|meta|mistral|deepseek|openai|google)\.`)
	// "-v1:0", the end of a Bedrock model ID.
	bedrockSuffix = regexp.MustCompile(`-v\d+(?::\d+)?$`)
	// A date at the end: "-20250514", "-2025-08-07", "@20250929".
	compactDate = regexp.MustCompile(`[-@]\d{8}$`)
	dashedDate  = regexp.MustCompile(`-\d{4}-\d{2}-\d{2}$`)
)

// normalizeModelID turns what a service or a gateway calls a model into the table's form: the last path segment
// ("anthropic/claude-sonnet-4.5", "openrouter/openai/gpt-5"), without a Bedrock vendor or version, lowercase, with
// dots as dashes ("gpt-5.4" and "gpt-5-4" are one model).
func normalizeModelID(id string) string {
	id = strings.ToLower(strings.TrimSpace(id))
	if i := strings.LastIndex(id, "/"); i >= 0 {
		id = id[i+1:]
	}
	id = vendorPrefix.ReplaceAllString(id, "")
	id = bedrockSuffix.ReplaceAllString(id, "")
	return strings.ReplaceAll(id, ".", "-")
}

// LookupListPrice finds the list price of a model by ID. The ID may carry a provider prefix ("anthropic/claude-…",
// "openai/gpt-…"), a dated suffix ("claude-sonnet-4-5-20250929", "gpt-4.1-2025-04-14"), dots or dashes in the
// version, or Bedrock's vendor and version ("us.anthropic.claude-sonnet-4-5-20250929-v1:0"). An ID that isn't known
// exactly, after those are removed, has no price: "gpt-5.4-turbo" is not "gpt-5.4".
func LookupListPrice(modelID string) (ListPrice, bool) {
	id := normalizeModelID(modelID)
	if id == "" || strings.ContainsAny(id, ": ") {
		return ListPrice{}, false
	}
	// The ID as it is first (a dated model with a price of its own, like gpt-4o-2024-05-13), then without its date.
	for _, candidate := range []string{id, compactDate.ReplaceAllString(id, ""), dashedDate.ReplaceAllString(id, "")} {
		if p, ok := priceList[candidate]; ok {
			return p, true
		}
	}
	return ListPrice{}, false
}

// localPresets are the providers that run models on this computer for nothing: a model there named like a paid one
// (llama or gpt-oss are fine, but "gpt-4o" behind a local proxy is the person's to price) gets no list price.
func localPreset(providerID string) bool {
	return providerID == "ollama" || providerID == "lm-studio"
}
