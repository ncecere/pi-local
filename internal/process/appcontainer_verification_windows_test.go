//go:build windows

package process

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsFixedVerificationDependencyAmbiguityZeroOperations(t *testing.T) {
	for mask := 0; mask < 3; mask++ {
		t.Run(fmt.Sprint(mask), func(t *testing.T) {
			calls := 0
			dependencies := &windowsAppContainerVerification{}
			if mask&1 != 0 {
				dependencies.query = func(windows.Token, uint32, *byte, uint32, *uint32) error { calls++; return nil }
			}
			if mask&2 != 0 {
				dependencies.checkLPAC = func(windows.Token, []byte) error { calls++; return nil }
			}
			policy := candidatePolicy(t, true)
			for _, bundle := range []*windowsAppContainerVerification{nil, dependencies} {
				if err := verifyWindowsAppContainerToken(123, policy, bundle); err == nil || !strings.Contains(err.Error(), "incomplete AppContainer verification") {
					t.Fatal("missing/partial direct bundle did not refuse")
				}
			}
			source := &windowsChildTokenAPI{
				open:  func(windows.Handle, uint32, *windows.Token) error { calls++; return nil },
				close: func(windows.Token) error { calls++; return nil },
			}
			if err := verifyWindowsOwnedChildToken(77, policy, dependencies, source); err == nil {
				t.Fatal("partial bundle opened source")
			}
			// Invalid descriptor and fake borrowed handle deliberately follow the
			// dependency gate. If native query123 happens first its different error
			// cannot satisfy this assertion. No profile/child/token is created.
			tr, err := startWindowsOwned(context.Background(), nil, windowsLaunchHooks{
				primaryToken: 123, verification: dependencies, childToken: source,
				beforeAttribute: func(uintptr) error { calls++; return nil },
			}, policy)
			if tr != nil || err == nil || !strings.Contains(err.Error(), "incomplete AppContainer verification") || calls != 0 {
				t.Fatalf("partial injection reached native launch/query: calls=%d err=%v", calls, err)
			}
		})
	}
	// A complete fake controls the very first borrowed-primary query as well.
	stop := errors.New("explicit fake primary query")
	queries := 0
	dependencies := &windowsAppContainerVerification{
		query: func(token windows.Token, class uint32, _ *byte, n uint32, _ *uint32) error {
			queries++
			if token != 123 || class != windows.TokenType || n != 4 {
				t.Fatal("borrowed primary query changed")
			}
			return stop
		},
		checkLPAC: func(windows.Token, []byte) error { t.Fatal("primary reached checker"); return nil },
	}
	tr, err := startWindowsOwned(context.Background(), nil, windowsLaunchHooks{primaryToken: 123, verification: dependencies}, candidatePolicy(t, true))
	if tr != nil || !errors.Is(err, stop) || queries != 1 {
		t.Fatal("borrowed primary escaped complete injected query bundle")
	}
}

func TestWindowsFixedSourceDependencyAmbiguityZeroOperations(t *testing.T) {
	for mask := 0; mask < 3; mask++ {
		calls := 0
		api := &windowsChildTokenAPI{}
		if mask&1 != 0 {
			api.open = func(windows.Handle, uint32, *windows.Token) error { calls++; return nil }
		}
		if mask&2 != 0 {
			api.close = func(windows.Token) error { calls++; return nil }
		}
		dependencies := &windowsAppContainerVerification{
			query:     func(windows.Token, uint32, *byte, uint32, *uint32) error { calls++; return nil },
			checkLPAC: func(windows.Token, []byte) error { calls++; return nil },
		}
		policy := candidatePolicy(t, true)
		for _, source := range []*windowsChildTokenAPI{nil, api} {
			if err := verifyWindowsOwnedChildToken(77, policy, dependencies, source); err == nil {
				t.Fatal("missing/partial source dependencies accepted")
			}
		}
		tr, err := startWindowsOwned(context.Background(), nil, windowsLaunchHooks{primaryToken: 123, verification: dependencies, childToken: api}, policy)
		if tr != nil || err == nil || !strings.Contains(err.Error(), "incomplete AppContainer source token") || calls != 0 {
			t.Fatal("partial source bundle reached borrowed-primary/native operations")
		}
	}
}

