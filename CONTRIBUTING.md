# Contributing to Axion Designer

Thank you for helping improve Axion Designer. Contributions should preserve the separation between creative direction and deterministic proof: the Codex skill may guide design work, while blocking decisions must remain reproducible in code.

## Development setup

Requirements: Node.js 18 or newer.

```bash
npm ci
node bin/dk.mjs --help
npm test
npm run test:p0
```

To run the optional accessibility and visual checks locally:

```bash
npx playwright install chromium
node bin/dk.mjs verify --full
```

## Before opening a pull request

Run:

```bash
npm test
npm run test:p0
npm run check:package
npm pack --dry-run
```

Also verify the path you changed:

- CLI behavior: include a passing case, a failing case, and the expected exit code.
- Rule changes: include a true positive and a nearby valid example that must remain allowed.
- Direction or Taste Lock: cover contract validity, semantic bindings, intended drift, and non-drift content changes.
- Heavy gates: exercise the real adapter when its optional dependency is present, and the explicit incomplete state when it is absent.
- Public copy: keep claims reproducible and update both README languages when user-facing behavior changes.

Do not weaken a gate, ignore an error, or broaden an autofix only to make a test pass. Mechanical fixes must remain exact and reversible; creative decisions belong to the user and the design workflow.

## Adding a rule

Prefer declarative rules when possible:

```js
{
  id: 'brand/no-glow-shadow',
  zone: 'style',
  pattern: 'filter:\\s*drop-shadow',
  severity: 'warn',
  message: 'Glow shadows are outside this product direction',
  hint: 'Use var(--shadow-card)',
}
```

A rule proposal must include:

1. a stable rule id;
2. the narrowest valid zone and pattern;
3. a useful message and one concrete repair hint;
4. a fixture that must be caught;
5. a similar, intentional use that must remain allowed;
6. an end-to-end assertion against the public CLI surface.

Existing rules and their user-facing contracts are documented in [docs/rules.md](docs/rules.md).

## Pull request scope

- Keep unrelated changes separate.
- Do not commit `.dk/`, `node_modules/`, Playwright operation logs, local reports, or OS metadata.
- Do not include personal contact details, credentials, absolute local paths, or generated account identity.
- Preserve the stable exit-code contract: `0` pass, `1` policy finding, `2` usage or configuration error.
- Update [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## Release identity

Repository, issue-tracker, action, and homepage URLs intentionally remain unset until the public account exists. `npm run check:release-identity` must stay red while placeholders remain. Maintainers should set those values once, verify the resulting URLs, configure repository-local Git identity, and only then create the first public commit and release tag.

Security reports must follow [SECURITY.md](SECURITY.md), not a public issue.
