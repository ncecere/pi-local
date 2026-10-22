# Windows default-only authority: scope candidate, not implementation

Status: research for a separate scope-contract/model review. No location policy
is selected. No v2 codec, registry/DPAPI adapter, lease, migration or factory is
approved here. Format 1 is unchanged; Windows `OpenPersistent` must still refuse
before I/O. Current `Options` contains `Dir` and `Vault`, not these proposed fields.

## Why consider narrower scope

The [authority proposal](windows-secret-authority-candidate.md) admits logical
`default` and explicitly issued custom references. The [test-only model](../qa/v0.5-secret-authority-model.md)
retains a trace where A has acknowledged PENDING without DB, releases leases,
and grammar-valid B initializes at the same observed location. Concurrent leases
alone do not preserve ownership after release.

That trace is a counterexample to the model's admission rules, **not an
unconditional protocol flaw**: root existence/creation freshness and legitimate
custom-reference issuance are not modeled. Strict refusal of an existing empty
root could block the simple trace. A root-loss/recreation extension needs actual
lifecycle, identity and authorization observations; current modeled crash does
not supply them. Preserve this qualification and the original witness unchanged.

One alternative worth modeling is to make B's distinct reference inadmissible,
rather than invent a custom-profile ownership catalog in this increment.

## Proposed default-only contract

- Exactly one stable logical `default` authority per authenticated user SID and
  fixed application identity. Its lookup namespace is independent of `-data`,
  directory spelling, agent identity, filesystem UUID and random new-root values.
- Desktop/headless entry points and compatible versions/installations must resolve
  the intended same application identity. This must be specified and verified,
  not inferred from executable names, a caller-supplied SID or a Wails window ID.
- Reject every custom/unknown reference, including grammar-valid `profile:<uuid>`,
  before filesystem, vault, authority or lease activity. No silent rewrite to
  `default`, path-derived namespace or fallback to legacy storage.
- Acquire the reference lifetime lease before authority access, followed by
  independent directory exclusion. Retain both through the store's lifetime and
  through joined synchronous operations/close. Existing ambiguity rules remain.
- Stored canonical-directory mismatch refuses, preserving authority and artifacts.
  A data-directory change is not permission to initialize a replacement authority,
  migrate, reset, or move an existing root key.
- Preserve missing-authority/existing-artifact refusal; acknowledged PENDING before
  DB initialization; exact authenticated schema/binding and zero reconciled rows
  before PENDING promotion; and immutable ACTIVE flush/exact validated readback on
  **every** reopen, without rewriting ACTIVE.

Under these namespace/admission assumptions, custom B is rejected before activity.
A contender using `default` shares A's authority: the same admitted location can
reconcile A's PENDING, while a different location must refuse the binding. This
removes that distinct-reference competing claim from admitted scope. It does not
establish freshness, native namespace security, general ownership or durability.

## Compare two location policies before selecting either

| Candidate | Explicit compatibility consequence |
| --- | --- |
| First initialization chooses a location | Can honor existing desktop `-data`/`PI_LOCAL_DATA` and headless `-data`. The first attempt may reserve the location through **retained authenticated PENDING, before acknowledgement completes**. A visible or flushed record still constrains location after failed readback; ambiguity never authorizes replacement or another location. Multiple data directories cannot obtain independent default persistent-secret authorities. |
| Enforced known default secret path | Only a specified canonical secret location is admitted. If custom app data remains supported, document that secrets stay at the fixed location; otherwise reject the incompatible configuration explicitly. Trusted default-path derivation and equivalence become additional prerequisites. Never silently discard `-data`. |

Neither policy is selected by this note, and neither proves a genuinely fresh root.
`app.New` already creates its application data directory. An existing application
data directory is not evidence of a fresh dedicated secret root. Keep application
data location and the prospective secret-root admission contract distinct.

## Required model increment (test-only)

Do not change the retained permissive witness into a passing safety test. Model
new candidates separately, with explicit supplied observations and boundaries:

1. Default/custom admission and both location variants. Custom rejection must
   cause zero filesystem/authority/vault/lease operations, including cancellation
   and malformed-input cases. No production `Options` or Windows factory change.
2. SID/application namespace selection independent of directory and binary path.
   Test the intended desktop/headless equivalence and mismatched/unknown identity
   refusal. Supplied authenticated identity is an assumption, not OS proof.
3. Root absent, existing empty, created during this open, and lost/recreated root;
   distinguish location identity from object identity. Define visible/durable
   root observations and crash effects explicitly rather than inferring them from
   missing DB artifacts. Test strict freshness refusal and recovery separately.
4. Retained PENDING reuse, different-location refusal without material replacement,
   lease ordering/exclusion, joined cancellation, and unchanged ACTIVE re-ack.
   Explicitly fail PENDING acknowledgement, then attempt another location directly
   and after modeled crash: any retained authenticated binding still constrains
   selection. If authority and all artifacts are lost, retain the stated
   indistinguishability limitation rather than inventing a historical marker.
   Namespace/root/DB observations must occur under their specified ownership;
   a wrapper must not inspect filesystem state before the required leases.
5. Preserve the existing model's before/after faults, validated-outcome oracle,
   ambiguous-commit cases and no-regeneration assertions. New boundaries need
   their own faults and negative mutations; green transition tests are not native
   durability or cryptographic acceptance.

## Unresolved implementation and compatibility gates

- Authenticated SID acquisition, application identity, native namespace ACLs and
  lifetime ownership; canonical aliases, drive mappings, directory recreation and
  private NTFS object validation. A supplied string or resolved path is not proof.
- Genuine dedicated-root freshness/publication and recovery semantics; bounded
  authenticated authority format, DPAPI/registry behavior and acknowledged hive
  flush/readback; SQLite/WAL durability. No atomic replacement/power-loss proof.
- Explicit legacy detection and refusal/migration design. No automatic import,
  coexistence downgrade, truncation, credential deletion, relocation or reset.
  Authority loss plus all-artifact loss remains indistinguishable from first use;
  stale authenticated snapshots are not made rollback-resistant by narrower scope.
- Preserve portable agent folders containing `state.sqlite`. They are not custom
  application-profile UUIDs. Keep authority and secret material outside agent
  trees and every backup/restore payload: backup walks agent trees and restore
  accepts their contents broadly. Restoring `app.db` must not retarget authority.
- Define prospective sanitized custom-scope unsupported, location/recovery,
  busy/key-lost/corrupt and outcome-unknown outcomes without making a new public
  API promise. No retry/rollback claim follows from an ambiguous failure.

No native registry, DPAPI, credential store, application or personal data was
accessed for this research. A scope-contract/model review may approve only the
modeled narrower admission rules, not native implementation or activation.

Independent security review `0146fd5f` approved research-only progression. It found
a Low ambiguity in the first-publication description: retained authenticated
PENDING can reserve the location before acknowledgement completes. The table and
failed-ack/crash test plan now state that explicitly; bounded follow-up closed the
Low. Neither location variant nor native implementation was approved.
