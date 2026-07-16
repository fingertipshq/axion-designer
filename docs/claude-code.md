# Axion Designer in Claude Code

Axion Designer ships the same explicit-only design skill for two agent hosts. `skills/dk-design` is the canonical Codex bundle; `skills/dk-design-claude` is a deterministic artifact generated from it by `npm run build:claude-skill`, exactly like compiled token CSS is generated from the token SSOT. `tests/claude-integration.mjs` fails when the committed Claude bundle drifts from a fresh rebuild.

## Install into a repository

```bash
npm i -D axion-designer        # or a path to a source checkout while unpublished
npx --no-install dk claude init
npx --no-install dk claude status
```

`dk claude init` copies the bundle to `.claude/skills/dk-design` and records the package version plus skill and runtime SHA-256 digests in `.claude/skills/dk-design/.axion-install.json`. The installer is fail-closed and non-overwriting:

- it refuses the filesystem root, the home directory, `~/.claude`, `~/.codex`, `~/.agents`, and `CLAUDE_CONFIG_DIR`;
- it refuses to install without a matching project-local runtime;
- it never replaces stale, tampered, or customized content — review or remove that content first;
- it never writes user-level Claude configuration, plugin caches, or marketplaces.

`dk claude status` re-verifies the copied skill, the project-local runtime, and the install receipt; a missing or mismatched receipt never reports `ready`. Codex and Claude Code integrations are independent: the same repository can hold both `.agents/skills/dk-design` and `.claude/skills/dk-design`.

## Invoke the skill

The skill is explicit-only in both hosts. In Claude Code (CLI or desktop app), invoke it by name:

```text
/dk-design
```

or start from a lane-specific prompt:

```bash
dk claude prompt auto|explore|refine|reconstruct|reimagine|verify
```

Every prompt names the dk-design skill explicitly. Claude then follows the same product contract as Codex: Route → Shape when needed → Build → See → Prove → Preserve, with the deterministic `dk` CLI as the shared verification instrument.

## Bounded context and MCP

```bash
dk claude context [--json] [--trust-project-config]
```

returns the same bounded, source-backed view as the Codex surface — direction, routes, components, report freshness, App Proof, Reference evidence, authority, and the narrowest next commands — with `host: "claude"` and Claude-appropriate next commands. The safe default never executes `dk.config.mjs` or `dk.config.js`.

```bash
dk claude mcp [--json]
```

prints a launch specification bound to the current repository, including a ready-to-paste `projectMcpJson` fragment for the target repo's `.mcp.json`. It writes no configuration and starts no daemon. This repository's own `.mcp.json` already exposes the stateless offline Design Intelligence server to any MCP-capable host, Claude Code included.

## Isolation contract

- Activation is explicit: the skill runs only after the user invokes `/dk-design` or names the dk-design skill.
- `dk claude init` writes only `.claude/skills/dk-design` inside the target repository.
- No command writes `~/.claude`, `~/.codex`, `~/.agents`, `CLAUDE_CONFIG_DIR`, a plugin cache, or a marketplace.
- MCP and external evidence cannot accept Taste Lock, visual baselines, or approvals; those remain human, receipted actions.
