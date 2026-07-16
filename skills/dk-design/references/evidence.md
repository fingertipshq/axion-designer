# Evidence kernel

Read only for failed or incomplete verification, CI output, Taste Locks, or visual baselines.

- Exit `0`: nothing met the configured failure threshold; still inspect gate status.
- Exit `1`: a finding blocked or a required attempted gate could not complete.
- Exit `2`: usage, configuration, or token-input error.
- Top-level status is `passed`, `incomplete`, or `failed`. Zero findings with a skipped attempted gate can still be incomplete.

Prefer `dk verify --summary` for bounded context. Use `--json` only for `ruleId`, file, line, evidence, and fix details; use SARIF/HTML only when the workflow requests those artifacts.

For a running Web app, use `dk proof --app <url> --routes <auto|/a,/b>` or a checked-in `config.proof`. The resulting `.dk/proof/app-proof.json` is authoritative only when its coverage status is complete and every promised route × state × viewport × theme case has a concrete result. Discovery, test source, or screenshot filenames show possible surfaces; they do not prove a pass. A new incomplete attempt replaces stale complete proof.

Use `dk system --json` to inspect code relationships and `dk studio --open` for local visual review. System Graph nodes retain file/line evidence, but graph heuristics never override the verification ledger.

Fix the earliest broken layer: token contract → generated SSOT sync → source/slop → optional CSS → rendered accessibility → pixels. Re-run the narrow gate, then the required chain.

These actions change policy or accepted evidence and require explicit authority: accepting debt, disabling or downgrading a rule, adding allowlists or ignore comments, removing targets or required gates, updating an existing Taste Lock, or replacing a visual baseline. Record every intentional lock update with `--reason`, then confirm the hash-chained record with `dk design history`; never repair a broken chain by overwriting it.
