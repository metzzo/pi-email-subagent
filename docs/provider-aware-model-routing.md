# Provider-aware durable model routing

Email addresses keep the compatible form `<name>.<task-slug>@<model-id>.com`. The domain is a **model ID**, not a provider ID. Provider identity is stored as a durable `provider + modelId` binding outside the address.

## New and existing identities

The broker deliberately uses different rules for prospective and durable identities.

### Unknown address

For an address with no record or accepted creation intent:

1. one global catalog candidate is selected directly;
2. with duplicate model IDs, the current main provider must identify exactly one candidate;
3. no current-provider match, no preference, or multiple matches under that provider fails before mail acceptance; and
4. catalog array order is never a tie-breaker.

The normal `send_email` result reports `Recipient model: <provider>/<model-id>` and `Binding: persisted for this identity`. `inspect_agent` can preview the prospective selection without spawning.

### Existing address

The registry record's exact persisted provider/model is authoritative. Startup restore, ordinary reuse, stopped restart, archived restoration, and explicit restart all resolve that exact tuple. Main's current provider is not consulted and a same-ID model from another provider is never substituted.

A provider switch may keep the textual main address unchanged when the model ID is the same. The broker still updates its main address/provider preference as one in-memory value before persistence, so later unknown recipients use the new provider. Already accepted and existing identities keep their binding.

## Durable acceptance and crash recovery

The first accepted request for a new identity stores optional `modelBindingIntent` in the same `email.created` journal event as initial effort and lifecycle intent:

```json
{
  "modelBindingIntent": {
    "provider": "mock-alpha",
    "modelId": "shared"
  }
}
```

The journal parser validates non-empty fields and requires the intent model ID to match the recipient address domain case-insensitively. Duplicate `email.created` equality includes the exact binding, and compaction retains it. Later mail and replies do not carry a new binding intent.

If a crash leaves accepted queued mail but no registry record:

- a new-format intent reconstructs its exact provider/model even when main now uses another provider;
- legacy mail with no intent binds only when the model ID has one global candidate;
- legacy mail with zero or duplicate candidates remains unavailable because its original provider cannot be inferred; and
- a historical synthetic `provider: "unavailable"` record is migrated only under the same one-global-candidate rule.

Legacy migration adds a bounded status Activity item. It never uses current main preference.

## Removed or changed catalog entries

Provider definitions and the worker model catalog are an extension-start snapshot. Configuration changes require reload.

When an existing exact tuple is absent:

- its original address, provider, model ID, session file, mailbox, effort, lifecycle, tools/profile, and creation time remain inspectable;
- active/restorable state becomes failed/unavailable, while stopped or archived lifecycle state is preserved;
- no worker or ordinary activation lease is created (a pre-existing cleanup quarantine still retains its safety ownership);
- ordinary mail to the known failed identity is accepted and queued under its stable ID without catalog re-resolution, while explicit restart fails until the exact tuple returns; and
- diagnostics name the persisted binding and explicitly say it was not rebound.

Unrelated valid records continue restoring. Reintroducing the exact provider/model on a later process start makes explicit same-identity restart available, but does not automatically create a worker from the failed state; queued mail stays queued until that operator action. Provider rename is removal plus addition; there is no automatic alias or migration.

## Credential-source and compatibility readiness

**0.1 decision:** do not further delegate this boundary to Pi 0.84.2. Pi already owns catalog loading, provider registration, auth storage, and public availability. The extension keeps only the exact persisted binding, isolated worker-runtime preparation, post-registration availability, credential-source equivalence, and non-secret request-model comparison. Removing that comparison would permit a same-ID provider/runtime drift that the host exposes no durable receipt for, weakening the no-silent-substitution guarantee. Revisit only when Pi exposes an exact persisted binding plus isolated-runtime provenance/availability contract.

Provider/model presence alone is insufficient. Before `email.created`, the worker factory prepares one exact isolated runtime, compares its model, and passes a detached, deeply frozen model clone to worker execution without freezing provider/runtime-owned catalog data. It compares every non-secret request-affecting model field: API, base URL, reasoning/thinking map, inputs, costs, context/output limits, nested sampling parameters, and complete compatibility metadata.

Supported credential-source equivalence is deliberately narrow: matching `stored` through the same explicit auth path, matching `environment` with the same non-secret source context/process, and matching non-command `models_json_key` through the same models path. Runtime overrides, models-JSON commands, provider fallback, mismatches, and indeterminate/unconfigured status fail closed. Header-bearing models also fail closed: Pi 0.84.2 does not expose provenance that can prove a resolved header is static and non-secret. Header-bearing models and dynamic catalog (refresh) registrations fail closed: Pi 0.84.2 does not expose provenance that can prove a resolved header is static and non-secret. Configured-provider OAuth login/refresh configuration is supported: the isolated worker runtime is created in the same process with the same `auth.json` path, provider closures stay valid, and the post-registration availability and credential-source-equivalence checks below are the gates. Request-mutating main-extension hooks (`before_provider_headers`/`before_provider_request`) are not captured for any route. A native public provider with provider-wide headers, OAuth, refresh hooks, or filter hooks is rejected before worker runtime creation/registration. Demonstrably static registrations reuse the same public provider object/config; after registration, public `getAvailable(providerId)` performs the availability/auth check and must contain the exact provider/model before readiness. It is not treated as a receipt for an exact internal refresh Promise. No secret value or fingerprint is resolved, compared, copied, transferred, or logged.

For a new identity the runtime/auth/model-compatibility preflight occurs before `email.created`, so deterministic incompatibility creates no obligation. Ordinary mail to a known failed identity intentionally performs no catalog/auth readiness and queues under the persisted identity. Explicit restart performs readiness. If an archived/paused identity's post-accept creation detects a readiness change, the accepted ID remains queued and the record keeps a bounded failure; there is no rebind or provider switch. All definition, source-class, and compatibility corrections require extension reload.

## Observability and privacy

- `send_email`: additive `recipientProvider` beside compatible `recipientModel`, and normal text renders `provider/model`.
- `inspect_agent`: labels an existing binding as persisted, a new selection as prospective, and an absent exact tuple as unavailable/no substitution.
- `/agents`: list headers retain provider/model; Profile states that the binding is preserved across main-provider changes or unavailable without substitution.
- startup alerts and failures use bounded provider/model candidate diagnostics.

These surfaces do not include model objects, credential material, credential labels, provider configuration bodies, mail bodies, subjects, or unrelated identities. Readiness failures may name only the provider and non-secret source class.

## Rollback boundary

The envelope field is optional, so old journals still load in the new package and registry version remains 1. The preceding package parser was verified to ignore the unknown `modelBindingIntent` in memory. It leaves the raw event intact until it rewrites/compacts the journal; an old-package compaction drops the unknown field.

Therefore do not downgrade across an accepted-but-not-yet-registered identity crash window. First allow the new package to materialize the registry record, or preserve the new journal without old-package compaction. Ordinary established registry records already contain provider/model and remain compatible.

## Scope and evidence boundary

The deterministic catalog-routing suite uses real Pi 0.84.2 RPC processes and controlled provider metadata. Controlled self-contained extension providers exercise worker spawning only after the public readiness join. Dynamic hook-dependent registrations remain unsupported; built-in/model-file routes cover exact snapshot drift and auth-source gates without external provider calls.

This does not establish live catalog mutation, provider equivalence, provider rename safety, external credential availability, or compatibility with Pi versions other than the tested one. Historical restore counts remain audit evidence, not a measured post-release improvement.
