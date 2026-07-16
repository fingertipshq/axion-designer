/* ============================================================
   Direction contract gate — validates the selected AI art direction,
   checks its token bindings, and detects drift from an accepted lock.
   Missing direction files remain backward-compatible unless required.
   ============================================================ */
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { makeFinding } from '../core/finding.mjs';
import {
  DIRECTION_SCHEMA,
  hashDirection,
  hashDirectionBindings,
  validateDirection,
  validateDirectionLock,
} from '../core/direction.mjs';
import { pick } from '../core/i18n.mjs';
import { defaultApprovalHistoryPath, readApprovalHistory } from '../core/approvals.mjs';

export function directionGate(ctx) {
  const source = ctx.config.directionPath;
  const lockPath = ctx.config.directionLockPath;
  const required = ctx.config.directionRequired === true;
  const relSource = source ? relative(ctx.root, source) : 'design/direction.json';
  const relLock = lockPath ? relative(ctx.root, lockPath) : 'design/direction.lock.json';

  if (!source || !existsSync(source)) {
    if (!required) return { findings: [], emits: { directionStatus: 'absent' } };
    return { findings: [makeFinding({
      ruleId: 'direction/missing', severity: 'error', file: relSource,
      message: pick('專案要求設計方向契約，但檔案不存在。', 'The project requires a design direction contract, but the file is missing.'),
      fp: '專案要求設計方向契約，但檔案不存在。',
      fix: pick('執行 `dk design init`，再由 $dk-design 完成、檢查並鎖定方向。',
        'Run `dk design init`, then have $dk-design complete, check, and lock the direction.'),
    })], emits: { directionStatus: 'missing' } };
  }

  let doc;
  try { doc = JSON.parse(readFileSync(source, 'utf8')); }
  catch (err) {
    return { findings: [makeFinding({
      ruleId: 'direction/contract', severity: 'error', file: relSource,
      message: pick(`方向契約不是合法 JSON：${err.message}`, `Direction contract is not valid JSON: ${err.message}`),
      fp: '方向契約不是合法 JSON。',
      fix: pick('修正 JSON 語法後執行 `dk design check`。', 'Fix the JSON syntax, then run `dk design check`.'),
    })], emits: { directionStatus: 'invalid' } };
  }

  const issues = validateDirection(doc, { resolveToken: ctx.resolve });
  // `dk design init` intentionally creates a compact unfinished contract. The focused
  // check teaches each missing decision; project-wide verify keeps one visible warning.
  if (doc?.schema === DIRECTION_SCHEMA && doc?.status === 'draft') {
    const draftIssue = issues.find((issue) => issue.code === 'draft') ?? {
      code: 'draft', severity: 'warn', path: 'status',
      message: pick('AI 設計方向還在探索中，尚未成為可鎖定的產品身份。',
        'The AI design direction is still being explored and is not yet a lockable product identity.'),
      fix: pick('用 `dk design check` 查看完整待辦；選定後設為 approved 並建立 Taste Lock。',
        'Use `dk design check` for the full worksheet; after selection, set approved and create the Taste Lock.'),
    };
    let directionHash = null;
    try { directionHash = hashDirection(doc); } catch { /* malformed draft remains a single warning */ }
    const finding = issueFinding({
      ...draftIssue,
      severity: required ? 'error' : draftIssue.severity,
      ...(required && {
        message: pick('專案要求已批准且已鎖定的設計方向，但目前仍是 draft。',
          'The project requires an approved, locked design direction, but the contract is still a draft.'),
      }),
    }, relSource);
    return {
      findings: [finding],
      emits: {
        directionStatus: 'draft',
        directionName: doc?.name ?? null,
        directionHash,
        directionLocked: false,
      },
    };
  }
  const findings = issues.map((issue) => issueFinding(issue, relSource));
  const hasError = issues.some((issue) => issue.severity === 'error');
  if (hasError) return { findings, emits: { directionStatus: 'invalid', directionName: doc?.name ?? null } };

  const directionHash = hashDirection(doc);
  const bindingHash = hashDirectionBindings(doc, ctx.resolve);
  const emits = {
    directionStatus: doc.status,
    directionName: doc.name,
    directionHash,
    directionBindingHash: bindingHash,
  };

  if (!lockPath || !existsSync(lockPath)) {
    if (doc.status === 'approved') findings.push(makeFinding({
      ruleId: 'direction/unlocked', severity: required ? 'error' : 'warn', file: relSource,
      message: pick(`方向「${doc.name}」已 approved，但尚未鎖定；後續改動無法判定是否為風格飄移。`,
        `Direction “${doc.name}” is approved but not locked, so later edits cannot be distinguished from style drift.`),
      fp: 'approved 方向尚未鎖定。',
      fix: pick('審查後執行 `dk design lock --accept` 建立第一份 direction lock。',
        'After review, run `dk design lock --accept` to create the first direction lock.'),
      meta: { directionHash },
    }));
    return { findings, emits: { ...emits, directionLocked: false } };
  }

  let lock;
  try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); }
  catch (err) {
    findings.push(makeFinding({
      ruleId: 'direction/drift', severity: 'error', file: relLock,
      message: pick(`direction lock 不是合法 JSON：${err.message}`, `Direction lock is not valid JSON: ${err.message}`),
      fp: 'direction lock 不是合法 JSON。',
      fix: pick('不要手改 lock；確認方向後執行 `dk design lock --accept` 重建。',
        'Do not hand-edit the lock; confirm the direction, then rebuild with `dk design lock --accept`.'),
    }));
    return { findings, emits: { ...emits, directionLocked: false } };
  }
  if (!validateDirectionLock(lock)) {
    findings.push(makeFinding({
      ruleId: 'direction/drift', severity: 'error', file: relLock,
      message: pick('direction lock 格式無效，不能證明目前方向。',
        'The direction lock format is invalid and cannot prove the current direction.'),
      fp: 'direction lock 格式無效。',
      fix: pick('確認方向後執行 `dk design lock --accept` 重建。',
        'Confirm the direction, then rebuild it with `dk design lock --accept`.'),
    }));
    return { findings, emits: { ...emits, directionLocked: false } };
  }

  const approvalPath = defaultApprovalHistoryPath(lockPath);
  let approvalEmits = { directionApprovalStatus: 'absent', directionApprovalCount: 0, directionApprovalHeadHash: null };
  if (existsSync(approvalPath)) {
    const approval = readApprovalHistory(approvalPath);
    const relApproval = relative(ctx.root, approvalPath);
    const latest = approval.history?.entries?.at(-1) ?? null;
    const stale = approval.ok && (!latest
      || latest.directionHash !== lock.directionHash
      || latest.bindingHash !== lock.bindingHash
      || (lock.approvalHeadHash && lock.approvalHeadHash !== approval.headHash));
    approvalEmits = {
      directionApprovalStatus: !approval.ok ? 'invalid' : stale ? 'stale' : 'verified',
      directionApprovalCount: approval.history?.entries?.length ?? 0,
      directionApprovalHeadHash: approval.headHash ?? null,
    };
    if (!approval.ok || stale) findings.push(makeFinding({
      ruleId: 'direction/approval-history', severity: 'error', file: relApproval,
      message: !approval.ok
        ? pick('設計核准歷史的 hash chain 驗證失敗；紀錄可能遭到改寫、刪除或重排。',
          'The design approval history hash chain failed verification; records may have been rewritten, deleted, or reordered.')
        : pick('最新核准紀錄與目前 Taste Lock 不一致。',
          'The latest approval record does not match the current Taste Lock.'),
      fp: !approval.ok ? '設計核准歷史鏈驗證失敗。' : '核准歷史與 Taste Lock 不一致。',
      fix: pick('從版本控制還原核准歷史；只能用 `dk design lock --accept` 追加新核准。',
        'Restore the approval history from version control; append approvals only with `dk design lock --accept`.'),
      meta: {
        approvalStatus: approvalEmits.directionApprovalStatus,
        approvalCount: approvalEmits.directionApprovalCount,
        approvalHeadHash: approvalEmits.directionApprovalHeadHash,
      },
    }));
  } else if (lock.approvalHeadHash) {
    approvalEmits = { directionApprovalStatus: 'invalid', directionApprovalCount: 0, directionApprovalHeadHash: null };
    findings.push(makeFinding({
      ruleId: 'direction/approval-history', severity: 'error', file: relative(ctx.root, approvalPath),
      message: pick('Taste Lock 已承諾一條核准歷史，但該檔案已被刪除。',
        'The Taste Lock commits to an approval history, but that file was deleted.'),
      fp: 'Taste Lock 對應的核准歷史已刪除。',
      fix: pick('從版本控制還原 design/approval-history.json。',
        'Restore design/approval-history.json from version control.'),
      meta: { approvalStatus: 'invalid', expectedHeadHash: lock.approvalHeadHash },
    }));
  }

  if (lock.directionHash !== directionHash || lock.bindingHash !== bindingHash) {
    const directionChanged = lock.directionHash !== directionHash;
    const bindingsChanged = lock.bindingHash !== bindingHash;
    findings.push(makeFinding({
      ruleId: 'direction/drift', severity: 'error', file: relSource,
      message: pick(
        `Taste Lock 已偏移（${directionChanged ? `direction ${short(lock.directionHash)}→${short(directionHash)}` : ''}${directionChanged && bindingsChanged ? '；' : ''}${bindingsChanged ? `bindings ${short(lock.bindingHash)}→${short(bindingHash)}` : ''}）；功能修改不能偷偷改變產品身份。`,
        `The Taste Lock drifted (${directionChanged ? `direction ${short(lock.directionHash)}→${short(directionHash)}` : ''}${directionChanged && bindingsChanged ? '; ' : ''}${bindingsChanged ? `bindings ${short(lock.bindingHash)}→${short(bindingHash)}` : ''}); a feature change must not silently change product identity.`),
      fp: '設計方向已偏離 lock。',
      fix: pick(
        '若是意外，還原 direction.json；若是刻意改版，先審查方向與畫面，再明確執行 `dk design lock --accept`。',
        'If accidental, restore direction.json. For an intentional redesign, review direction and pixels, then explicitly run `dk design lock --accept`.'),
      meta: {
        directionChanged, bindingsChanged,
        baselineHash: lock.directionHash, currentHash: directionHash,
        baselineBindingHash: lock.bindingHash, currentBindingHash: bindingHash,
        directionName: doc.name,
      },
    }));
    return { findings, emits: {
      ...emits, ...approvalEmits, directionLocked: false,
      directionBaselineHash: lock.directionHash,
      directionBaselineBindingHash: lock.bindingHash,
    } };
  }

  return { findings, emits: {
    ...emits, ...approvalEmits, directionLocked: true,
    directionBaselineHash: lock.directionHash,
    directionBaselineBindingHash: lock.bindingHash,
  } };
}

function issueFinding(issue, file) {
  const ruleId = issue.code === 'token-binding'
    ? 'direction/token-binding'
    : issue.code === 'draft' || issue.code === 'generic'
      ? 'direction/draft'
      : 'direction/contract';
  return makeFinding({
    ruleId,
    severity: issue.severity,
    file,
    message: `${issue.path}: ${issue.message}`,
    // Keep fingerprints stable across display languages and copy edits.
    fp: `direction:${issue.code}:${issue.path}`,
    fix: issue.fix,
    evidence: issue.path,
    meta: { path: issue.path, issueCode: issue.code },
  });
}

function short(hash) { return hash ? String(hash).slice(0, 8) : '(none)'; }