func TestWindowsFixedVerificationAlwaysChecksSelectedLPAC(t *testing.T) {
	for _, selected := range []bool{false, true} {
		for _, checkerErr := range []error{nil, windows.ERROR_ACCESS_DENIED, windows.ERROR_INVALID_PARAMETER, errors.New("checker refusal")} {
			metadata := goodCandidateToken(t)
			checked := 0
			dependencies := &windowsAppContainerVerification{
				query: func(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
					if class == 46 {
						t.Fatal("fixed authority queried46")
					}
					return metadata.query(token, class, out, n, used)
				},
				checkLPAC: func(token windows.Token, profile []byte) error {
					checked++
					if token != 123 || !bytes.Equal(profile, lpacTestProfile()) {
						t.Fatal("checker source/profile changed")
					}
					return checkerErr
				},
			}
			err := verifyWindowsAppContainerToken(123, candidatePolicy(t, selected), dependencies)
			wantCalls := 0
			var wantErr error
			if selected {
				wantCalls, wantErr = 1, checkerErr
			}
			if checked != wantCalls || err != wantErr {
				t.Fatal("selected LPAC waived checker or changed API error into DENY")
			}
			metadata.appContainer = 0
			checked = 0
			if verifyWindowsAppContainerToken(123, candidatePolicy(t, selected), dependencies) == nil || checked != 0 {
				t.Fatal("nonAC token reached checker")
			}
		}
	}
}

func TestWindowsFixedVerificationRejectsOrdinaryACThroughChecker(t *testing.T) {
	for _, lpac := range []bool{false, true} {
		f := newCandidateAccessFake(t, lpac)
		api := lpacTestAPI(f)
		checked := 0
		dependencies := &windowsAppContainerVerification{query: api.query, checkLPAC: func(source windows.Token, profile []byte) error {
			checked++
			return verifyWindowsLPACSemantics(source, profile, api)
		}}
		err := verifyWindowsAppContainerToken(10, candidatePolicy(t, true), dependencies)
		if (err == nil) != lpac || checked != 1 || f.duplicates != 1 || f.checks != map[bool]int{true: 3, false: 2}[lpac] {
			t.Fatal("ordinary AC accepted by authoritative fixed contract")
		}
		lpacAssertBorrowed(t, f, 1)
	}
}

func TestWindowsFixedOwnedSourceAndDuplicateCloseFailures(t *testing.T) {
	duplicateErr, sourceErr := errors.New("duplicate close uncertain"), errors.New("source close uncertain")
	for _, mode := range []string{"success", "duplicate-close", "source-close", "both-close", "access-both-close"} {
		t.Run(mode, func(t *testing.T) {
			f := newCandidateAccessFake(t, true)
			api := lpacTestAPI(f)
			baseClose := api.close
			var retired []windows.Token
			api.close = func(token windows.Token) error {
				retired = append(retired, token)
				if err := baseClose(token); err != nil {
					return err
				}
				if mode == "duplicate-close" || strings.Contains(mode, "both-close") {
					return duplicateErr
				}
				return nil
			}
			if mode == "access-both-close" {
				api.access = func(*byte, windows.Token, uint32, *lpacAccessMapping, *byte, *uint32, *uint32, *int32) error {
					return windows.ERROR_ACCESS_DENIED
				}
			}
			dependencies := &windowsAppContainerVerification{query: api.query, checkLPAC: func(source windows.Token, profile []byte) error {
				return verifyWindowsLPACSemantics(source, profile, api)
			}}
			source := &windowsChildTokenAPI{open: f.api.open, close: func(token windows.Token) error {
				retired = append(retired, token)
				if err := baseClose(token); err != nil {
					return err
				}
				if mode == "source-close" || strings.Contains(mode, "both-close") {
					return sourceErr
				}
				return nil
			}}
			err := verifyWindowsOwnedChildToken(77, candidatePolicy(t, true), dependencies, source)
			if (err == nil) != (mode == "success") || len(retired) != 2 || retired[0] != 12 || retired[1] != 10 {
				t.Fatal("source/duplicate ownership, order or refusal changed")
			}
			if (mode == "duplicate-close" || strings.Contains(mode, "both-close")) && !errors.Is(err, duplicateErr) {
				t.Fatal("duplicate uncertainty lost at launcher boundary")
			}
			if (mode == "source-close" || strings.Contains(mode, "both-close")) && !errors.Is(err, sourceErr) {
				t.Fatal("source uncertainty lost at launcher boundary")
			}
			if mode == "access-both-close" && !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
				t.Fatal("API error classified as DENY or lost to cleanup")
			}
			f.assertOwned(t, 1, 1)
		})
	}
}

