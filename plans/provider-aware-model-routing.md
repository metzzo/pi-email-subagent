# Provider-Aware Model Routing Plan

Date: 2026-08-23
Status: implemented — deterministic Pi 0.81.1 RPC acceptance complete; external/live providers not exercised
Priority: P2 historical correctness and restore safety
Classification: historical extension routing defect with a partial current-code mitigation and unresolved provider-binding semantics

## Executive decision

Treat a subagent's provider/model as a durable identity binding even though the email address continues to encode only the model ID.

The routing rules are:

1. **Existing identity:** resolve the record's persisted `provider + modelId` exactly. Main's current provider must not rebind it.
2. **New identity:** if the address model ID has one catalog candidate, use it. If it has duplicates, use the current main provider only when exactly one candidate belongs to that provider. Otherwise fail closed.
3. **Accepted-but-not-yet-registered identity:** persist the selected provider/model in the first mail's durable spawn intent so crash recovery cannot choose again.
4. **Removed/renamed provider or model:** preserve the original binding, keep the identity inspectable, and fail with an actionable diagnostic. Never substitute a same-ID model from another provider.
5. **Main model switch:** update the preference for future unknown identities. Existing, stopped, archived, failed, and restored identities retain their binding.

Do not add the provider to email address syntax unless later evidence proves model-ID-only addresses cannot support the required semantics.

## Audit evidence and measurement boundary

The source audit is the schema-parsed, deduplicated report stored as canonical email `mail_00mt5p8crh_000_4fa00188d4` in `/home/claudy/.pi/agent/subagents/01a02e21-1fb8-7cd3-b238-26fdd93c97f4/mail.jsonl` at the 2026-08-23 cutoff. Its independent review is canonical email `mail_00mt5phu0p_000_641b08e410` in the same journal.

The audit reports 28 final-registry `Model unavailable during restore` failures across 5 independent parent sessions after duplicate model IDs appeared across providers. Representative affected parents include `019ffc8d…`, `01a00fc6…`, and `01a01024…`. These are structured registry/alert/inspection outcomes, not grep-derived text counts.

HEAD `6e869743957f8f5b8be99dc642af2345c9ce7ee7` contains a mitigation:

- `src/address.ts` selects a duplicate model ID only when exactly one candidate matches `preferredProvider`;
- `src/index.ts` passes `ctx.model?.provider` at broker construction; and
- `test/unit/address.test.ts` covers the preferred-provider selection helper.

This is a **code mitigation present**, not a live-verified fix. The independent review found two remaining semantic gaps in current code:

- startup restoration selects through the startup main provider and overwrites the loaded record's provider/model; and
- `model_select` changes main's address but not the catalog's immutable provider preference.

No live same-provider restore, duplicate-provider restore, archived restore, provider removal, or provider-switch test was run by the audit or during this planning work.

All future historical measurements must parse registry JSON, mail JSONL, and active session branches by schema and stable identities. Do not count restore failures by grep or regex over JSONL.

## Problem and attribution limits

The historical failure was caused by the extension's address/catalog semantics: an email address encodes `<model-id>.com`, while the catalog can expose the same model ID under more than one provider.

The current mitigation solves one narrow question: “for an ambiguous **new resolution**, is there exactly one candidate under the startup main provider?” It does not yet define or enforce the more important distinction between:

- resolving an unknown address for the first time; and
- restoring/reusing a durable identity that already has a provider/model binding.

Current restore code can therefore silently choose the startup main provider and overwrite a record that was originally bound elsewhere. Current mid-session model switching can leave future address resolution pinned to the startup provider. These are extension-level semantics, not evidence of a Pi provider failure.

Provider catalog removal/rename is a separate external configuration change. The extension must handle it safely, but cannot guarantee that a removed provider/model remains runnable.

## Goals

1. Preserve an existing identity's originally selected provider/model across process restart, stopped restart, archived restoration, main model switching, and later duplicate IDs.
2. Resolve a new ambiguous model address through the **current** main provider only when the match is unique.
3. Persist a new identity's binding at the same durable mail-acceptance boundary as lifecycle and effort spawn intent.
4. Fail closed, per identity, when the exact binding is unavailable or ambiguous; continue restoring unaffected identities.
5. Keep removed-model records inspectable and their sessions/mailboxes intact.
6. Make the selected provider visible in `send_email`, `inspect_agent`, `/agents`, restore alerts, and deterministic tests.
7. Keep model-ID-only email addresses backward compatible.

