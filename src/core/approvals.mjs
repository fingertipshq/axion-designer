/* ============================================================
   Axion approval history — an append-only, hash-chained audit trail for
   explicit Taste Lock decisions. The lock answers "what is approved";
   this history answers "who accepted which change, why, and with what
   verification evidence".

   The file intentionally lives beside direction.json so it can be reviewed
   in Git. Every entry commits to the previous entry. Editing, deleting, or
   reordering an entry therefore makes verification fail closed.
   ============================================================ */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { safeWriteFileSync } from './safe-write.mjs';

export const APPROVAL_HISTORY_SCHEMA = 'dk-approval-history/v1';
export const APPROVAL_ENTRY_SCHEMA = 'dk-approval/v1';

export class ApprovalHistoryError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ApprovalHistoryError';
    this.code = 'DK_APPROVAL_HISTORY';
    this.issues = issues;
  }
}

export function defaultApprovalHistoryPath(lockPath) {
  return join(dirname(lockPath), 'approval-history.json');
}

export function emptyApprovalHistory() {
  return { schema: APPROVAL_HISTORY_SCHEMA, entries: [] };
}

/** Read and verify the complete chain. A missing file is a valid empty chain. */
export function readApprovalHistory(path) {
  if (!existsSync(path)) {
    const history = emptyApprovalHistory();
    return { ok: true, missing: true, history, issues: [], headHash: null };
  }
  let history;
  try {
    history = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      missing: false,
      history: null,
      issues: [{ code: 'invalid-json', index: null, message: error?.message ?? String(error) }],
      headHash: null,
    };
  }
  const result = validateApprovalHistory(history);
  return { ...result, missing: false, history };
}

/** Validate schema, field shape, hashes, and every previous-hash link. */
export function validateApprovalHistory(history) {
  const issues = [];
  if (!isObject(history) || history.schema !== APPROVAL_HISTORY_SCHEMA || !Array.isArray(history.entries)) {
    return {
      ok: false,
      issues: [{
        code: 'invalid-history', index: null,
        message: `Approval history must be ${APPROVAL_HISTORY_SCHEMA} with an entries array.`,
      }],
      headHash: null,
    };
  }

  let previous = null;
  const ids = new Set();
  history.entries.forEach((entry, index) => {
    if (!isObject(entry) || entry.schema !== APPROVAL_ENTRY_SCHEMA) {
      issues.push({ code: 'invalid-entry', index, message: `Entry ${index + 1} has an invalid schema.` });
      previous = typeof entry?.entryHash === 'string' ? entry.entryHash : null;
      return;
    }
    const required = ['id', 'action', 'directionName', 'directionHash', 'bindingHash', 'actor', 'reason', 'createdAt', 'entryHash'];
    for (const field of required) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        issues.push({ code: 'invalid-field', index, field, message: `Entry ${index + 1} has an invalid ${field}.` });
      }
    }
    if (!['created', 'updated'].includes(entry.action)) {
      issues.push({ code: 'invalid-action', index, message: `Entry ${index + 1} action must be created or updated.` });
    }
    if (!HASH16.test(entry.directionHash ?? '') || !HASH16.test(entry.bindingHash ?? '')) {
      issues.push({ code: 'invalid-lock-hash', index, message: `Entry ${index + 1} has an invalid direction or binding hash.` });
    }
    if (entry.previousHash !== previous) {
      issues.push({
        code: 'broken-chain', index,
        message: `Entry ${index + 1} expected previousHash ${previous ?? 'null'} but found ${entry.previousHash ?? 'null'}.`,
      });
    }
    if (ids.has(entry.id)) issues.push({ code: 'duplicate-id', index, message: `Entry ${index + 1} repeats id ${entry.id}.` });
    ids.add(entry.id);

    const expectedId = approvalId(entryPayload(entry));
    if (entry.id !== expectedId) {
      issues.push({ code: 'id-mismatch', index, message: `Entry ${index + 1} id does not match its contents.` });
    }
    const expectedHash = approvalHash({ ...entryPayload(entry), id: entry.id });
    if (entry.entryHash !== expectedHash) {
      issues.push({ code: 'hash-mismatch', index, message: `Entry ${index + 1} hash does not match its contents.` });
    }
    previous = entry.entryHash;
  });

  return { ok: issues.length === 0, issues, headHash: history.entries.at(-1)?.entryHash ?? null };
}

/**
 * Atomically append one approval decision. Existing corrupt history is never
 * overwritten: the caller must investigate or restore it from version control.
 */
