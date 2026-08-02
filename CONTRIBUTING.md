# Contributing

Thanks for improving `pi-email-subagent`.

## Development setup

Requirements:

- Node.js 22.19.0 or newer
- npm
- Pi-compatible provider credentials only for optional live acceptance

```bash
git clone https://github.com/metzzo/pi-email-subagent.git
cd pi-email-subagent
npm ci
npm run validate
```

`npm run validate` runs TypeScript checking, the production dependency-license policy, all deterministic unit/integration/real-RPC E2E tests, and a clean packed-artifact install/load smoke. Required tests use a scripted mock provider and do not incur model charges.

Useful focused commands:

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:package
```

Optional paid-provider acceptance:

```bash
LIVE_MODEL=openai-codex/gpt-5.6-terra \
LIVE_EMAIL_MODEL=k3 \
LIVE_EXTENSIONS=pi-provider-kimi-code \
npm run test:live
```

## Change expectations

- Add a regression test for every defect.
- Preserve mail durability invariants and stable IDs.
- Keep required CI deterministic and provider-cost-free.
- Bound model/tool output and escape peer-controlled framing.
- Treat worker cleanup, shutdown, reload, and crash recovery as first-class paths.
- Update public docs and `CHANGELOG.md` when behavior or configuration changes.
- Keep commits focused and use clear imperative commit messages.

Before opening a pull request:

```bash
npm run validate
npm audit --omit=dev --omit=peer
npm run check:secrets # requires Gitleaks 8.30.1
git diff --check
```

## Pull requests

Describe:

1. The user-visible problem and intended contract.
2. Important design or persistence implications.
3. Tests added and commands run.
4. Compatibility, security, migration, and documentation effects.
5. Whether optional live acceptance was run.

Do not include credentials, raw private mailbox state, hidden model reasoning, or paid-provider recordings containing sensitive data. See [`docs/release-security-checks.md`](docs/release-security-checks.md) for the secret and dependency-license policies.

## Security issues

Do not open public exploit reports. Follow `SECURITY.md`.