## Non-goals

- encoding provider IDs into addresses in this release;
- allowing two providers to own the same exact full subagent address in one namespace;
- silently migrating/rebinding an identity to another provider;
- provider failover, load balancing, provider scoring, or automatic fallback;
- live catalog mutation without extension reload;
- rewriting historical mail addresses or session transcripts;
- changing main alias, reply-correlation, lifecycle, effort, role, or tool semantics;
- creating a general provider migration UI before a concrete user-authorized rebind requirement exists.

## Identity and routing semantics

### Existing identity

A persisted `AgentRecord` is authoritative for:

```text
address + provider + modelId + sessionFile + mailbox + effort + lifecycle
```

The address locates the identity; the record's provider/model locates its runtime model. For an existing record:

- exact provider ID must match the catalog provider;
- model ID matches case-insensitively, consistent with current address resolution;
- exactly one catalog model must match the tuple;
- main provider preference is not consulted; and
- the persisted provider/model is never overwritten merely because catalog preference changed.

If the exact tuple is absent, the record remains bound but unavailable. A same-ID candidate from another provider is evidence for the error message, not a replacement.

### New identity

For a syntactically valid address with no record:

1. find all catalog models whose ID case-insensitively matches the address model domain;
2. if there is exactly one candidate, select it;
3. otherwise filter candidates by current main provider;
4. select only when that filtered set contains exactly one candidate; and
5. fail closed for zero matches, no matching current provider, or multiple candidates under the current provider.

The selected tuple becomes durable identity state. If another local part later creates a different unknown address after main switches provider, it may bind to the other provider. Sending to the first address still reuses its original provider.

### Main identity

Main remains `main@<model-id>.com` and follows Pi's selected provider/model. A provider switch that keeps the same model ID may leave the textual main address unchanged; it must still update the provider preference for future unknown subagents.

Previous main address aliases continue to work. Main aliases identify one main thread, not separate provider-specific identities.

### Catalog change

Worker provider definitions and models are an immutable extension-start snapshot under `src/model-runtime.ts`. Configuration changes require reload.

After reload:

- same provider + same model ID uses the new catalog model object/metadata while preserving the binding;
- removed provider/model leaves the record unavailable and inspectable;
- reintroducing the exact tuple permits normal restoration on a later reload/restart;
- provider rename is treated as removal plus addition, not as proof of identity equivalence; and
- no same-ID cross-provider substitution occurs.

## Invariants

1. An existing record is looked up by canonical address **before** any new-address provider preference is applied.
2. A record's exact persisted provider/model is the only automatic restore/restart binding.
3. Startup, stopped restart, archived restoration, and ordinary reuse all call the same exact-binding resolver.
4. The current main provider affects only unknown identities and prospective `inspect_agent` results.
5. Once an `email.created` event for a new identity is durable, its provider/model binding cannot change because of a later main switch or crash.
6. Ambiguity always fails closed; candidate ordering never selects a model.
7. An unavailable binding never consumes a live worker or activation lease and never blocks unrelated records from restoring.
8. Failure preserves address, provider, model ID, session, mail, effort, lifecycle, tools/profile, and original creation time.
9. Sending to an existing unavailable identity cannot silently accept mail for or start a replacement-provider worker.
10. Email address syntax and stable email identity remain unchanged.
11. Model/provider selection uses exact structured fields, never provider-name parsing from an error or address.
12. A model switch and a concurrent new send have a single binding boundary: whichever main-provider preference is observed when the new recipient is resolved is written into that envelope's durable binding intent and cannot later drift.

## Current code grounding

### Catalog and address parsing

- `src/address.ts:14-58` — `ModelCatalog` groups models by lowercased model ID and stores one constructor-time `preferredProvider`.
- `src/address.ts:36-40` — duplicate selection succeeds only for one match under that preference.
- `src/address.ts:43-58` — `resolve()` has no separate exact persisted-binding path.
- `src/address.ts:60-102` — address shape parsing is already independent of model availability; retain this split.
- `src/address.ts:104-109` — `parseSubagentAddress()` combines syntax and catalog selection, which encourages callers to re-resolve existing identities as new.
- `test/unit/address.test.ts` — covers syntax, global ambiguity, and one preferred-provider selection, but not persisted bindings or dynamic preference.

### Broker restore and lifecycle paths