export function appendApproval(root, path, input, options = {}) {
  const loaded = readApprovalHistory(path);
  if (!loaded.ok) {
    throw new ApprovalHistoryError(
      `Refusing to append to an invalid approval history (${relative(root, path)}).`,
      loaded.issues,
    );
  }

  const timestamp = isoTimestamp(options.now ?? new Date());
  const last = loaded.history.entries.at(-1) ?? null;
  const payload = {
    schema: APPROVAL_ENTRY_SCHEMA,
    action: last ? 'updated' : 'created',
    directionName: clean(input.directionName, 160, 'Unnamed direction'),
    directionHash: requireHash16(input.directionHash, 'directionHash'),
    bindingHash: requireHash16(input.bindingHash, 'bindingHash'),
    actor: clean(input.actor, 160, 'unknown'),
    reason: clean(input.reason, 1000, last ? 'Explicitly accepted design change.' : 'Initial design approval.'),
    createdAt: timestamp,
    previousHash: last?.entryHash ?? null,
    evidence: normalizeEvidence(input.evidence),
  };
  const id = approvalId(payload);
  const entry = { ...payload, id, entryHash: approvalHash({ ...payload, id }) };
  const history = { schema: APPROVAL_HISTORY_SCHEMA, entries: [...loaded.history.entries, entry] };

  const verified = validateApprovalHistory(history);
  if (!verified.ok) throw new ApprovalHistoryError('Generated approval entry failed self-verification.', verified.issues);
  safeWriteFileSync(root, path, `${JSON.stringify(history, null, 2)}\n`);
  return { entry, history, headHash: entry.entryHash, path };
}

/** Capture the latest persisted dk verification as immutable approval evidence. */
export function readVerificationEvidence(root, reportPath = join(root, '.dk', 'report.json')) {
  if (!existsSync(reportPath)) return null;
  try {
    const source = readFileSync(reportPath, 'utf8');
    const report = JSON.parse(source);
    return normalizeEvidence({
      report: relative(root, reportPath).split('\\').join('/'),
      reportHash: sha256(source),
      generatedAt: report.generatedAt ?? null,
      status: report.status ?? null,
      exitCode: Number.isInteger(report.exitCode) ? report.exitCode : null,
      counts: report.counts ?? null,
      gates: Array.isArray(report.gates)
        ? report.gates.map(({ id, status, reason }) => ({ id, status, ...(reason ? { reason } : {}) }))
        : [],
    });
  } catch {
    // A malformed report is not trustworthy evidence. The approval itself can
    // still be recorded, explicitly showing that no verified report was bound.
    return null;
  }
}

export function resolveApprovalActor(explicit, env = process.env) {
  return clean(
    explicit || env.GIT_AUTHOR_NAME || env.GITHUB_ACTOR || env.GITLAB_USER_NAME || env.USER || env.USERNAME,
    160,
    'unknown',
  );
}

function entryPayload(entry) {
  return {
    schema: entry.schema,
    action: entry.action,
    directionName: entry.directionName,
    directionHash: entry.directionHash,
    bindingHash: entry.bindingHash,
    actor: entry.actor,
    reason: entry.reason,
    createdAt: entry.createdAt,
    previousHash: entry.previousHash ?? null,
    evidence: entry.evidence ?? null,
  };
}

function approvalId(payload) { return `apr_${sha256(stableStringify(payload)).slice(0, 16)}`; }
function approvalHash(payload) { return sha256(stableStringify(payload)); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function normalizeEvidence(value) {
  if (!isObject(value)) return null;
  const counts = isObject(value.counts)
    ? {
      error: finiteInteger(value.counts.error),
      warn: finiteInteger(value.counts.warn),
      info: finiteInteger(value.counts.info),
    }
    : null;
  const gates = Array.isArray(value.gates)
    ? value.gates.filter(isObject).map((gate) => ({
      id: clean(gate.id, 120, 'unknown'),
      status: clean(gate.status, 80, 'unknown'),
      ...(gate.reason ? { reason: clean(gate.reason, 500, '') } : {}),
    }))
    : [];
  return {
    report: clean(value.report, 500, null),
    reportHash: typeof value.reportHash === 'string' && HASH64.test(value.reportHash) ? value.reportHash : null,
    generatedAt: validIso(value.generatedAt) ? new Date(value.generatedAt).toISOString() : null,
    status: clean(value.status, 80, null),
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    counts,
    gates,
  };
}

function requireHash16(value, field) {
  if (typeof value !== 'string' || !HASH16.test(value)) {
    throw new ApprovalHistoryError(`${field} must be a 16-character hexadecimal Taste Lock hash.`);
  }
  return value.toLowerCase();
}
function clean(value, max, fallback) {
  if (value == null) return fallback;
  const result = String(value).trim().replace(/\s+/g, ' ').slice(0, max);
  return result || fallback;
}
function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ApprovalHistoryError('Approval timestamp must be a valid date.');
  return date.toISOString();
}
function validIso(value) { return typeof value === 'string' && Number.isFinite(new Date(value).getTime()); }
function finiteInteger(value) { return Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0; }
function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const HASH16 = /^[a-f0-9]{16}$/i;
const HASH64 = /^[a-f0-9]{64}$/i;
