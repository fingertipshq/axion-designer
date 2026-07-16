#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import {
  appendApproval,
  readApprovalHistory,
  readVerificationEvidence,
  resolveApprovalActor,
} from '../src/core/approvals.mjs';

const root = mkdtempSync(join(tmpdir(), 'axion-approval-'));
const historyPath = join(root, 'design', 'approval-history.json');
mkdirSync(dirname(historyPath), { recursive: true });

const first = appendApproval(root, historyPath, {
  directionName: 'Quiet Signal',
  directionHash: '1111111111111111',
  bindingHash: '2222222222222222',
  actor: 'Design Lead',
  reason: 'Initial product direction accepted after responsive review.',
}, { now: '2026-07-15T01:00:00.000Z' });
assert.equal(first.entry.action, 'created');
assert.equal(first.entry.previousHash, null);
assert.match(first.entry.id, /^apr_[a-f0-9]{16}$/);
assert.match(first.entry.entryHash, /^[a-f0-9]{64}$/);

const second = appendApproval(root, historyPath, {
  directionName: 'Quiet Signal',
  directionHash: '3333333333333333',
  bindingHash: '4444444444444444',
  actor: 'Design Lead',
  reason: 'Intentional redesign: status rail now leads the release workflow.',
}, { now: '2026-07-15T02:00:00.000Z' });
assert.equal(second.entry.action, 'updated');
assert.equal(second.entry.previousHash, first.entry.entryHash);

const valid = readApprovalHistory(historyPath);
assert.equal(valid.ok, true);
assert.equal(valid.history.entries.length, 2);
assert.equal(valid.headHash, second.entry.entryHash);

const reportPath = join(root, '.dk', 'report.json');
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify({
  generatedAt: '2026-07-15T01:59:59.000Z',
  status: 'passed',
  exitCode: 0,
  counts: { error: 0, warn: 1, info: 0 },
  gates: [{ id: 'direction', status: 'ran' }, { id: 'visual', status: 'ran' }],
}));
const evidence = readVerificationEvidence(root);
assert.equal(evidence.status, 'passed');
assert.equal(evidence.counts.warn, 1);
assert.match(evidence.reportHash, /^[a-f0-9]{64}$/);
assert.equal(evidence.gates[1].id, 'visual');
assert.equal(resolveApprovalActor(null, { GITHUB_ACTOR: 'axion-bot' }), 'axion-bot');

const tampered = JSON.parse(readFileSync(historyPath, 'utf8'));
tampered.entries[0].reason = 'silently rewritten';
writeFileSync(historyPath, JSON.stringify(tampered, null, 2));
const invalid = readApprovalHistory(historyPath);
assert.equal(invalid.ok, false);
assert(invalid.issues.some((issue) => issue.code === 'id-mismatch'));
assert(invalid.issues.some((issue) => issue.code === 'hash-mismatch'));

console.log('P3 governance: PASS (append-only chain, evidence binding, tamper detection)');
