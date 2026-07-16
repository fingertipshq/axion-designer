/* ============================================================
   report — 把同一份帳本渲染成 terminal、JSON、HTML、SARIF 與 summary。
   零依賴。
   ============================================================ */
import { getRule, ruleTitle, ruleWhy, ruleFix } from './finding.mjs';
import { fingerprint } from './ledger.mjs';
import { LANG, pick } from './i18n.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

let PACKAGE_META = {};
try { PACKAGE_META = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')); }
catch { /* reporters still work from copied/internal builds */ }

// JSON schema 版本涵蓋 gates、baselined 與 configErrors；SARIF driver.version 亦取此常數。
export const REPORT_SCHEMA_VERSION = 2;

// --summary 緊湊機器表面的 schema 標記與 per-rule top-N 上限。
export const SUMMARY_SCHEMA = 'dk-summary/v1';
const SUMMARY_TOP_N = 20;

const REPORT_CSS = `
  :root{--bg:#fbfbfd;--fg:#1d1d1f;--mut:#6e6e73;--card:#fff;--line:#e5e5ea;--ok:#1a7f37;--err:#cf222e;--wrn:#9a6700;--inf:#57606a;--accent:#0071e3}
  @media (prefers-color-scheme:dark){:root{--bg:#0b0b0d;--fg:#f5f5f7;--mut:#98989d;--card:#161618;--line:#2c2c2e;--ok:#3fb950;--err:#ff7b72;--wrn:#d29922;--inf:#8b949e;--accent:#2997ff}}
  :root[data-theme="light"]{--bg:#fbfbfd;--fg:#1d1d1f;--mut:#6e6e73;--card:#fff;--line:#e5e5ea;--ok:#1a7f37;--err:#cf222e;--wrn:#9a6700;--inf:#57606a;--accent:#0071e3}
  :root[data-theme="dark"]{--bg:#0b0b0d;--fg:#f5f5f7;--mut:#98989d;--card:#161618;--line:#2c2c2e;--ok:#3fb950;--err:#ff7b72;--wrn:#d29922;--inf:#8b949e;--accent:#2997ff}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang TC","Microsoft JhengHei",sans-serif}
  .wrap{max-width:820px;margin:0 auto;padding:40px 24px}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}.sub{color:var(--mut);font-size:13px;margin:0 0 24px}
  .summary{font-size:18px;font-weight:600;padding:16px 20px;background:var(--card);border:1px solid var(--line);border-radius:14px;margin-bottom:20px}
  .ok{color:var(--ok)}.err{color:var(--err)}.wrn{color:var(--wrn)}.inf{color:var(--inf)}
  ul.gates{list-style:none;padding:0;margin:0 0 28px;display:grid;gap:8px}
  .gate{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:14px}
  .gate .dot{display:inline-block;width:18px;font-weight:700}.gate.ok .dot{color:var(--ok)}.gate.err .dot{color:var(--err)}.gate.wrn .dot{color:var(--wrn)}.gate.skip{color:var(--mut)}.gate em{font-style:normal;color:var(--mut)}
  .grp{margin:0 0 22px}.grp h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:0 0 10px}
  .find{background:var(--card);border:1px solid var(--line);border-left-width:3px;border-radius:10px;padding:12px 14px;margin-bottom:10px}
  .find.error{border-left-color:var(--err)}.find.warn{border-left-color:var(--wrn)}.find.info{border-left-color:var(--inf)}
  .find-h{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;margin-bottom:6px}
  .sev{text-transform:uppercase;font-weight:700;font-size:11px}.find.error .sev{color:var(--err)}.find.warn .sev{color:var(--wrn)}.find.info .sev{color:var(--inf)}
  .loc{color:var(--fg)}.rid{color:var(--mut);margin-left:auto}
  .msg{font-size:14px}.fix{font-size:13px;color:var(--mut);margin-top:6px}.fix b{color:var(--accent)}
  pre.ev{overflow-x:auto;background:rgba(127,127,127,.08);border-radius:8px;padding:8px 10px;font-size:12px;margin:8px 0 0}
  footer{color:var(--mut);font-size:12px;margin-top:28px;border-top:1px solid var(--line);padding-top:14px}
`;

const isRecord = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const asRecord = (value) => (isRecord(value) ? value : {});
const recordArray = (value) => (Array.isArray(value) ? value.filter(isRecord) : []);
const displayText = (value, fallback = '') => (
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value) : fallback
);
const safeCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const safePosition = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const safeSeverity = (value) => (value === 'error' || value === 'warn' || value === 'info' ? value : 'info');
const safeCounts = (counts) => {
  const source = asRecord(counts);
  return { error: safeCount(source.error), warn: safeCount(source.warn), info: safeCount(source.info) };
};