- `src/broker.ts:158-163` — broker constructs one catalog with startup `options.preferredProvider`.
- `src/broker.ts:206-233` — startup loads each record, parses its address through that catalog, then overwrites `record.provider` and `record.modelId` with the selected model.
- `src/broker.ts:238-264` — crash recovery for accepted queued mail without a registry entry resolves the address again; lifecycle and effort have durable spawn intent, but provider/model do not.
- `src/broker.ts:281-305` — only routable records receive activation leases/workers; restoration again parses the address through catalog preference.
- `src/broker.ts:532-562` — `sendInternal()` parses a non-main recipient before checking the existing record, so existing identity semantics are not primary.
- `src/broker.ts:639-694` — first mail persists lifecycle/effort intent and returns model/profile, but not recipient provider as a distinct result field.
- `src/broker.ts:716-746` — archived restoration passes the currently parsed model into worker creation.
- `src/broker.ts:749-774` — new records already persist provider and model ID.
- `src/broker.ts:782-801` — synthetic unavailable records use provider `"unavailable"`, which identifies an unbound legacy recovery case but cannot preserve a known binding by itself.
- `src/broker.ts:805-914` — worker creation receives `parsed.model`; exact binding must be settled before this point.
- `src/broker.ts:1334-1362` — explicit restart reparses the address through catalog preference.
- `src/broker.ts:1502-1545` — existing inspection already returns persisted provider/model without reparsing; prospective inspection uses catalog selection.

### Durable state and main-provider changes

- `src/types.ts:147-174` and `src/registry-store.ts:167-213` — every current registry record has required `provider` and `modelId`; these are durable bindings for historical records.
- `src/types.ts:9-34` and `src/mail-store.ts:45-113` — first mail can persist lifecycle/effort intent, but has no provider/model binding intent.
- `src/mail-store.ts:130-143` — duplicate-created-email equality must include any new binding field.
- `src/index.ts:27-33` — available models include the current model if absent from registry output.
- `src/index.ts:298-308` — startup passes `ctx.model.provider` into the broker.
- `src/index.ts:338-348` — `model_select` updates main address/aliases only; broker catalog preference remains the startup provider.
- `src/model-runtime.ts:35-68` — worker runtimes resolve an exact `providerId + modelId` from an immutable extension-start snapshot and already fail actionably when absent.
- `README.md:22-25` — current documentation says duplicate IDs are ambiguous/unroutable, which no longer fully describes HEAD's preferred-provider mitigation.

## Smallest defensible design

### 1. Split catalog APIs by intent

Remove constructor-owned preference from `ModelCatalog`. Add two explicit operations:

```ts
interface ModelBinding {
  provider: string;
  modelId: string;
}

class ModelCatalog {
  resolveNew(modelId: string, preferredProvider?: string): Model<any>;
  resolveBound(binding: ModelBinding): Model<any>;
  routableModelIds(preferredProvider?: string): string[];
}
```

Required behavior:

- `resolveNew` implements the new-identity rule and lists candidates/current preference in bounded errors;
- `resolveBound` requires exactly one provider/model tuple and never falls back by ID;
- `routableModelIds` is computed for the provider passed at call time; and
- duplicate entries even under one provider fail closed rather than selecting by array order.

Retain `parseSubagentAddressShape()` unchanged. Add focused helpers that combine a validated shape with either `resolveNew` or `resolveBound`; name them so a caller cannot accidentally use new-address semantics for restore.

Do not create a general routing-policy class.

### 2. Make broker recipient resolution existing-first

Introduce one broker helper for an existing record:

```text
shape address -> records.get(shape.address) -> exact persisted binding -> ParsedAddress
```

Use it in:

- startup record restoration;
- normal send/reuse;
- stopped restart;
- archived restoration;
- explicit `restart()`; and
- any future lifecycle reactivation.

Use new-address resolution only when no record exists.

During startup, do not assign `record.provider = parsed.model.provider` or `record.modelId = parsed.model.id` for ordinary records. Validate and preserve them. It is acceptable to canonicalize display casing only through an explicit, tested migration; the smallest release should not mutate binding strings.

### 3. Persist the selected binding in first-mail spawn intent

Add an optional field to `EmailEnvelope`:

```ts
/** Durable provider/model selected when accepting mail for a new identity. */
modelBindingIntent?: ModelBinding;
```

On the first accepted request for an unknown subagent, store:

