# Changelog

All notable user-facing changes are recorded here.

## Unreleased — P3 local candidate

Repository-local candidate only. It has not been published, installed as a global Codex plugin, registered as a global MCP server, or added to a marketplace.

- Added the `$dk-design` Codex workflow for UI direction, authorized reference reconstruction, implementation, rendered review, and verification, including the explicit `reconstruct` lane.
- Added offline Design Intelligence across product, style, color, typography, layout, motion, icons, charts, and UX, with deterministic three-direction recommendations and fail-closed clarification for underspecified briefs.
- Added the five-stage Reference → Code chain: manifest, visual decomposition, component mapping, reconstruction plan, and comparison, with strict schema and digest linkage.
- Added reference authorization and scope enforcement: `unknown` licences can only be decomposed, v1 binds one viewport and one required comparison, and comparison requires the exact implementation-file set declared by the reconstruction plan.
- Added App Proof capture attestation bound to proof, ledger, case, screenshot, viewport, config/source freshness, and implementation digests. Only the original current successful case path can reach `match`/`complete`; arbitrary images and same-byte copies remain review evidence.
- Added source-digest freshness checks, position-aware PNG comparison, bounded anti-cheat detection, and advisory top-delta evidence without replacing visual baselines, accessibility, broader responsive/state coverage, or `dk verify`. App Proof v2 attestation is intentionally limited to DPR 1.
- Added explicit-only, repository-scoped Codex CLI and desktop activation with `dk codex status/init`, fail-closed non-overwriting installs, and no global Codex writes.
- Added the Claude Code host surface: `dk claude status/init/context/prompt/mcp` installs a deterministically generated skill bundle at `.claude/skills/dk-design` with the same fail-closed digest receipt, scope guard, and explicit-only activation; `skills/dk-design-claude` is regenerated from the canonical bundle by `npm run build:claude-skill` and drift-tested by `tests/claude-integration.mjs`.
- Added `dk codex context/prompt/mcp`, a bounded source-backed design context with Intelligence and Reference state, lane-aware starter prompts, and a root-bound Project MCP launch specification.
- Added the read-only `axion://codex/context` MCP resource, Codex contract/eval coverage, tarball consumer tests, and a clean scaffold that never inherits runtime `.dk` evidence.
- Added a compact direction contract with semantic token bindings and Taste Lock drift protection.
- Added Axion Studio with eight repository-backed views: Overview, Direction, Proof, System Graph, Live Preview, Changes, Bridge Connections, and Reference.
- Added Reference side-by-side and overlay review, stage status, provenance and scope inspection, top deltas, and scoped repair requests.
- Added a sandboxed live preview with a nonce-bound DOM inspector for selector, geometry, component, and CSS-token clues.
- Added the System Graph index and public JSON API for routes, components, stories, tokens, dependencies, and bounded source evidence.
- Added App Proof v2: bounded route × state × viewport × theme browser matrices, Axe scans, per-case screenshots and digests, runtime token evidence, and exact accessibility-policy binding.
- Added append-only, hash-chained design approvals with actor, reason, evidence, tamper detection, and CI verification.
- Added the zero-dependency `dk` core for token contracts, SSOT sync, source rules, baselines, reports, and deterministic fixes.
- Added optional Stylelint, accessibility, and screenshot-regression gates with fail-closed `--require-gates` behavior.
- Added terminal, JSON, compact summary, HTML, and SARIF report surfaces from one evidence ledger.
- Added the P3 drift benchmark with ten deterministic detect/recover scenarios, latency evidence, timeouts, and cleanup guarantees.
- Added Node 18+ TypeScript contracts, JSON Schemas, a GitHub Action, release identity checks, and tarball install smoke coverage.
- Added Axion Bridge, a repository-owned evidence integration spine with versioned adapter/envelope contracts, explicit permissions, timeouts, commit and freshness policy, artifact verification, and an append-only hash-chained ledger.
- Added production adapters for Storybook, Figma, preview health and commit binding, GitHub Actions and Checks, Chromatic evidence, generic JSON artifacts, and exact-allowlist webhooks, plus repository-local custom adapters.
- Added `dk bridge init/catalog/doctor/sync/list/status/inspect/ingest`, the fail-closed Bridge verification gate, JSON surfaces, Studio connection inspection, and GitHub/GitLab/Azure/Jenkins examples.
- Added an official-SDK stdio MCP server with bounded project resources and verification tools, including read-only Bridge status and dry-run Bridge preflight. MCP and external evidence cannot accept Taste Lock, baselines, or approvals.
- Added a repository-contained Codex plugin artifact without installing or publishing it. Its bundled skill can operate only after explicit invocation against an explicit target repository; preflight rejects root, home, `CODEX_HOME`, and global configuration scopes.
- Split MCP authority: the bundled Plugin MCP exposes only stateless offline Design Intelligence, while project evidence and Reference operations remain available only through an explicitly launched, fixed-root Project MCP.
- Added a reproducible CLI proof (`npm run demo`) with machine-verifiable red-to-green evidence.