// Ledger fields can originate in an inspected repository. Strip ANSI/OSC/C1,
// line-rewriting controls, and bidi overrides before adding our own optional
// color codes, so a finding cannot forge terminal output or clickable links.
function terminalText(value) {
  return displayText(value)
    .replace(/\r\n?|\n|\t|\u2028|\u2029/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

const CATEGORY_LABEL = {
  'zh-TW': {
    contract: 'token 契約', direction: 'AI 設計方向', 'ssot-sync': 'SSOT 同步', slop: '反 AI-slop',
    'css-strict': 'CSS strict-value', a11y: '無障礙 (axe)', visual: '視覺回歸', config: '設定健全性',
  },
  en: {
    contract: 'token contract', direction: 'AI design direction', 'ssot-sync': 'SSOT sync', slop: 'anti-AI-slop',
    'css-strict': 'CSS strict-value', a11y: 'accessibility (axe)', visual: 'visual regression', config: 'config sanity',
  },
};
/** 關卡顯示標籤（依 LANG）；未知 id 原樣返回。 */
function catLabel(id) {
  const key = displayText(id, 'unknown');
  const labels = CATEGORY_LABEL[LANG] ?? CATEGORY_LABEL.en;
  return Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : key;
}

// 依 ruleId 前綴把 Finding 歸到某道關卡（顯示分組用）
function gateOf(ruleId) {
  ruleId = displayText(ruleId, 'unknown');
  if (ruleId.startsWith('tokens/ssot')) return 'ssot-sync';
  if (ruleId.startsWith('tokens/')) return 'contract';
  if (ruleId.startsWith('slop/') || ruleId.startsWith('brand/') || ruleId.startsWith('spacing/')) return 'slop';
  if (ruleId.startsWith('css/')) return 'css-strict';
  if (ruleId.startsWith('a11y/')) return 'a11y';
  if (ruleId.startsWith('visual/')) return 'visual';
  if (ruleId.startsWith('config/')) return 'config';
  return ruleId.split('/')[0];
}

/* ---- 顏色（TTY 才上色；尊重 NO_COLOR）---- */
function colorizer(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    red: wrap('31'), green: wrap('32'), yellow: wrap('33'), blue: wrap('34'),
    gray: wrap('90'), bold: wrap('1'), dim: wrap('2'), cyan: wrap('36'),
  };
}

const ICON = { error: '✗', warn: '⚠', info: '·', ok: '✓' };

/**
 * 終端報告 —— 分組、色碼、每個 Finding 附 file:line＋fix＋explain，
 * 並畫出證據流（verifiedPairs 過幾組），結語提醒鏈在把關。
 */
export function renderTerminal(result, config, opts = {}) {
  const useColor = opts.color ?? (process.stdout.isTTY && !process.env.NO_COLOR);
  const c = colorizer(useColor);
  const L = [];
  const source = asRecord(result);
  const findings = recordArray(source.findings);
  const gates = recordArray(source.gates);
  const counts = safeCounts(source.counts);
  const emits = asRecord(source.emits);
  const view = { ...source, findings, gates, counts, emits, filesScanned: safeCount(source.filesScanned) };
  const presetName = terminalText(asRecord(config).presetName);
  const preset = presetName ? c.dim(`· preset:${presetName}`) : '';
  L.push('');
  L.push(`${c.bold('dk verify')} ${preset}`);
  L.push('');

  if (source.fatal === true) {
    for (const f of findings) L.push('  ' + c.red(`${ICON.error} ${terminalText(f.message)}`));
    L.push('');
    return L.join('\n');
  }

  // 每道關卡一行狀態
  const gateStatus = summarizeGates(view);
  for (const g of gates) {
    const id = displayText(g.id, 'unknown');
    const label = terminalText(catLabel(id));
    if (g.status === 'skipped') {
      const reason = terminalText(g.reason);
      L.push('  ' + c.gray(`${ICON.info} ${pad(label)} ` + pick(`跳過（${reason}）`, `skipped (${reason})`)));
      continue;
    }
    const s = gateStatus[id] ?? { error: 0, warn: 0, info: 0 };
    const bad = s.error + s.warn;
    const detail = terminalText(gateDetail(id, emits, s, view));
    if (bad === 0) L.push('  ' + c.green(`${ICON.ok} ${pad(label)}`) + c.dim(detail));
    else if (s.error > 0) L.push('  ' + c.red(`${ICON.error} ${pad(label)}`) + c.dim(detail));
    else L.push('  ' + c.yellow(`${ICON.warn} ${pad(label)}`) + c.dim(detail));
  }

  // 逐 Finding 明細（分組）——terminal 表面每規則預設只展開前 N 筆，其餘折疊成一行誠實計數
  //（總數絕不靜默截斷；--json/--summary/SARIF/HTML 一律完整、不受此上限影響）。--all 或
  // DK_ALL 環境變數展開全部。折疊只丟棄同規則第 N+1 筆起的「逐筆明細行」，不改排序（維持
  // severity→file 全序），亦不改 counts/結語（下方仍讀 result.counts 全量）。
  const showAll = opts.all ?? !!process.env.DK_ALL;
  const CAP = 10;
  const groups = groupBy(findings, (f) => gateOf(f.ruleId));
  for (const [gid, items] of groups) {
    if (!items.length) continue;
    L.push('');
    L.push('  ' + c.bold(terminalText(catLabel(gid))));
    const shownByRule = new Map();  // ruleId -> 已展開筆數
    const hiddenByRule = new Map(); // ruleId -> 被折疊筆數（維持首見順序供折疊行輸出）
    for (const f of items) {
      const ruleId = displayText(f.ruleId, 'unknown');
      const severity = safeSeverity(f.severity);
      const shown = shownByRule.get(ruleId) ?? 0;
      if (showAll || shown < CAP) {
        const sevColor = severity === 'error' ? c.red : severity === 'warn' ? c.yellow : c.gray;
        const file = terminalText(f.file);
        const line = safePosition(f.line);
        const col = safePosition(f.col);
        const loc = file ? `${file}${line ? ':' + line : ''}${col ? ':' + col : ''}` : '(tokens)';
        L.push('     ' + sevColor(`${ICON[severity]} ${loc}`) + '  ' + c.dim(terminalText(ruleId)));
        L.push('        ' + terminalText(f.message));
        if (displayText(f.fix)) L.push('        ' + c.cyan('fix: ') + terminalText(f.fix));
        if (displayText(f.docs)) L.push('        ' + c.gray('run: ' + terminalText(f.docs)));
        shownByRule.set(ruleId, shown + 1);
      } else {
        if (!hiddenByRule.has(ruleId)) hiddenByRule.set(ruleId, 0);
        hiddenByRule.set(ruleId, hiddenByRule.get(ruleId) + 1);
      }
    }
    for (const [ruleId, more] of hiddenByRule) {
      L.push('     ' + c.dim(pick(
        `… 另有 ${more} 筆同規則 ${terminalText(ruleId)}（dk report --json 或 --all 看全部）`,
        `… ${more} more of rule ${terminalText(ruleId)} (dk report --json or --all to see all)`)));
    }
  }

  // 結語
  L.push('');
  const { error, warn, info } = counts;
  const status = reportStatus(view);
  const suppressed = safeCount(source.suppressed);
  const supNote = suppressed ? c.dim(pick(` · ${suppressed} 個經 // dk-ignore 抑制`, ` · ${suppressed} suppressed via // dk-ignore`)) : '';
  // --full 下若有重關卡跳過（缺依賴等），綠燈也要誠實標註「未跑」，不讓綠色蓋掉沒跑的 a11y。
  const HEAVY = new Set(['css-strict', 'a11y', 'visual']);
  const skippedHeavy = gates.filter((g) => g.status === 'skipped' && HEAVY.has(displayText(g.id)));
  const heavyNote = skippedHeavy.length
    ? c.yellow(pick(
        ` · ${skippedHeavy.length} 道重關卡未跑：${skippedHeavy.map((g) => terminalText(g.id)).join('/')}（見上方 reason · dk doctor）`,
        ` · ${skippedHeavy.length} heavy gate(s) not run: ${skippedHeavy.map((g) => terminalText(g.id)).join('/')} (see reason above · dk doctor)`))
    : '';
  if (error + warn + info === 0 && status === 'incomplete') {
    L.push('  ' + c.yellow(`${ICON.warn} ` + pick(
      '管線未完成 — 0 errors, 0 warnings（至少一道要求的關卡未能執行）',
      'Pipeline incomplete — 0 errors, 0 warnings (at least one requested gate could not run)')) + heavyNote);
    L.push('  ' + c.dim(pick(
      `${view.filesScanned} 檔已掃 · 本次結果不是「全數通過」 · tokenHash ${terminalText(short(source.tokenHash))}`,
      `${view.filesScanned} files scanned · this result is not an all-pass · tokenHash ${terminalText(short(source.tokenHash))}`)) + supNote);
  } else if (error + warn + info === 0) {
    L.push('  ' + c.green(`${ICON.ok} ` + pick('全數通過 — 0 errors, 0 warnings', 'All passed — 0 errors, 0 warnings')) + heavyNote);
    L.push('  ' + c.dim(pick(
      `${view.filesScanned} 檔已掃 · ${verifiedCount(emits)} 組對比在淺+深達標 · tokenHash ${terminalText(short(source.tokenHash))}`,
      `${view.filesScanned} files scanned · ${verifiedCount(emits)} contrast pairs pass in light+dark · tokenHash ${terminalText(short(source.tokenHash))}`)) + supNote);
  } else {
    const parts = [];
    if (error) parts.push(c.red(`${error} error${error > 1 ? 's' : ''}`));
    if (warn) parts.push(c.yellow(`${warn} warning${warn > 1 ? 's' : ''}`));
    if (info) parts.push(c.gray(`${info} info`));
    const incompletePrefix = status === 'incomplete'
      ? c.yellow(pick('管線未完成 · ', 'Pipeline incomplete · ')) : '';
    L.push('  ' + incompletePrefix + parts.join(', ') + c.dim(' — the chain caught these before your users did.') + supNote + heavyNote);
  }
  L.push('');
  return L.join('\n');
}

/** JSON 輸出（schema 版本化，供 CI 消費）。 */
export function renderJson(result, config) {
  return JSON.stringify({
    version: REPORT_SCHEMA_VERSION,
    status: reportStatus(result),
    preset: config?.presetName,
    tokenHash: result.tokenHash,
    direction: directionSurface(result),
    proof: appProofSurface(result),
    exitCode: result.exitCode,
    counts: result.counts,
    filesScanned: result.filesScanned,
    cacheHits: result.cacheHits ?? 0, // per-file 快取本次還原檔數；--no-cache 或冷跑為 0。
    suppressed: result.suppressed ?? 0,
    baselined: result.baselined ?? 0,
    // 機器表面必須完整暴露被跳過的關卡及 reason，避免把 incomplete 誤讀為 passed。
    gates: summarizeGatesSurface(result.gates),
    // config 壞掉時走 config.errors 旁路、不進 findings 管線；此處以獨立欄位表達，讓
    // 機器消費者看得到「這次 run 其實 config 就有錯」（terminal 仍走 stderr，行為不變）。
    configErrors: summarizeConfigErrorsSurface(result.configErrors),
    findings: result.findings.map((f) => ({
      ruleId: f.ruleId, severity: f.severity, file: f.file, line: f.line, col: f.col,
      message: f.message, fix: f.fix, evidence: f.evidence,
      ...(f.meta ? { meta: f.meta } : {}),
    })),
  }, null, 2) + '\n';
}

/** 關卡狀態（機器表面）：只保留穩定欄位，與帳本 gates 一致。 */
function summarizeGatesSurface(gates) {
  return (gates ?? []).map((g) => ({
    id: g.id,
    status: g.status,
    ...(g.reason ? { reason: g.reason } : {}),
    ...(g.kind ? { kind: g.kind } : {}),
    ...(g.attempted != null ? { attempted: !!g.attempted } : {}),
    ...(g.blocking != null ? { blocking: !!g.blocking } : {}),
    ...(g.auxiliary ? { auxiliary: true } : {}),
  }));
}
/** config 健全性錯誤（機器表面）：ruleId + severity + message + fix，皆穩定欄位。 */
function summarizeConfigErrorsSurface(errs) {
  return (errs ?? []).map((e) => ({
    ruleId: e.ruleId, severity: e.severity ?? 'error', message: e.message, fix: e.fix ?? null,
  }));
}

/**
 * --summary —— 欄位穩定且約 10KB 的機器表面，不含逐筆 findings，
 * 避免大型 repo 的完整 JSON 超過子程序 maxBuffer。
 * per-rule 計數只列 top-N；超出折疊為 other 並給「總數」——不可靜默截斷。
 */
export function renderSummary(result, config) {
  const findings = result.findings ?? [];
  const truncation = { strings: 0, configErrors: 0, gates: 0 };
  const clip = (value, bytes) => clipSummaryString(value, bytes, truncation);

  // per-gate findingCount：以最終（過濾後）findings 依 gateOf 分組計數，
  // 狀態/reason/auxiliary 取自帳本 gates——與 terminal / html 呈現同源。
  const byGateCount = new Map();
  for (const f of findings) {
    const g = gateOf(f.ruleId);
    byGateCount.set(g, (byGateCount.get(g) ?? 0) + 1);
  }
  const allGates = result.gates ?? [];
  const gates = allGates.slice(0, 16).map((g) => ({
    id: clip(g.id, 96),
    status: clip(g.status, 48),
    ...(g.reason ? { reason: clip(g.reason, 160) } : {}),
    ...(g.kind ? { kind: clip(g.kind, 64) } : {}),
    ...(g.attempted != null ? { attempted: !!g.attempted } : {}),
    ...(g.blocking != null ? { blocking: !!g.blocking } : {}),
    ...(g.auxiliary ? { auxiliary: true } : {}),
    findingCount: byGateCount.get(g.id) ?? 0,
  }));
  truncation.gates = Math.max(0, allGates.length - gates.length);

  // per-rule 計數 → top-N（次數降冪、同次數以 ruleId 穩定排序）。超出折疊 other（含類數與總筆數）。
  const byRule = new Map();
  for (const f of findings) byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1);
  const ranked = [...byRule.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const top = ranked.slice(0, SUMMARY_TOP_N).map(([ruleId, count]) => ({ ruleId: clip(ruleId, 120), count }));
  const rest = ranked.slice(SUMMARY_TOP_N);
  const rules = { top };
  if (rest.length) {
    // other 給總數：折疊的規則數與其筆數合計——machine 消費者據此確認「沒有被靜默截斷」。
    rules.other = { rules: rest.length, count: rest.reduce((n, [, c]) => n + c, 0) };
  }

  const direction = directionSurface(result);
  for (const key of ['status', 'name', 'hash', 'bindingHash', 'baselineHash', 'baselineBindingHash', 'approvalStatus', 'approvalHeadHash']) {
    if (typeof direction[key] === 'string') direction[key] = clip(direction[key], key === 'name' ? 128 : 96);
  }
  const allConfigErrors = summarizeConfigErrorsSurface(result.configErrors);
  const configErrors = allConfigErrors.slice(0, 4).map((error) => ({
    ruleId: clip(error.ruleId, 96), severity: clip(error.severity, 32),
    message: clip(error.message, 192), fix: error.fix == null ? null : clip(error.fix, 192),
  }));
  truncation.configErrors = Math.max(0, allConfigErrors.length - configErrors.length);

  const payload = {
    schema: SUMMARY_SCHEMA,
    status: reportStatus(result),
    exitCode: result.exitCode,
    tokenHash: clip(result.tokenHash, 96),
    direction,
    proof: appProofSurface(result, true),
    preset: clip(config?.presetName, 64),
    full: !!result.full,
    filesScanned: result.filesScanned ?? 0,
    // per-file 快取本次還原的檔數；可直接觀測增量掃描，不依賴牆鐘時間。
    cacheHits: result.cacheHits ?? 0,
    counts: result.counts,               // 與 --json 的 counts 同源、必然一致
    suppressed: result.suppressed ?? 0,  // // dk-ignore 抑制數
    baselined: result.baselined ?? 0,    // baseline 接受清單消音數
    configErrors,
    gates,
    rules,
  };
  if (truncation.strings || truncation.configErrors || truncation.gates) {
    payload.truncated = { ...truncation };
  }
  let rendered = JSON.stringify(payload, null, 2) + '\n';
  // The targeted bounds above keep normal output well below 10 KiB. This
  // emergency path protects the public contract even when a future field adds
  // unbounded data: preserve counts/status, reduce display-only detail, and say
  // explicitly that compaction happened.
  if (Buffer.byteLength(rendered) >= 10 * 1024) {
    const removedRules = payload.rules.top.slice(10);
    payload.rules.top = payload.rules.top.slice(0, 10).map((entry) => ({ ...entry, ruleId: clip(entry.ruleId, 72) }));
    payload.rules.other = {
      rules: (payload.rules.other?.rules ?? 0) + removedRules.length,
      count: (payload.rules.other?.count ?? 0) + removedRules.reduce((sum, entry) => sum + entry.count, 0),
    };
    payload.configErrors = payload.configErrors.slice(0, 2).map((error) => ({
      ...error, message: clip(error.message, 96), fix: error.fix == null ? null : clip(error.fix, 96),
    }));
    payload.gates = payload.gates.map((gate) => ({ ...gate, ...(gate.reason ? { reason: clip(gate.reason, 80) } : {}) }));
    payload.truncated = { ...truncation, emergency: true };
    rendered = JSON.stringify(payload, null, 2) + '\n';
  }
  return rendered;
}

function clipSummaryString(value, maxBytes, truncation) {
  if (value == null) return value;
  const text = String(value);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const suffix = `…#${createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  let prefix = Buffer.from(text).subarray(0, budget).toString('utf8');
  while (prefix.endsWith('\uFFFD')) prefix = prefix.slice(0, -1);
  truncation.strings++;
  return prefix + suffix;
}

/** SARIF 2.1.0 —— 接 GitHub code scanning。ruleId → registry metadata。 */
export function renderSarif(result, config) {
  const findings = result.findings ?? [];
  const ruleIndex = new Map();
  const rules = [];
  for (const f of findings) {
    if (ruleIndex.has(f.ruleId)) continue;
    ruleIndex.set(f.ruleId, rules.length);
    const meta = getRule(f.ruleId);
    // 規則 metadata 依 LANG 渲染（title/why/fix 為雙語）；指紋（partialFingerprints）語言中性、不受影響。
    rules.push({
      id: f.ruleId,
      name: ruleTitle(meta) ?? f.ruleId,
      shortDescription: { text: ruleTitle(meta) ?? f.ruleId },
      fullDescription: { text: ruleWhy(meta) ?? ruleTitle(meta) ?? f.ruleId },
      help: { text: ruleFix(meta) ?? '' },
      defaultConfiguration: { level: sarifLevel(meta?.severity ?? f.severity) },
      properties: { category: meta?.category ?? gateOf(f.ruleId) },
    });
  }
  const results = findings.map((f) => ({
    ruleId: f.ruleId,
    ruleIndex: ruleIndex.get(f.ruleId),
    level: sarifLevel(f.severity),
    message: { text: f.fix ? `${f.message}\nfix: ${f.fix}` : f.message },
    locations: f.file ? [{
      physicalLocation: {
        artifactLocation: { uri: f.file },
        region: f.line ? { startLine: f.line, startColumn: f.col ?? 1 } : undefined,
      },
    }] : [],
    // partialFingerprints：GitHub code scanning 用它跨「行號漂移」追蹤同一 alert（否則行號一變
    // 就重複開關）。用 ledger 統一 fingerprint（ruleId|file|message），與 baseline 身分同源。
    partialFingerprints: { 'dkFingerprint/v1': fingerprint(f) },
    ...((f.evidence || f.meta) ? { properties: {
      ...(f.evidence ? { evidence: f.evidence } : {}),
      ...(f.meta ? { dkMeta: f.meta } : {}),
    } } : {}),
  }));
  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'dk', informationUri: packageInformationUri(), version: PACKAGE_META.version ?? '0.0.0', rules } },
      results,
      properties: { tokenHash: result.tokenHash, directionHash: result.directionHash ?? null,
        directionLocked: result.emits?.directionLocked ?? null, counts: result.counts, preset: config?.presetName,
        status: reportStatus(result) },
    }],
  };
  return JSON.stringify(sarif, null, 2) + '\n';
}
function sarifLevel(sev) { return sev === 'error' ? 'error' : sev === 'warn' ? 'warning' : 'note'; }

/** HTML —— 可分享、自包含、light+dark 自適應的 PR 產物。內聯 CSS、零外部資源。 */
export function renderHtml(result, config) {
  const source = asRecord(result);
  const findings = recordArray(source.findings);
  const gates = recordArray(source.gates);
  const counts = safeCounts(source.counts);
  const emits = asRecord(source.emits);
  const view = { ...source, findings, gates, counts, emits, filesScanned: safeCount(source.filesScanned) };
  const { error, warn, info } = counts;
  const total = error + warn + info;
  const status = reportStatus(view);
  const green = total === 0 && status === 'passed';
  const preset = displayText(asRecord(config).presetName, 'recommended');
  const verifiedPairs = Array.isArray(emits.verifiedPairs) ? emits.verifiedPairs : [];
  const esc = escapeHtml;
  const gateSummary = summarizeGates(view);

  const gateRows = gates.map((g) => {
    const id = displayText(g.id, 'unknown');
    const label = catLabel(id);
    const gateState = displayText(g.status);
    if (gateState === 'skipped') {
      const reason = displayText(g.reason);
      return `<li class="gate skip"><span class="dot">○</span> ${esc(label)} <em>${esc(pick(`跳過（${reason}）`, `skipped (${reason})`))}</em></li>`;
    }
    if (gateState !== 'ran') {
      return `<li class="gate skip"><span class="dot">○</span> ${esc(label)} <em>${esc(pick('狀態無效', 'invalid status'))}</em></li>`;
    }
    const s = gateSummary[id] ?? { error: 0, warn: 0 };
    const bad = (s.error ?? 0) + (s.warn ?? 0);
    const cls = bad === 0 ? 'ok' : s.error ? 'err' : 'wrn';
    const mark = bad === 0 ? '✓' : s.error ? '✗' : '⚠';
    return `<li class="gate ${cls}"><span class="dot">${esc(mark)}</span> ${esc(label)}</li>`;
  }).join('\n');

  const groups = groupBy(findings, (f) => gateOf(f.ruleId));
  let findingsHtml = '';
  for (const [gid, items] of groups) {
    if (!items.length) continue;
    findingsHtml += `<section class="grp"><h3>${esc(catLabel(gid))}</h3>`;
    for (const f of items) {
      const severity = safeSeverity(f.severity);
      const file = displayText(f.file);
      const line = safePosition(f.line);
      const col = safePosition(f.col);
      const loc = file ? `${file}${line ? ':' + line : ''}${col ? ':' + col : ''}` : '(tokens)';
      const fix = displayText(f.fix);
      const evidence = displayText(f.evidence);
      findingsHtml += `<div class="find ${severity}">
        <div class="find-h"><span class="sev">${esc(severity)}</span><code class="loc">${esc(loc)}</code><span class="rid">${esc(displayText(f.ruleId, 'unknown'))}</span></div>
        <div class="msg">${esc(displayText(f.message))}</div>
        ${fix ? `<div class="fix"><b>fix</b> ${esc(fix)}</div>` : ''}
        ${evidence ? `<pre class="ev">${esc(evidence)}</pre>` : ''}
      </div>`;
    }
    findingsHtml += `</section>`;
  }

  const summary = green
    ? `<span class="ok">✓ ${esc(pick('全數通過', 'All passed'))}</span> — 0 errors, 0 warnings`
    : status === 'incomplete'
      ? `<span class="wrn">⚠ ${esc(pick('管線未完成', 'Pipeline incomplete'))}</span> — ${esc(error)} errors, ${esc(warn)} warnings${info ? `, ${esc(info)} info` : ''}`
      : [error && `<span class="err">${esc(error)} error${error > 1 ? 's' : ''}</span>`, warn && `<span class="wrn">${esc(warn)} warning${warn > 1 ? 's' : ''}</span>`, info && `<span class="inf">${esc(info)} info</span>`].filter(Boolean).join(', ');

  const styleHash = createHash('sha256').update(REPORT_CSS).digest('base64');
  const csp = `default-src 'none'; script-src 'none'; style-src 'sha256-${styleHash}'; style-src-attr 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const emptyMessage = status === 'incomplete'
    ? pick('沒有 Finding，但至少一道要求的關卡未完成；這不是全數通過。', 'No findings, but at least one requested gate was incomplete; this is not an all-pass.')
    : pick('沒有 Finding — 這條鏈在你的使用者之前就把關了。', 'No findings — the chain caught them before your users did.');

  return `<!doctype html>
<html lang="${esc(pick('zh-Hant', 'en'))}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pick('dk verify — 報告', 'dk verify — report'))}</title>
<style>${REPORT_CSS}</style></head><body><div class="wrap">
  <h1>dk verify</h1>
  <p class="sub">preset:${esc(preset)} · ${esc(pick(
    `${view.filesScanned} 檔已掃 · ${verifiedPairs.length} 組對比達標`,
    `${view.filesScanned} files scanned · ${verifiedPairs.length} contrast pairs pass`))} · tokenHash ${esc(short(source.tokenHash))}</p>
  <div class="summary">${summary}</div>
  <ul class="gates">${gateRows}</ul>
  ${findingsHtml || `<p class="sub">${esc(emptyMessage)}</p>`}
  <footer>the chain caught these before your users did · ${esc(pick('dk — AI UI 導演 + 可證明的設計品質', 'dk — AI UI direction + provable design quality'))}</footer>
</div></body></html>
`;
}

function escapeHtml(s) {
  return displayText(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 相容性錯誤型別，供呼叫端辨識不可用的報告表面。 */
export class ReportSurfaceUnavailable extends Error {
  constructor(surface) {
    super(`report surface '${surface}' 不可用。`);
    this.surface = surface;
  }
}

/* ---- helpers ---- */
function reportStatus(result) {
  const source = asRecord(result);
  if (source.status === 'passed' || source.status === 'failed' || source.status === 'incomplete') return source.status;
  if (source.status != null || (source.gates != null && !Array.isArray(source.gates))) return 'incomplete';
  const counts = safeCounts(source.counts);
  if (counts.error > 0 || (safeCount(source.exitCode) > 0 && counts.warn > 0)) return 'failed';
  const gates = recordArray(source.gates);
  if (gates.some((g) => g.status !== 'ran' && g.status !== 'skipped')) return 'incomplete';
  const attemptedSkip = gates.some((g) =>
    g.status === 'skipped' && g.attempted !== false && !g.auxiliary);
  return attemptedSkip ? 'incomplete' : 'passed';
}

/** 穩定、有界的 AI direction 機器表面；不暴露其他 gate 的內部 emits。 */
function directionSurface(result) {
  const emits = result.emits ?? {};
  return {
    status: emits.directionStatus ?? 'absent',
    name: emits.directionName ?? null,
    hash: result.directionHash ?? emits.directionHash ?? null,
    bindingHash: emits.directionBindingHash ?? null,
    locked: emits.directionLocked ?? false,
    baselineHash: emits.directionBaselineHash ?? null,
    baselineBindingHash: emits.directionBaselineBindingHash ?? null,
    approvalStatus: emits.directionApprovalStatus ?? 'absent',
    approvalCount: emits.directionApprovalCount ?? 0,
    approvalHeadHash: emits.directionApprovalHeadHash ?? null,
  };
}
function appProofSurface(result, compact = false) {
  const emits = result.emits ?? {};
  if (!emits.appProofCoverage && !emits.appProofSummary && !emits.appProofArtifact) return null;
  const coverage = emits.appProofCoverage ?? null;
  const compactCoverage = coverage && compact ? {
    routes: Array.isArray(coverage.routes) ? coverage.routes.length : 0,
    states: Array.isArray(coverage.states) ? coverage.states.length : 0,
    viewports: Array.isArray(coverage.viewports) ? coverage.viewports.length : 0,
    themes: Array.isArray(coverage.themes) ? coverage.themes.length : 0,
    plannedCases: coverage.plannedCases ?? null,
    completedCases: coverage.completedCases ?? null,
    failedCases: coverage.failedCases ?? null,
    screenshotCases: coverage.screenshotCases ?? null,
  } : coverage;
  return {
    discovery: emits.appProofDiscovery ?? null,
    coverage: compactCoverage,
    summary: compact && emits.appProofSummary ? {
      cases: emits.appProofSummary.cases ?? null,
      failed: emits.appProofSummary.failed ?? null,
      violations: emits.appProofSummary.violations ?? null,
    } : (emits.appProofSummary ?? null),
    artifact: emits.appProofArtifact ?? null,
  };
}
function packageInformationUri() {
  const raw = PACKAGE_META.homepage ?? PACKAGE_META.repository?.url ?? '';
  if (!raw || /OWNER/i.test(raw)) return 'https://www.npmjs.com/package/axion-designer';
  return String(raw).replace(/^git\+/, '').replace(/\.git(?:#.*)?$/, '');
}
function summarizeGates(result) {
  const status = Object.create(null);
  for (const f of recordArray(asRecord(result).findings)) {
    const g = gateOf(f.ruleId);
    const severity = safeSeverity(f.severity);
    (status[g] ??= { error: 0, warn: 0, info: 0 })[severity]++;
  }
  return status;
}
function gateDetail(id, emits, s, result) {
  if (id === 'contract') {
    const vp = Array.isArray(emits.verifiedPairs) ? emits.verifiedPairs : [];
    if (s.error) return '  ' + pick(`${s.error} 組對比/契約未過`, `${s.error} contrast/contract pair(s) failed`);
    // 現跑時 emits.manifest 是完整物件(.count)；由 .dk/report.json 還原時是摘要(.tokenCount)。
    const manifest = asRecord(emits.manifest);
    const tokenCount = safeCount(manifest.count ?? manifest.tokenCount);
    return '  ' + pick(`${vp.length} 組對比達標（淺+深）· ${tokenCount} tokens`, `${vp.length} contrast pairs pass (light+dark) · ${tokenCount} tokens`);
  }
  if (id === 'direction') {
    if (emits.directionStatus === 'absent') return '  ' + pick('尚未啟用', 'not enabled');
    const directionName = displayText(emits.directionName);
    const name = directionName ? `· ${directionName}` : '';
    const lock = emits.directionLocked === true ? pick('· Taste Lock 已驗證', '· Taste Lock verified')
      : emits.directionStatus === 'draft' ? pick('· 探索中', '· exploring')
        : pick('· 未鎖定', '· unlocked');
    return `  ${name} ${lock}${result.directionHash ? ` · ${short(result.directionHash)}` : ''}`;
  }
  if (id === 'ssot-sync') return '  ' + (s.error ? pick('產物與 SSOT 不同步', 'artifact out of sync with the SSOT') : pick('tokens.css 與 SSOT 同步', 'tokens.css in sync with the SSOT'));
  if (id === 'slop') {
    const used = Array.isArray(emits.usedTokens) ? emits.usedTokens.length : 0;
    return '  ' + (s.error + s.warn
      ? pick(`${s.error + s.warn} 個發現`, `${s.error + s.warn} findings`)
      : pick(`${safeCount(result.filesScanned)} 檔已掃 · 用到 ${used} 個 token`, `${safeCount(result.filesScanned)} files scanned · ${used} tokens used`));
  }
  return '';
}
function verifiedCount(emits) { return Array.isArray(emits.verifiedPairs) ? emits.verifiedPairs.length : 0; }
function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of (Array.isArray(arr) ? arr : [])) { const k = keyFn(x); (m.get(k) ?? m.set(k, []).get(k)).push(x); }
  return m;
}
function pad(s) { return displayText(s).padEnd(16, ' '); }
function short(h) { const text = displayText(h); return text ? text.slice(0, 8) : '—'; }