```ts
modelBindingIntent: {
  provider: parsed.model.provider,
  modelId: parsed.model.id,
}
```

This is parallel to `lifecycleIntent` and `effortIntent` and closes the existing crash window between mail acceptance and first registry persistence.

Update `MailStore` to:

- parse/validate both non-empty fields;
- require the intent's model ID to match the address model domain case-insensitively;
- include it in duplicate `email.created` equality;
- retain it through compaction/pruning snapshots; and
- accept legacy envelopes with no binding intent.

Do not add provider to ordinary later mail or replies. The field is creation intent, not routing metadata for every envelope.

### 4. Define legacy recovery explicitly

#### Historical registry record with a real provider/model

Use the exact persisted tuple. This includes records previously marked `Model unavailable during restore` by the duplicate-ID bug. If the tuple exists now, restore it even when main starts on another provider.

#### New-format orphan queued mail with binding intent

Reconstruct the missing record from the exact intent. Startup main provider is irrelevant.

#### Legacy orphan queued mail with no record and no binding intent

The original provider is unknowable. Therefore:

- bind only if the model ID has exactly one candidate across the whole catalog;
- do **not** use current main preference for this historical accepted mail; and
- if zero or duplicate candidates exist, create/retain an unavailable record with a diagnostic that says the legacy binding is unknown and no substitution was made.

#### Legacy synthetic record with `provider: "unavailable"`

Treat it as unbound legacy recovery data, not as a real provider. It may be migrated once only when there is exactly one global candidate. Record a bounded status activity explaining the migration. With duplicates, remain unavailable.

#### Removed provider/model with a known binding

Preserve the known provider/model, session, mail, and state. Mark active states failed/unavailable as current code does; allow already archived/stopped records to retain their lifecycle state while carrying the failure diagnostic. Do not accept new mail that would imply a replacement runtime. Inspection and safe archive remain available.

If the exact tuple returns on a later extension reload, normal exact restore can recover it.

### 5. Make main-provider preference live and atomic

Store current main routing input as one broker value, for example:

```ts
{ address: string; preferredProvider?: string }
```

Replace `updateMainAddress(address)` with an operation that updates address and provider together. `src/index.ts` must pass both `makeMainAddress(event.model.id)` and `event.model.provider` on every `model_select`, even when the address string does not change.

The in-memory provider preference must be assigned synchronously before the persistence await. A concurrent new-recipient send then observes either the old or new complete preference. Once its envelope is accepted, `modelBindingIntent` makes that decision durable.

Existing record resolution never reads this preference.

`broker.modelIds` and the next main/subagent system prompt should compute routable new-address model IDs using the current provider. A switch can therefore change the prospective list without changing existing identities.

### 6. Make selected provider observable

Add an optional additive `recipientProvider` to `SendEmailResult` and show `provider/model` in the normal send result. Keep `recipientModel` for compatibility.

Required diagnostics:

- new ambiguous failure: model ID, candidate provider IDs, and current main provider;
- exact-binding unavailable: address and persisted `provider/model`, plus explicit “not rebound” language;
- legacy unbound failure: explicit statement that original provider cannot be recovered;
- restore alert: preserve the persisted provider/model in inspection and registry;
- archived restoration/send result: show original provider/model; and
- prospective `inspect_agent`: show the provider selected under current main preference without spawning.

Update prompts/docs to say:

- the model domain remains a model ID, not a provider ID;
- an unknown ambiguous model ID uses current main provider only for one unique match;
- an existing identity preserves its original provider/model; and
- catalog/provider changes require reload.

Do not expose a provider-selection override in `send_email` in this release.

## Test-first implementation phases

## Phase 0 — Freeze the routing contract in unit tests

Add failing `ModelCatalog` tests before changing production code:

1. globally unique new model resolves without preference;
2. duplicate new model resolves to exactly one candidate under current provider;
3. unmatched current provider fails;
4. no current provider fails;
5. two duplicate entries under the same current provider fail;
6. exact persisted binding resolves independently of current preference;
7. exact binding fails when only another provider has the same ID;
8. routable prospective IDs change when the passed provider changes; and
9. address shape/canonical syntax remains unchanged.

Likely files:

- `test/unit/address.test.ts`
- `src/address.ts`

Do not change broker code until these tests make “new” versus “bound” intent unambiguous.

## Phase 1 — Existing-first broker resolution

