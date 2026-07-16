# Security policy

## Supported versions

Security fixes are provided for the latest released version.

## Reporting a vulnerability

Do not disclose a vulnerability in a public issue. Use the repository's **Security → Report a vulnerability** form. If private vulnerability reporting is unavailable, open a public issue containing no exploit details and ask the maintainers to provide a private channel.

Include the affected version, impact, minimal reproduction, and any suggested mitigation. Maintainers will acknowledge the report, confirm scope, and coordinate disclosure after a fix is available.

## Trust model

`dk` is a local Node.js CLI. The CLI does not call an AI model or transmit project files to a dk service.

The following boundaries still require normal development caution:

- `dk.config.mjs` is executable JavaScript. Run dk only in repositories whose configuration you trust.
- Optional full gates may start project-configured tools or a local development server. Review the repository's commands and Playwright configuration first.
- The Codex plugin supplies instructions and invokes the bundled local workflow within the permissions granted to Codex. It does not grant additional operating-system permissions.
- HTML, JSON, SARIF, screenshots, and `.dk/` ledger files may contain source excerpts or project paths. Treat generated reports according to the sensitivity of the inspected repository.
- Mechanical fixes are intentionally allowlisted, but review any write operation before committing it.

Dependencies are locked for development and release builds. Published artifacts should be generated through the repository release workflow with provenance enabled.
