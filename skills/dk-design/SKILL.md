---
name: dk-design
description: Art-direct, reconstruct, build, inspect, verify, and preserve distinctive production Web UI with Axion Designer. Explicitly invoke for new websites and product screens, authorized screenshot-to-code reconstruction, visual redesigns, targeted frontend improvements, design-system and token consistency, running-app route/state proof, accessibility or screenshot regressions, or any Codex task that must turn approved visual intent into code without later AI style drift.
---

# Axion Designer

Create freely. Verify mechanically. Preserve only what was approved.

## Stay repository-scoped

Run this skill only after explicit `$dk-design` invocation. Never enable it implicitly or install it globally. Do not write `$HOME/.codex`, `~/.codex`, `$HOME/.agents`, `~/.agents`, `/etc/codex`, a personal marketplace, or the Codex plugin cache. Do not run `npm link`, `npm install -g`, `codex plugin add`, or `codex mcp add`. Project files, the bundled plugin, and an existing project dependency are the only allowed integration surfaces.

Run `node scripts/preflight.mjs --cwd <target-repository>` from this skill directory before the first dk command. Use the returned absolute `command` and `args`. For an installed repository skill, preflight verifies the project dependency version plus runtime and skill digests from the repository install receipt. For the bundled plugin skill, it verifies the colocated runtime and skill digest, binds the invocation to the explicitly supplied target repository, and rejects filesystem-root, home, Codex-global, or user-global targets. Do not guess a global `dk` executable and do not install dependencies merely to find the runtime. Stop with a concrete setup instruction when preflight is not `ready`.

Only the main agent may modify product source. Subagents may inspect, challenge hierarchy, propose directions, or critique renders, but they stay read-only and return concise findings to the main agent. Never let parallel agents edit overlapping files.

## Inspect and route

Work from the target repository and preserve unrelated changes. Inspect the real routes, content, components, tokens, rendered entry points, `git status --short`, and any `design/direction.json` plus lock before deciding what to change.

Use the exact runtime returned by preflight for every dk call. It resolves a same-version plugin bundle, the target project's `node_modules/axion-designer`, or this source repository; it never falls through to an unknown global executable.

Choose one lane:

- **Refine** — a narrow request or matched Taste Lock. Preserve identity; do not regenerate the page.
- **Explore** — a new product or genuinely unresolved direction. Compare alternatives before full implementation.
- **Reconstruct** — one to five authorized reference images must become real code in the existing stack. Preserve provenance, decompose relationships, map components, and compare rendered pixels; never hide the reference inside a full-page background image.
- **Reimagine** — an explicit redesign. Existing identity may change, but its lock remains blocking until the redesign is reviewed.
- **Verify** — an audit or failing gate. Inspect evidence and make only evidence-backed fixes.

For Reconstruct, read [references/reconstruct.md](references/reconstruct.md) before changing source. A reference is evidence, not automatic permission to copy proprietary assets, trade dress, or a living designer's signature style.

Run `dk doctor` and `dk verify --summary` for an existing dk project. A drifted lock is evidence, not permission to refresh it.

When the repository is unfamiliar, run `dk codex context --json` first. It is the bounded, source-backed context surface for direction, routes, components, report freshness, App Proof, Reference evidence, authority, and the narrowest next commands. The safe default never executes `dk.config.mjs` or `.js`; when it reports `requires-trust`, use `--trust-project-config` only after the user has trusted this repository and executable configuration is necessary. Use `dk system` only when the compact context does not answer a concrete architecture question. Treat indexed routes and relationships as leads, but only current complete App Proof as proof that a surface passed. Use `dk studio --open` when interactive direction, graph, diff, or DOM inspection materially helps the user review the work. Studio is read-only and local; stop it when the review ends.

## Shape

Use this phase only for Explore, Reimagine, or material visual uncertainty. Read [references/taste.md](references/taste.md) first.

For a consequential Explore or Reimagine task, read [references/codex-surfaces.md](references/codex-surfaces.md). When subagents are available and parallel exploration materially improves quality, run the read-only direction cell defined there. Give every explorer the same product truth and content; do not reveal the preferred answer. The main agent alone synthesizes the three final concepts and owns every write.

Infer product, audience, primary task, action, real content, and constraints from the repository. Ask at most three questions only when their answers would materially change the result.

When the repository does not already settle the visual direction, run `dk intelligence recommend <brief> --stack <stack> --json`. Treat its three offline, provenance-backed recipes as decision support: preserve product truth, inspect any low-confidence warnings, and synthesize the final concepts instead of copying one recipe mechanically. Use `dk intelligence catalog` when the stack or supported controls are unclear.