Create a focused provider-routing integration test instead of expanding unrelated hardening tests indefinitely.

Red scenarios:

- create an identity when only provider A exposes model `shared`; restart with providers A+B and startup main provider B; worker factory must receive A and registry must remain A;
- same-provider restart with A+B present restores A;
- explicit restart and archived restoration after preference changes still receive A;
- removed provider A with provider B exposing the same model ID leaves the A record unavailable and does not create a B worker;
- an unaffected B record restores in the same broker startup;
- reintroducing A on a later startup restores the original record.

Production changes:

- explicit catalog APIs;
- existing-record resolver;
- startup/send/restart/archive paths converted to it;
- dynamic broker preference and `model_select` wiring.

Likely files:

- `src/address.ts`
- `src/broker.ts`
- `src/index.ts`
- `src/types.ts`
- new `test/integration/provider-routing.test.ts`
- `test/integration/lifecycle-races.test.ts` for switch/send serialization only if the focused file cannot cover it cleanly

## Phase 2 — Durable binding intent and migration

Tests first:

- `MailStore` round-trip/compaction retains `modelBindingIntent`;
- malformed provider/model and address mismatch fail journal load clearly;
- conflicting duplicate `email.created` binding intent is rejected;
- crash recovery without registry uses exact binding intent despite a different startup provider;
- legacy no-intent orphan succeeds only with one global candidate;
- legacy no-intent orphan with duplicates fails closed;
- historical `provider: "unavailable"` migrates only with one global candidate;
- a known removed provider remains named in registry/inspection and is never rewritten to `"unavailable"` or another provider.

Likely files:

- `src/types.ts`
- `src/mail-store.ts`
- `src/broker.ts`
- `test/unit/mail-store.test.ts`
- `test/integration/initial-effort.test.ts` or a new provider-routing integration file, keeping effort/lifecycle/binding crash intent covered together
- `test/integration/hardening.test.ts` for quarantine coexistence if not moved to the focused file

Registry version should remain 1 because existing records already require provider/model and the envelope field is optional.

## Phase 3 — Observability and documentation

Add `recipientProvider` and update existing render/tool/docs surfaces.

Likely files:

- `src/types.ts`
- `src/broker.ts`
- `src/sdk-worker.ts`
- `src/index.ts`
- `src/main-tools.ts` only if inspection wording needs a distinct bound/prospective label
- `src/prompts.ts`
- `README.md`
- `docs/README.md`
- `docs/send-email.md`
- `docs/inspect-agent.md`
- `docs/manage-agent.md`
- `docs/configuration.md`
- `CHANGELOG.md`
- `test/integration/main-tools.test.ts`
- `test/e2e/extension-load.test.ts`
- `test/unit/prompts.test.ts`

Required wording must not say every duplicate is globally unroutable; it must state the new/existing distinction.

## Phase 4 — Deterministic real-Pi RPC proof

Use real `pi --mode rpc`, the real extension/broker/SDK worker/session stores, and deterministic in-process providers. Do not call paid or external providers.

Add two mock providers, `mock-alpha` and `mock-beta`, exposing the same model ID and scripted stream behavior. Extend the RPC helper with a typed `set_model` command only if needed.

### Scenario A — duplicate, archive, switch, and restore

1. Start main on `mock-alpha/shared` with both providers registered.
2. Send to a new address and assert `recipientProvider === "mock-alpha"`.
3. Complete and archive that identity.
4. Switch main via RPC `set_model` to `mock-beta/shared`; the main email address may remain textually unchanged.
5. Send to a different unknown local address and assert it binds `mock-beta`.
6. Send to the archived alpha address and assert it restores `mock-alpha`, not beta.
7. Inspect registry, journal `modelBindingIntent`, send results, and worker session model-change/header data structurally.

### Scenario B — process restart on another main provider

1. Persist a main session and alpha-bound agent.
2. Relaunch/resume the same namespace with main on beta while both providers expose `shared`.
3. Wait for broker restoration and assert the existing worker runtime/provider remains alpha.
4. Create a new address and assert beta.
5. Verify exactly one durable identity record per full address and no provider overwrite.

### Scenario C — provider removed and later returned

1. Persist one alpha-bound and one beta-bound identity.
2. Relaunch with only beta registered.
3. Assert beta restores; alpha remains inspectable/unavailable with persisted `mock-alpha/shared`, no activation lease/worker, no cross-provider substitution, and an actionable alert.
4. Assert restart or archived send to alpha fails before mail acceptance rather than binding beta.
5. Relaunch with alpha restored and assert the same alpha record/session can restore.

