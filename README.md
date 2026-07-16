English · [繁體中文](README.zh-TW.md)

# Axion Designer

> Create boldly. Prove mechanically. Preserve identity.

`Axion Designer` is an agent-native, project-scoped system for building distinctive, production-ready UI without losing the chosen visual direction as the code evolves. The `dk-design` skill is explicit-only and ships for two hosts: Codex CLI or the Codex desktop app uses it only when the prompt names `$dk-design`, and Claude Code (CLI or the desktop app) uses it only when the user invokes `/dk-design`.

Its core combines four capability layers:

- **`$dk-design`** gives Codex an art-direction workflow: understand the product, explore when necessary, implement in the existing stack, inspect real pixels, and refine the highest-impact gaps.
- **`dk` CLI + `dk codex` / `dk claude`** turn the approved direction into a portable contract, verify the implementation, install or inspect the skill inside one repository, and print project-bound context and MCP launch specifications without changing Codex or Claude user settings.
- **Design Intelligence** converts a plain-language brief into three deterministic, materially different direction recipes across product, layout, type, color, motion, charts, icons, and UX without calling a model or network service.
- **Reference → Code** turns one to five authorized screenshots into a digest-linked decomposition, component map, reconstruction plan, source-fresh comparison, App Proof capture attestation, and scoped repair loop instead of treating screenshot cloning as one opaque prompt.

**Axion Bridge** extends that same evidence model across the tools a real team already uses. It normalizes evidence from Storybook, Figma, previews, GitHub Actions, Chromatic, and generic JSON artifacts, applies repository/commit policy whenever the current Git or CI identity is resolvable, stores the result in a hash-chained ledger, and can explicitly publish redacted results to GitHub Checks or an allowlisted webhook. External evidence can support a review; it can never approve Taste Lock or a visual baseline.

The creative layer decides what the interface should feel like. The verification layer proves that the implementation still belongs to that decision.

## Why use it

Most AI UI workflows end after code generation. `Axion Designer` continues through review and maintenance:

1. **Direction before decoration** — Codex starts from the product, audience, task, constraints, hierarchy, and responsive priorities instead of choosing fashionable colors at random.
2. **Real implementation, not a detached mockup** — it works inside the current frontend stack, reuses existing components, and reviews rendered desktop and mobile output.
3. **Taste that survives later edits** — Taste Lock records the approved identity and its semantic token bindings. Content can grow normally; silent changes to the visual identity become reviewable findings.
4. **Evidence instead of an AI beauty score** — token structure, contrast, source drift, accessibility, and screenshots are checked by code. Subjective critique stays advisory.
5. **A reconstructable path from reference to maintainable code** — provenance, license scope, regions, real components, planned files, browser-attested pixels, and the largest remaining deltas stay linked and mechanically reviewable. A copied image can be reviewed but cannot become complete.

## See the proof

Run `npm run demo` to reproduce the CLI proof in a temporary workspace. It introduces one exact token violation, captures the failing reports, applies the SSOT-backed repair, and proves the source returns byte-for-byte to a passing state. The evidence bundle is written to `output/market-demo/`.

## Local quick start

There are three dependency layers:

1. **Project-scoped Codex skill** — `dk codex init` copies the matching `$dk-design` bundle only to `.agents/skills/dk-design` in the current repository. It never writes Codex user configuration, a personal marketplace, or a plugin cache.
2. **Core CLI** — `dk verify` and the contract, direction, SSOT, and source gates require Node.js `>=18.14.1` with zero runtime npm dependencies.
3. **Full gates** — install the five optional packages and Chromium in the target frontend repository:

```bash
npm i -D stylelint stylelint-declaration-strict-value@1.10.6 postcss-html @playwright/test @axe-core/playwright
npx playwright install chromium
```

When developing from this repository before the public installation source exists, call the repository runtime directly:

```bash
# From this repository
node bin/dk.mjs --help
node bin/dk.mjs codex status
node bin/dk.mjs codex context
node bin/dk.mjs codex prompt auto

# Start a new governed UI workspace without a global link
node bin/dk.mjs new my-interface
cd my-interface
npm i -D /absolute/path/to/axion-designer
npx --no-install dk codex init
npx --no-install dk design init
```

