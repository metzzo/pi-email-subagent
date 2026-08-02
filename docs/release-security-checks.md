# Release security checks

Required CI complements tests and `npm audit` with two independent policies.

## Secret scanning

The `Secret scan` job runs the open-source Gitleaks 8.30.1 CLI with its default rules over the complete checked-out Git history. CI downloads the version-pinned Linux archive over TLS and verifies its pinned SHA-256 before execution. Findings are redacted and are never uploaded as artifacts. The repository policy is intentionally minimal:

```toml
[extend]
useDefault = true
```

Do not add broad path or rule exclusions. If a deterministic fixture resembles a credential, prefer changing the fixture. A narrow allowlist must identify the exact fixture/rule, explain why it cannot be mistaken for a usable credential, and receive security review.

To run the same policy locally, install [Gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1 and run:

```bash
npm run check:secrets
```

This check reduces accidental commits; it cannot prove that no secret exists. Never commit provider credentials, `.pi` state, session transcripts, mailbox journals, npm tokens, or private keys. Rotate a real credential immediately even if it is later removed from Git history.

## Production dependency licenses

`npm run check:licenses` reads the npm v3 lockfile and fails closed when a shipped production dependency:

- has no package name, version, or SPDX license;
- uses a license or compound expression that has not been explicitly reviewed; or
- cannot be classified from the lockfile.

The current allowlist is `0BSD`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, and `MIT`. GPL-family, AGPL, SSPL, unknown, custom, and compound expressions are not silently accepted. A dependency update that changes licensing must be reviewed before amending the allowlist.

Development-only packages and Pi peer dependencies are excluded from the shipped-production inventory. Pi peers are supplied by the host rather than bundled by this package; their compatibility remains covered by the declared/tested Pi support policy.

CI creates `production-dependency-licenses.json` and uploads it as a short-retention workflow artifact. Generate the same inventory locally with:

```bash
npm run check:licenses -- --output /tmp/production-dependency-licenses.json
```

The report records the policy and every shipped package name, version, license, and lockfile path. It contains no source files or credentials.

## Supply-chain maintenance

Third-party GitHub Actions are pinned to full commit SHAs, with a version comment for Dependabot. Downloaded security binaries are pinned by both version and digest. Review updates like code changes: confirm upstream tag-to-commit or artifact-to-digest associations, permissions, runtime, license, and release notes before merging.