### Scenario D — crash window before registry persistence

1. Persist an `email.created` for an unknown alpha-bound identity with `modelBindingIntent`, but omit/delete the derived registry record in the temporary fixture.
2. Relaunch with main on beta and both providers present.
3. Assert orphan recovery reconstructs alpha from the mail intent.
4. Repeat with a legacy no-intent envelope: unique global catalog succeeds; duplicate catalog remains unavailable.

Parse every RPC line, mail event, registry object, and session entry as JSON. Select by stable session/mail/address IDs. Do not derive counts with grep.

Likely files:

- new `test/e2e/helpers/duplicate-model-provider-extension.ts`, or a minimal extension of `test/e2e/helpers/mock-provider-extension.ts`
- new `test/e2e/provider-routing.test.ts` to keep this matrix focused
- `test/e2e/helpers/rpc-client.ts`
- reuse helpers from `test/e2e/real-flow.test.ts` rather than copy parsers where practical

## Deterministic validation matrix

| Identity/catalog condition | Main preference | Expected provider/result |
|---|---|---|
| new, one global candidate A | none/B | A |
| new, candidates A+B | A | A, only if one A candidate |
| new, candidates A+B | B | B, only if one B candidate |
| new, candidates A+B | C/none | fail ambiguous, no mail accepted |
| new, two A candidates | A | fail ambiguous, no array-order choice |
| existing bound A, candidates A+B | A | A |
| existing bound A, candidates A+B | B | A |
| existing bound A, only B remains | B | unavailable A; never B |
| existing bound A, no candidates | any | unavailable A |
| stopped existing A after switch to B | B | restart A |
| archived existing A after switch to B | B | restore A |
| new different address after switch A→B | B | B |
| same model ID/provider switch leaves main address unchanged | B | future unknown resolves with B |
| new-format orphan intent A, candidates A+B | B | reconstruct A |
| legacy orphan, one global A | B | migrate/bind A |
| legacy orphan, candidates A+B | B | unavailable; do not guess |
| historical failed record persisted A, candidates A+B | B | restore A if exact tuple exists |
| exact provider A returned after removal | any | original A record/session restorable |
| provider/model strings disagree with address | any | fail closed with corruption/binding diagnostic |

## Races requiring explicit tests

### Model switch versus new send

Update `{mainAddress, preferredProvider}` as one in-memory value before awaiting registry persistence. A concurrent new-recipient send may bind under the old or new preference depending on event ordering, but its accepted envelope must contain that exact chosen binding. It must never resolve under one provider and construct the worker under another.

Use deferred barriers around mail acceptance and `updateMainModel()` to prove both orderings.

### Existing send versus archive/restart

Continue using `withAddressOperation(address, ...)`. Existing-record exact resolution and worker replacement must occur under the same address serialization used today. A concurrent send cannot create a second identity or change the binding.

### Startup restore versus shutdown

Retain lifecycle generation checks. If exact-bound worker creation completes after shutdown starts, dispose it; do not mutate the persisted binding or install the worker.

### Catalog snapshot versus model switch

A model switch changes only the preferred provider among models already in the extension-start catalog. If the selected provider/model is absent from `WorkerRuntimeFactory`'s snapshot, new worker creation fails actionably and requires reload. Do not mutate the runtime catalog in place.

## Acceptance and release gates

Release only when all of the following hold:

- every existing record restores/restarts from its exact persisted provider/model;
- startup no longer overwrites provider/model based on main preference;
- a new ambiguous address uses current main provider only for exactly one match;
- `model_select` changes the future new-address preference even when main address text is unchanged;
- first accepted mail for a new identity durably stores provider/model binding intent;
- crash recovery uses that intent and legacy ambiguous orphan state fails closed;
- removed provider/model records remain inspectable, retain their original binding/session/mail, consume no worker/lease, and do not block valid restoration;
- archived and stopped identities preserve provider across main switching;
- send/inspect/UI results identify provider/model explicitly;
- address syntax, stable mail IDs, reply correlation, effort, lifecycle, and at-least-once semantics are unchanged;
- the complete required live/deterministic matrix (same-provider restore, duplicates, removal, archived restore, and mid-session switch) passes in real Pi RPC without external providers; and
- typecheck, targeted/full tests, package smoke, license, and secret gates pass from a clean baseline.

