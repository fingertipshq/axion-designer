# Reference reconstruction kernel

Read only for the **Reconstruct** lane: one to five authorized PNG, JPEG, or WebP references must become maintainable code in the target repository.

## Establish authority and evidence

Before editing source, register every reference with `dk reference add <id> <image> --source <provenance> --license <status> --scope <paths-or-routes> --viewport <WxH[@DPR]>`. Record the original source or local provenance, license or authorization basis, allowed scope, viewport, and a short relationship to learn. Axion copies the bounded image into `.dk/reference/assets/`, records its SHA-256 digest, and never treats an unregistered path as evidence. In v1, one reference has exactly one registered viewport and one required comparison.

Reject a reference when its origin or authorized scope is unknown. A reference registered with `--license unknown` may be decomposed for review, but it cannot be mapped, planned, reconstructed, or compared until its authorization is clarified. Do not copy proprietary text, logos, illustrations, trade dress, prompts, code, or a living designer's signature style. Learn relationships: focal order, hierarchy, density, rhythm, type contrast, color allocation, component logic, responsive priority, and state behavior.

## Build the evidence chain

Use the machine schemas in this order:

1. `reference-manifest/v1` — provenance, authorization, digest, media, and viewport;
2. `visual-decomposition/v1` — observable regions, hierarchy, relationships, and uncertainty;
3. `component-mapping/v1` — each region mapped to an existing component/token or an explicit new scope;
4. `reconstruction-plan/v1` — ordered, bounded source edits and acceptance checks;
5. `reference-comparison/v1` — actual reference/render evidence, region findings, and the top one to three deltas.

Codex may fill the decomposition, mapping, and plan because they require visual and repository judgment. Axion must validate each artifact mechanically before it can drive the next step. Unknown fields, escaped paths, digest mismatches, missing evidence, or a whole-reference background-image shortcut fail closed.

Write each Codex-authored input as a project-local JSON draft, then promote it through the public validators: `dk reference decompose <draft.json>`, `dk reference map <draft.json>`, and `dk reference plan <draft.json>`. Run `dk reference status` after every stage. Do not hand-write the durable artifact files or invent their hashes; the core writes and links those atomically.

## Implement and compare

Preserve the repository's framework, routes, data flow, accessible components, and token source of truth. Reconstruct semantics and behavior as real DOM and components. Never ship the reference as a full-page image, oversized background, canvas trace, or invisible overlay.

Run App Proof for the plan's single declared route/state/theme/viewport, then use the successful case's original deterministic `.dk/proof/screenshots/case_….png` path in `dk reference compare <reference-id> <candidate-image> <implementation-files...>`. The implementation file arguments are mandatory and must be exactly the same complete set declared by `reconstruction-plan/v1` at `verification.implementationFiles`: do not omit a planned file, add an unrelated file, or substitute a different path. The comparison binds the exact plan, proof, ledger, case, screenshot, viewport, config/source freshness, and implementation digests; it checks position-aware PNG pixels when decodable and records bounded anti-cheat findings for full-page reference reuse. App Proof v2 attests DPR 1 only.

Inspect the result in Studio's eighth, **Reference**, view using side-by-side and overlay modes. It must show whether the browser capture is attested. An arbitrary image—even an identical-byte copy of a proof screenshot—remains `review`; only the original current App Proof case path can reach `match`/`complete`. Repair only the top one to three scoped deltas, rerun App Proof after every source change, then compare the new case screenshot. Pixel deltas and aesthetic judgment remain advisory and never replace accessibility checks, the visual gate, or `dk verify`.

Finish by reporting the reference IDs, authorization scope, mapped components, rendered viewport, top repaired deltas, remaining uncertainty, and verification status. Never claim pixel parity when the comparison or important states are incomplete.