For an existing target repository, add this source checkout as a project-local development dependency with `npm i -D /absolute/path/to/axion-designer`, run `npx --no-install dk codex init`, then confirm `npx --no-install dk codex status` reports `ready`. Keeping the runtime in the target repository lets the copied skill preflight resolve the matching package. Open that repository in Codex CLI or the Codex app and invoke the skill explicitly:

```text
Use $dk-design to design this product interface, inspect the rendered desktop
and mobile result, fix the largest visual gaps, and prove it still belongs.
```

`dk codex prompt auto|explore|refine|reconstruct|reimagine|verify` emits a ready-to-paste prompt that always names `$dk-design`. `dk codex context [--json] [--trust-project-config]` returns a bounded, source-backed view of routes, components, direction, reports, App Proof, Reference evidence, authority, and the narrowest next commands. An incomplete valid reference chain routes to `reconstruct`; invalid reference evidence routes to `verify`. Its safe default never executes `dk.config.mjs` or `dk.config.js`; use `--trust-project-config` only after reviewing and trusting the repository when executable project policy is required. `dk codex mcp --json` only prints a launch specification bound to the current repository; it does not edit configuration or start a daemon.

`dk codex init` records the package version plus skill and runtime SHA-256 digests in `.agents/skills/dk-design/.axion-install.json`. `dk codex status` verifies that the copied skill, project-local runtime, and install receipt still agree; a missing or mismatched receipt never becomes `ready`. Context also labels the latest verification report as `current`, `stale`, or `historical`: current evidence matches the repository state, stale evidence has a detected runtime/config/source/token/direction change, and historical evidence is retained but cannot be compared authoritatively, for example because config is untrusted, the run was partial or legacy, or required hashes are unavailable. A previously green stale or historical report is not current proof; rerun `dk verify`.

The isolation contract is fail-closed:

- `agents/openai.yaml` sets `allow_implicit_invocation: false`;
- `dk codex init` writes only `.agents/skills/dk-design`, never overwrites a stale or customized installation, and is idempotent when the exact bundle is already present;
- no command writes `~/.codex`, `~/.agents`, a Codex plugin cache, or a personal marketplace;
- no `npm link`, global package install, global MCP registration, or global plugin installation is required;
- repositories outside this project and Codex tasks that do not explicitly invoke `$dk-design` are unaffected.

The remaining examples use `dk` for readability. Inside the Axion source repository, use `node bin/dk.mjs`; inside another target repository, use its project-local binary such as `npx --no-install dk`.

Then review and lock the result:

```bash
dk design check
dk verify
dk verify --full --require-gates
dk design lock --accept --actor "Design Lead" --reason "Reviewed responsive UI and proof evidence"
```

This repository also contains a locally valid plugin artifact. Its bundled skill is still explicit-only and can act only on the target repository deliberately supplied for that invocation; its bundled Plugin MCP is deliberately stateless and exposes only offline Intelligence. Project evidence and writes stay behind the root-bound Project MCP or project-local CLI. Nothing has been installed or published, and `check:release-identity` intentionally prevents a release while public repository URLs are still placeholders.

See [Local quick start](docs/quickstart-local.md) for the project-local workflow, and [P3 Codex design engine](docs/p3-codex-design-engine.zh-TW.md) for Intelligence and Reference → Code.

## How the workflow behaves

```text
Route → Shape when needed → Build → See → Prove → Preserve
```

- **Route** — refine a matched design, explore a new product, reconstruct an authorized reference, reimagine an explicit redesign, or verify an existing implementation.
- **Shape when needed** — when visual uncertainty is material, compare three complete concepts using the same real content. Narrow tasks do not trigger unsolicited redesigns.
- **Build** — implement the selected direction with semantic tokens, real states, responsive priorities, and one recognizable signature.
- **See** — inspect rendered pixels and correct the one to three gaps that most weaken hierarchy, identity, or usability.
- **Prove** — run deterministic checks over the direction contract, token SSOT, source, accessibility, and screenshots.
- **Preserve** — accept Taste Lock after review; future edits keep the identity unless a redesign is deliberate.