Validation commands for implementation:

```bash
npm run check
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:package
npm run check:licenses
npm run check:secrets
```

Capture the complete first-run output of every suite in durable artifacts. On failure, inspect the runner's structured/bounded failure section; do not rerun just to learn which test failed.

## Observability and diagnostics

### Send result

```text
Recipient model: mock-alpha/shared
Binding: persisted for this identity
```

### Existing unavailable identity

```text
worker.audit@shared.com is bound to mock-alpha/shared, which is absent from the current catalog.
The identity was not rebound to mock-beta/shared. Restore the provider/model configuration and reload.
```

### New ambiguous address

```text
Model ID "shared" has candidates mock-alpha/shared and mock-beta/shared.
Current main provider "mock-gamma" does not identify exactly one candidate; no email was accepted.
```

### Legacy orphan

```text
Accepted legacy mail has no durable provider binding and "shared" is now ambiguous.
The original provider cannot be inferred; the identity remains unavailable and no substitution was made.
```

Diagnostics must distinguish:

- `bound existing`;
- `selected new via unique global candidate`;
- `selected new via current main provider`;
- `legacy uniquely migrated`; and
- `unavailable/fail closed`.

Do not log credentials, auth source, raw model objects, or provider configuration bodies.

## Compatibility and migration impact

### Address compatibility

No syntax change. Existing addresses, configuration keys, prompts, main aliases, and reply subjects remain valid. The semantic clarification is that the address locates one persistent identity, whose provider binding is stored outside the address.

### Registry compatibility

Registry version stays 1. Current and historical valid records already require `provider` and `modelId`. The implementation changes how those fields are honored, not their schema.

Previously broken duplicate-ID records should recover automatically when their persisted exact tuple is present. Removed exact tuples remain safely unavailable.

### Mail-journal compatibility

`modelBindingIntent` is optional. Old journals load without it. New first-mail events include it and duplicate-event equality validates it. Older extension versions ignore unknown JSON object fields when reading only if their parser permits them; package rollback compatibility must be checked. If the current older parser reconstructs a typed object by whitelisting fields, it will drop the intent rather than corrupt the journal, but rollback during the crash window can lose provider-preservation behavior. Document this rollout limitation.

### Catalog changes

- same tuple, changed metadata: compatible after reload;
- model/provider removed: preserved unavailable identity;
- provider renamed: no automatic migration;
- duplicate introduced: existing exact bindings continue; new identities use current-provider uniqueness;
- duplicate removed: exact bindings continue; new unique resolution becomes straightforward.

### API compatibility

`recipientProvider` is optional/additive. Keep `recipientModel` unchanged. No new `send_email` argument is added.

## Risks

1. **Silent rebind through one missed call site** — inventory every `parseSubagentAddress(...)` caller and require existing/new intent in its name/test.
2. **Crash gap remains elsewhere** — binding intent must be written in the same `email.created` transaction as lifecycle/effort intent, before worker creation.
3. **Historical bad provider data** — fail per record with a bounded diagnostic; do not fail whole broker startup or rewrite it by model ID.
4. **Provider preference stale after switch** — test same-model-ID switches where the main address string does not change.
5. **Two candidates under one provider** — require exactly one tuple; never rely on registry order.
6. **Accepted mail to unavailable existing identity** — reject before acceptance unless an exact bound worker can be created or the existing stopped semantics intentionally queue for a known available binding. Never queue against a replacement provider.
7. **Activation-lease leak** — unavailable records must be excluded before lease acquisition and release any provisional lease on failed exact resolution.
8. **Runtime/catalog mismatch** — `availableModels(ctx)` and `WorkerRuntimeFactory` must agree on the selected exact tuple; retain actionable reload errors.
9. **Rollback after new intent fields** — verify old package behavior against a journal containing the optional field and document the safe downgrade boundary.
10. **Prompt confusion** — model IDs remain the only address domain. Documentation must not ask models to invent provider-qualified domains.

## Rollout

1. Land pure catalog contract tests and explicit APIs.
2. Land existing-first restore/restart behavior and integration matrix.
3. Land durable binding intent and legacy migration tests.
4. Land live `model_select` preference plus race tests.
5. Land provider observability and documentation.
6. Run deterministic real-Pi RPC scenarios before any live provider canary.
7. Release with a note that historical duplicate-ID failures can restore only when their persisted exact provider/model is available.
8. After release, analyze structured restore outcomes by `bound/selected/migrated/unavailable`, not by matching alert text.

