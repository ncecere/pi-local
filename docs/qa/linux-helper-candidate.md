# Offline Linux helper candidate — disabled, native acceptance blocked

This record concerns the isolated `v05/linux-sandbox-helper` branch, not released main or Linux product support.
Production run/guard always refuse; only a test-built driver reaches candidate confinement. No host security policy
has been changed to make the tests pass. See `docs/design/linux-sandbox-helper.md` for the proposed boundary.

## Source and review

- Initial candidate `7db670e`: portable unit/race/vet and Linux cross-builds passed after final formatting.
- Independent security review found no confirmed escape but required stronger native exec-entry, PID-1 authority,
  pre-existing-thread TSYNC and lifecycle evidence. This was not native acceptance.
- Test additions `73d8111` were reviewed with required changes: early-failure cleanup, high-FD enumeration beyond
  RLIMIT_NOFILE, strict PID-1 FD inventory, and all-task children revalidation.
- Corrections `ae6bb24` resolved three statically; follow-up review found retained stderr could block exec.Wait.
  `b96c67b` bounds WaitDelay before Start and proves both cleanup methods join while a real descendant retains stderr.
  A zero-delay negative control fails until explicitly released. Parent reviewed the corrective diff and reran gates.

## Actual Ubuntu evidence

CI uses Ubuntu 24.04, UID 1001, kernel 6.17.0-1022-azure and distribution bubblewrap 0.9.0-1ubuntu0.3.
Recorded root filesystem is shared ext4; AppArmor unprivileged-userns restriction is enabled.

Runs 39690193912 and 39690813414 failed before guard/target execution with bubblewrap loopback RTM_NEWADDR refusal.
Standalone bubblewrap probes also failed in every early-no-new-privileges / cap-drop combination, while retaining
network isolation. This rules out those helper settings as the sole cause; it does not prove the precise kernel/MAC
cause. No namespace policy, AppArmor profile or sysctl was weakened.

Runs 39694046962 and 39695000439 exercised additional kernel tests: pre-existing locked-thread TSYNC, forbidden
syscall variants, ABI denial, partial pidfd cleanup, retained-stderr joins and inventory-race regressions passed.
Static C linking/execution also worked, but standalone positive FD controls initially rejected an unexpected pipe.
Numeric-only diagnostics showed an actual non-CLOEXEC pipe at FD 142; no descriptor was ignored by the detector.

At `d9abde0`, run [39695944829](https://github.com/ncecere/pi-local/actions/runs/39695944829) established:

- The Go test parent already held non-CLOEXEC pipes at FDs 142 and 145. A direct, unprepared exec correctly rejected
  FD 142. Origin beyond that parent observation remains unproven; no path/content/inode metadata was logged.
- A separate static, disposable control launcher prepares explicit input FDs only in its own process. It is never
  used by the PID-1 candidate probe. The raw detector remains unchanged and rejects intentional FD 3, a newly created
  pipe, and FD 100 surviving lowered soft/hard limits. Parent CLOEXEC flags stay unchanged.
- All standalone control/launcher argument tests passed, including missing stdio and extra pipe/eventfd controls.
- Multi-thread TSYNC and cleanup regression tests passed again.

The **overall run still failed**: actual candidate exec authority, filesystem/environment, shell/Node, concurrent
swap and namespace teardown tests could not get past bubblewrap admission. No full confinement, Node compatibility,
PID-1 authority containment or lifecycle-chain success is claimed. Unknown legitimate init monitor FDs remain a
conservative compatibility refusal, not a reason to permit arbitrary pipes/events.

## Remaining gates

Identify a supported Ubuntu security configuration using authoritative distro evidence without global weakening;
then exercise actual guard mounts/proc/FD confinement, both parent-death chains, swaps and offline workloads.
Shared/slave propagation restrictions may be a subsequent independent blocker. Keep production disabled until
those native results and independent review support a separate activation change.

Local receipts remain under `.cache/ubuntu-*.log`. All fixtures use temporary synthetic data. The personal native
app, profiles, providers, Keychain and Application Support were never used as test resources.