## Start at your level

| You are | What you do | What Axion Designer contributes |
|---|---|---|
| New to design | Describe the product, who uses it, and the main action. Ask `$dk-design` to create it. | Converts plain-language intent into visual directions, implements the selected one, shows real responsive output, and explains concrete fixes. No color codes or design vocabulary required. |
| Frontend engineer | Run `dk init`, identify the page or flow, and ask for a targeted build or refinement. | Supplies art direction, hierarchy, token choices, responsive states, pixel review, and verification while preserving the existing framework and components. |
| Designer or design-system team | Import or map tokens, require a direction contract, define brand rules, and run strict gates in CI. | Makes the approved direction portable and reviewable across agents and code changes without reducing taste to one numeric score. |

Codex CLI and the Codex app use the same `$dk-design` instructions and project files. CLI is best for terminal-native iteration and automation; the app is more convenient for visual review and conversation. The product contract does not fork between them.

## Core commands

| Command | Purpose |
|---|---|
| `dk codex status [--json]` | Read-only check of repository skill readiness, explicit activation, runtime/skill digests, install receipt, CLI/Desktop availability, and isolation. |
| `dk codex init [--json]` | Install the bundled skill and digest receipt only at `.agents/skills/dk-design`; never overwrite existing stale or custom content. |
| `dk codex context [--json] [--trust-project-config]` | Build bounded, source-backed context without executing project JavaScript by default; explicitly trust executable config only after reviewing the repository. |
| `dk codex prompt [auto\|explore\|refine\|reconstruct\|reimagine\|verify]` | Emit an explicit `$dk-design` starter prompt for the selected lane. |
| `dk codex mcp [--json]` | Print a current-repository MCP launch specification without writing config or starting a daemon. |
| `dk claude status/init/context/prompt/mcp` | Mirror of the Codex integration for Claude Code: explicit repository-scoped skill install at `.claude/skills/dk-design`, digest receipt, bounded context, starter prompts, and an MCP launch spec. See [Claude Code integration](docs/claude-code.md). |
| `dk intelligence recommend <brief> [options]` | Produce three deterministic offline direction recipes, or fail closed with clarification needs when the brief is too thin. |
| `dk reference add/decompose/map/plan/compare/status/validate` | Build the authorized Reference → Code chain; only a current ledger-attested App Proof case screenshot can reach `match`/`complete`. |
| `dk new <dir>` | Copy a passing, brand-neutral starter workspace. |
| `dk init` | Add configuration to an existing repository without overwriting project files. |
| `dk design init` | Create a compact direction draft. |
| `dk design check` | Validate completeness, approval state, token bindings, and lock integrity. |
| `dk design prompt` | Compile an approved, drift-free direction into model-neutral build instructions. |
| `dk design lock --accept --actor <name> --reason <why>` | Record the reviewed identity, resolved semantic bindings, accountable reviewer, and decision rationale. |
| `dk design history` | Verify and show the append-only approval hash chain. |
| `dk verify` | Run the zero-dependency core chain: contract → direction → SSOT sync → source rules. |
| `dk verify --full` | Add Stylelint, accessibility, and visual regression gates when their dependencies are installed. |
| `dk proof --app <url> --routes auto` | Prove a running app across route × state × viewport × theme with axe, screenshots, and runtime-token evidence. |
| `dk studio [dir] --open` | Open the read-only local eight-view workbench, including Reference comparison, Bridge Connections, and the sandboxed preview inspector. |
| `dk system graph --json` | Build component, route, story, token, stylesheet, and evidence relationships. |
| `dk benchmark --html` | Run ten isolated drift injections, detections, and byte-exact recoveries. |
| `dk watch` | Recheck changed files incrementally and merge results into the project ledger. |
| `dk build --check` | Verify generated token artifacts match the SSOT. |
| `dk fix --slop --dry-run` | Preview exact, token-backed mechanical fixes; never invent design decisions. |
| `dk baseline --accept` | Ratchet existing debt so only new violations block. |
| `dk tokens import <path>` | Carry supported Tokens Studio data into dk's DTCG subset without inventing values. |
| `dk report --html` | Render the latest ledger as a shareable report without rerunning checks. |
| `dk doctor` | Show optional dependencies and the commands needed to enable full gates. |
| `dk bridge init` | Create the repository-owned integration manifest without overwriting an existing file. |
| `dk bridge doctor` | Preflight role-specific adapter lifecycles, explicit permission grants, and `*Env` variable references. |
| `dk bridge sync [id ...] [--publish]` | Collect and validate external evidence; publish to configured sinks only when explicitly requested. |
| `dk bridge status [--require-sinks]` | Verify provider status, ledger integrity, freshness, trust, repository/commit binding, and required connections; opt in to fail-closed required sink receipts. |