Rollback is safe only after verifying how the previous package parser handles `modelBindingIntent`. Do not roll back across an unregistered-identity crash window without preserving the new journal or first materializing registry records.

## Rejected overengineering

### Provider-qualified email domains

Rejected as the first move. It would change address syntax, configuration keys, main aliases, reply targets, prompts, and historical identity lookup. Durable records already contain provider/model, so explicit routing intent fixes the known bug more directly.

### A provider suffix, plus-address tag, or second `@` component

Rejected for the same compatibility reasons and because it creates parallel canonicalization/migration rules without evidence they are needed.

### Silent same-ID cross-provider fallback

Rejected. Provider changes can alter auth, API semantics, context compatibility, tool behavior, cost, and output. Same model ID is not proof of interchangeable identity.

### Provider alias/rename heuristics

Rejected. Names, base URLs, APIs, and model IDs are not reliable identity equivalence. A future explicit operator-authorized migration can be designed if real provider renames require it.

### Rebuilding worker runtimes on every main switch

Rejected. Existing workers must preserve their provider/session; the switch affects only main and future unknown identities. Provider definitions remain an extension-start snapshot.

### Versioning the registry solely for this fix

Rejected. Provider/model are already required record fields. The only new durable field is optional mail creation intent.

### Storing provider on every envelope

Rejected. Later mail targets an existing address/record and must not override its binding. Store provider/model only on first-mail creation intent.

### A general routing-policy engine

Rejected. Two explicit catalog methods and existing-first broker resolution cover the required semantics with less state and fewer call paths.

### Hashing model objects or provider configurations

Rejected. Exact provider/model strings and stable record/mail identities are sufficient; hashes add migration and mismatch behavior without a requirement.

## Implementation result (2026-08-23)

Implemented the smallest design described above:

- `ModelCatalog` now separates prospective `resolveNew`, exact `resolveBound`, and global-unique legacy recovery; provider preference is passed at call time.
- Broker routing is existing-first across startup, ordinary send/reuse, stopped restart, archived restoration, explicit restart, and late cleanup replacement. Persisted real provider/model strings are no longer overwritten by main preference.
- The first accepted request for a new identity journals optional `modelBindingIntent` in the same `email.created` event as effort/lifecycle intent. Parsing, address consistency, duplicate equality, compaction, and crash recovery are covered.
- Legacy orphan mail and historical synthetic `provider: "unavailable"` records migrate only with one global candidate. Known removed bindings remain named and unavailable, consume no ordinary worker/lease, reject send/restart before acceptance, and recover when the exact tuple returns.
- Main address/provider preference is replaced synchronously as one broker value before registry persistence, including same-model-ID switches whose main address text does not change. Accepted mail retains the exact choice through its binding intent.
- Send results add optional `recipientProvider`; inspect, tool text, renderer, prompts, and `/agents` Profile distinguish prospective selection, persisted binding, and unavailable/no-substitution state without provider-qualified addresses or override arguments.
- Deterministic real Pi RPC providers `mock-alpha/shared` and `mock-beta/shared` prove new alpha/beta selection, same-ID switch, archive/reuse, exact process-start resume, removal/reintroduction, pre-accept unavailable rejection, crash-window intent recovery, ambiguous legacy failure, and unique legacy migration. Registry, mail, RPC, and session artifacts are parsed structurally by stable address/mail/session fields.
- The preceding package parser was directly checked: it ignores the optional unknown field in memory and leaves the raw journal intact until old-package compaction, which drops it. Documentation therefore forbids downgrade across an unregistered-identity crash window without first materializing the registry or preserving the new journal.

No provider-qualified address, provider override argument, silent failover, routing policy framework, live catalog mutation, provider rename heuristic, extension-owned retry, or persistent routing ledger was added. Historical audit counts were not recomputed and no improvement rate is claimed.

## Planning-time validation boundary

No source/test files were changed, and no repository tests, real Pi RPC runs, provider calls, package builds, or TUI checks were performed while writing the original plan. The historical count comes from the cited parsed audit artifact. HEAD mitigation and remaining gaps were established by code inspection at that planning cutoff. The implementation result above is supported by the later deterministic release artifacts, not by the original planning audit.
