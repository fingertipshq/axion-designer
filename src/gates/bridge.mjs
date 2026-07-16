/* Axion Bridge policy gate: project-owned external evidence becomes ordinary
   Findings, so it shares severity overrides, baselines, SARIF, HTML, and CI
   exit semantics with every other Axion rule. */
import { relative, sep } from 'node:path';
import { auditBridge } from '../bridge/orchestrator.mjs';
import { makeFinding } from '../core/finding.mjs';

export function bridgeGate(ctx) {
  const configured = ctx.config.bridge?.connections ?? [];
  if (!configured.length) {
    return { findings: [], emits: { bridgeStatus: 'not-configured', bridgeSummary: { total: 0 } } };
  }
  const audit = auditBridge(ctx.config, { verifyArtifacts: true });
  const findings = audit.issues.map((issue) => makeFinding({
    ruleId: ruleFor(issue.code),
    severity: issue.severity === 'warn' ? 'warn' : 'error',
    file: issue.connection ? null : relativePath(ctx.root, audit.ledger.path),
    line: null,
    col: null,
    message: `${issue.connection ? `${issue.connection}: ` : ''}${issue.message}`,
    evidence: issue.path ?? issue.code,
    meta: {
      bridgeCode: issue.code,
      connection: issue.connection ?? null,
      ledgerHead: audit.ledger.headHash ?? null,
    },
  }));
  return {
    findings,
    emits: {
      bridgeStatus: audit.status,
      bridgeSummary: audit.summary,
      bridgeLedgerHead: audit.ledger.headHash ?? null,
    },
  };
}

function ruleFor(code) {
  if (['missing-evidence', 'missing-envelope'].includes(code)) return 'bridge/missing-evidence';
  if (code === 'stale' || code === 'freshness-order' || code === 'from-future') return 'bridge/stale-evidence';
  if (code === 'commit-mismatch' || code === 'commit-required') return 'bridge/commit-mismatch';
  if (code === 'provider-failed') return 'bridge/provider-failed';
  return 'bridge/invalid-evidence';
}

function relativePath(root, file) {
  if (!file) return null;
  const value = relative(root, file);
  return value && !value.startsWith('..') ? value.split(sep).join('/') : null;
}