func TestWindowsFixedSourceOwnershipRightsAndCloseRefusal(t *testing.T) {
	openErr, checkErr, closeErr := errors.New("open"), errors.New("checker"), errors.New("source close uncertain")
	for _, selected := range []bool{false, true} {
		for _, mode := range []string{"success", "checker", "close", "checker-close", "metadata-close", "open", "partial-open-close", "zero", "reserved"} {
			t.Run(fmt.Sprintf("%v/%s", selected, mode), func(t *testing.T) {
				metadata := goodCandidateToken(t)
				opened, closed, checked, queried := 0, 0, 0, 0
				dependencies := &windowsAppContainerVerification{
					query: func(token windows.Token, class uint32, out *byte, n uint32, used *uint32) error {
						queried++
						if closed != 0 || token != 123 {
							t.Fatal("query after source retirement or wrong source")
						}
						return metadata.query(token, class, out, n, used)
					},
					checkLPAC: func(token windows.Token, profile []byte) error {
						checked++
						if closed != 0 || token != 123 || !bytes.Equal(profile, lpacTestProfile()) {
							t.Fatal("checker source lifetime/identity")
						}
						if strings.Contains(mode, "checker") {
							return checkErr
						}
						return nil
					},
				}
				api := &windowsChildTokenAPI{
					open: func(process windows.Handle, rights uint32, out *windows.Token) error {
						opened++
						want := uint32(windows.TOKEN_QUERY)
						if selected {
							want |= windows.TOKEN_DUPLICATE
						}
						if process != 77 || rights != want || opened != 1 {
							t.Fatal("not one retained PROCESS handle open with exact rights")
						}
						if mode == "open" {
							return openErr
						}
						if mode == "zero" {
							return nil
						}
						if mode == "reserved" {
							*out = windows.Token(^uintptr(0))
							return nil
						}
						*out = 123
						if mode == "partial-open-close" {
							return openErr
						}
						return nil
					},
					close: func(token windows.Token) error {
						closed++
						if token != 123 || closed != 1 {
							t.Fatal("source retired more than once or wrong handle")
						}
						if strings.Contains(mode, "close") {
							return closeErr
						}
						return nil
					},
				}
				if mode == "metadata-close" {
					metadata.appContainer = 0
				}
				err := verifyWindowsOwnedChildToken(77, candidatePolicy(t, selected), dependencies, api)
				wantClose, wantCheck := 1, 0
				if selected {
					wantCheck = 1
				}
				if mode == "open" || mode == "zero" || mode == "reserved" {
					wantClose = 0
				}
				if mode == "open" || mode == "partial-open-close" || mode == "zero" || mode == "reserved" || mode == "metadata-close" {
					wantCheck = 0
				}
				wantSuccess := mode == "success" || (!selected && mode == "checker")
				if opened != 1 || closed != wantClose || checked != wantCheck || (err == nil) != wantSuccess {
					t.Fatalf("ownership/gate: open=%d close=%d check=%d err=%v", opened, closed, checked, err)
				}
				if strings.Contains(mode, "close") && !errors.Is(err, closeErr) {
					t.Fatal("source close uncertainty waived")
				}
				if selected && strings.Contains(mode, "checker") && !errors.Is(err, checkErr) {
					t.Fatal("checker cause lost to source retirement")
				}
				if (mode == "open" || mode == "partial-open-close") && !errors.Is(err, openErr) {
					t.Fatal("open cause lost")
				}
				if (mode == "open" || mode == "partial-open-close" || mode == "zero" || mode == "reserved") && queried != 0 {
					t.Fatal("failed source output queried")
				}
			})
		}
	}
}