All verification surfaces share the same result: terminal, JSON, compact summary, HTML, and SARIF. Exit codes are stable: `0` pass, `1` policy finding, `2` usage or configuration error.

## What is enforced

The default core needs only Node.js `>=18.14.1`:

```text
tokens.json
   ├─ contract    structure · aliases · naming · required roles · contrast
   ├─ direction   approved identity · semantic bindings · Taste Lock
   ├─ ssot-sync   generated token artifacts match their source
   └─ slop        hardcoded values · generic defaults · custom brand rules
```

Optional full gates add:

- **css-strict** — Stylelint policy
- **a11y** — rendered accessibility checks with Playwright and axe
- **visual** — screenshot regression with explicit baseline acceptance

With [`proof`](docs/app-proof.md) configured, `a11y` targets a running Web app instead of only `file://` HTML and executes a route × state × viewport × theme matrix. Every incomplete case blocks, and actual coverage is recorded in the JSON ledger.

Requested gates never disappear silently. A missing prerequisite is reported as incomplete, and `--require-gates` makes incomplete work fail CI.

## Existing projects and CI

```bash
dk init
dk design init
dk build
dk verify --full --require-gates
dk design lock --accept --actor "Design Lead" --reason "Reviewed responsive UI and proof evidence"
```

Use `dk baseline --accept` when adopting a mature codebase with existing debt. Add custom declarative rules in `dk.config.mjs`, then export `--sarif`, `--json`, or `--summary` to the surrounding CI system. The repository also includes a composite [GitHub Action](action.yml) referenced as `fingertipshq/axion-designer`.

See [Integrations](docs/integrations.md) for SARIF, code scanning, review comments, machine-summary examples, and CI ordering. See the [Axion Bridge field manual](docs/axion-bridge.md) for concrete configuration of all seven adapters, MCP, trust policy, custom adapters, and CI templates.

## Boundaries

- The CLI does not call a model. Codex performs creative work; the CLI stores contracts and verifies reproducible facts.
- Codex and Claude Code integrations are repository-scoped and explicit-only. Axion never installs itself into user-level Codex, Claude, or agent directories; `dk codex mcp` and `dk claude mcp` are output-only.
- Taste Lock protects an approved identity and its bound semantic roles. It does not certify objective beauty.
- Bridge permissions are application-level invocation gates, not an operating-system sandbox; repository-local custom adapters must be reviewed as executable code.
- Figma, Chromatic, GitHub, preview, artifact, and webhook evidence cannot create design approval, accept a baseline, or modify Taste Lock.
- The token reader supports a practical DTCG subset, including aliases, modes, sRGB object-form colors, and dimensions. Unsupported composite values are reported rather than guessed.
- Full accessibility and screenshot gates require their documented optional dependencies and browser runtime.

## Documentation

- [AI UI Director](docs/ai-ui-director.md)
- [Claude Code integration](docs/claude-code.md)
- [Local quick start](docs/quickstart-local.md)
- [Architecture and design](DESIGN.md)
- [Rules](docs/rules.md)
- [Acceptance contract](docs/acceptance.md)
- [Visual regression](docs/visual-regression.md)
- [Integrations](docs/integrations.md)
- [Axion Bridge: adapters, MCP, trust, and CI](docs/axion-bridge.md)
- [P3 field guide (Traditional Chinese)](docs/p3-product-guide.zh-TW.md)
- [Competitive capability and market assessment (Traditional Chinese)](docs/competitive-positioning.zh-TW.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

MIT licensed. See [LICENSE](LICENSE).