Use one register deliberately: `brand` favors emotion, narrative, and memorability; `product` favors task clarity, density, states, and repeat use.

When the visual choice is consequential, create three complete-surface concepts with the same content, function, and viewport. Change macrostructure, type roles, density, geometry, color relationships, and signature—not merely palette. Use lightweight rendered boards for utility UI; use image generation only when image-led or expressive concepting would materially reduce uncertainty. Store temporary studies under `.dk/dk-design/explore/`.

If the user requested a checkpoint, present the three concepts. Otherwise choose the strongest, state its tradeoff, and proceed. Keep rejected concepts out of the permanent contract.

Run `dk design init` if needed, then encode only the selected `context`, `identity`, and at least four semantic `bindings` in `design/direction.json`. Run `dk design check`. In the same session, read the compact JSON directly; `dk design prompt` is only for handing the direction to another agent or model.

## Build

Reuse the existing stack, accessible components, and token source of truth. Prefer a targeted edit over broad regeneration.

For repeated-task interfaces, forms, dashboards, or dense application UI, read [references/product-ui.md](references/product-ui.md) before changing layout or states.

Implement in this order:

1. real content, semantics, and primary task;
2. hierarchy, macro layout, and responsive priority;
3. typography, color, form, spacing, and states through tokens;
4. the single earned signature;
5. restrained motion with reduced-motion behavior.

Do not invent metrics, customers, testimonials, product capabilities, citations, or brand assets. Components provide interaction substrate; the approved direction and tokens provide identity.

## See

Inspect actual rendered pixels at the relevant mobile and desktop widths, plus declared themes and important states. If a concept was approved, compare it beside the latest render.

Read [references/visual-review.md](references/visual-review.md) for material visual review. In the Codex desktop app, show the actual local PNGs with absolute paths and compare them directly. In CLI, still inspect the images; then return a compact comparison table plus absolute artifact paths. Merely creating screenshots is not visual inspection.

For a running Web app, encode important states as declarative `config.proof` actions, then run `dk proof --app <url> --routes <auto|paths>`. Do not claim route/state/theme coverage from route discovery, test filenames, or screenshots alone. Read `.dk/proof/app-proof.json`; every promised matrix case must be complete.

In Reconstruct, pass only the current successful case's original `screenshot.path` to `dk reference compare`; an arbitrary image or same-byte copy cannot become browser-attested evidence. Keep the declared route, state, theme, viewport, and DPR 1 binding exact, and rerun App Proof after every source change.

Use one short fidelity pass:

- focal order and task clarity;
- composition, density, and responsive behavior;
- type, color, form, states, and accessibility;
- whether the signature is earned and the result still looks generic.

Record only the one to three highest-leverage deltas as `observation → impact → change`. Apply them and rerender. Use a second loop only when material drift remains. Aesthetic critique is advisory; never present a model score as CI truth.

## Prove and preserve

Run the narrowest relevant gate while editing, then `dk verify`. Run `dk verify --full --require-gates` when full gates are configured, requested, or required by CI. Prefer `--summary`; use `--json` only for finding-level evidence. Read [references/evidence.md](references/evidence.md) when a run fails, is incomplete, or involves a lock or baseline.

When `design/bridge.json` exists, run `dk bridge doctor` before relying on external tools and read `dk bridge status`. Use `dk bridge sync <id>` only for configured providers relevant to the task; use `--publish` only when the user or repository workflow explicitly authorizes the configured sink. Treat Storybook, Figma, preview, GitHub, Chromatic, artifact, and webhook results as bounded evidence with provider, digest, freshness, permission, and commit policy—not as human approval. Never copy a credential into the manifest or promote external evidence into Taste Lock authority.

Preview a Taste Lock after the selected direction and real pixels were reviewed. Run `dk design lock --accept` only when the current user request explicitly authorizes acceptance and provides or confirms an actor and concrete reason. An intentional redesign always requires explicit authority and `--reason <why>`; verify `dk design history` afterward. Never rewrite or delete approval-history entries. Never update a visual baseline, disable a rule, lower severity, add an ignore, accept debt, or hide a skipped gate merely to obtain green output.

Finish with the lane used, direction, rendered surfaces reviewed, highest-leverage corrections, gates and final status, App Proof matrix coverage when used, and lock/approval state. `incomplete` is not a pass.
