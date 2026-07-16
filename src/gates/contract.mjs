/* ============================================================
   token 契約 ＋ SSOT 同步 —— 兩道零依賴關卡，向下游播出證據。
   contract：結構（leaf 有非空 $value）、命名（kebab-case/純數字）、
             必要 token 齊全、WCAG/APCA 對比 pair 在淺+深都達標。
             EMIT: verifiedPairs / unsafePairs / tokenHash / manifest
   ssot-sync：compile(tokens).css 對照磁碟 tokens.css，不同步 -> 單一 Finding。
   ============================================================ */
import { readFileSync } from 'node:fs';
import { makeFinding } from '../core/finding.mjs';
import { fmsg, pick } from '../core/i18n.mjs';
import { isLeaf, walkLeaves, compile, contrast as wcag, apca } from '../core/tokens.mjs';

// 內建必要語意 token；config.requiredTokens 可擴充。
const REQUIRED = [
  'color.text.primary', 'color.text.secondary', 'color.text.on-accent',
  'color.surface.page', 'color.brand.accent',
  'color.state.positive', 'color.state.negative',
  'space.4', 'radius.md', 'shadow.card', 'font.family.base', 'font.size.base',
];

// 內建必過對比組合。門檻隨演算法宣告——WCAG 是比值、APCA 是感知對比 Lc，兩者非線性、
// 不可拿同一個數字互當；故每組同時給 [fg, bg, wcagMin, apcaMin]，跑時依 algorithm 取對應門檻。
// APCA Lc 對應依 APCA 通用查找表（Bronze simple lookup）的近似 WCAG2 等值建議：
//   WCAG 4.5:1 → Lc 60（內文／較大字最低可讀）
//   WCAG 3.0:1 → Lc 45（大字／UI 元件最低）
//   WCAG 7.0:1 → Lc 75（成段內文建議底線，如日後新增 7.0 組別時採用）
// config.contrast.pairs 可擴充（[fg, bg, min]，min 語意隨 algorithm，見下方迴圈與 docs/rules.md）。
const PAIRS = [
  ['color.text.primary', 'color.surface.page', 4.5, 60],
  ['color.text.secondary', 'color.surface.page', 4.5, 60],
  ['color.text.muted', 'color.surface.page', 3.0, 45],
  ['color.text.on-accent', 'color.brand.accent', 4.5, 60],
  ['color.text.link', 'color.surface.page', 4.5, 60],
];

// 只沿 own property 下探（hasOwnProperty）——required/pair 的 dotPath 絕不解析到 prototype 鏈上
// 的繼承屬性（與 tokens.mjs 的 nodeAt 一致，防原型污染 read 端誘導）。
const nodeAt = (tokens, dotPath) =>
  dotPath.split('.').reduce(
    (o, k) => (o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null ? o[k] : undefined),
    tokens);

export function contractGate(ctx) {
  const { tokens, manifest, resolve, config } = ctx;
  const findings = [];
  const rel = relTokensPath(ctx);

  /* 1 + 2 — 結構與命名 */
  (function walk(o, path) {
    for (const k of Object.keys(o)) {
      if (k.startsWith('$')) continue;
      const p = [...path, k];
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(k) && !/^\d+$/.test(k)) {
        findings.push(makeFinding({
          ruleId: 'tokens/naming', file: rel,
          ...fmsg('contract.naming', { path: p.join('.') }),
          evidence: p.join('.'),
        }));
      }
      const node = o[k];
      if (isLeaf(node)) {
        if (node.$value === undefined || node.$value === '') {
          findings.push(makeFinding({
            ruleId: 'tokens/structure', file: rel,
            ...fmsg('contract.emptyValue', { path: p.join('.') }), evidence: p.join('.'),
          }));
        }
      } else if (node && typeof node === 'object') walk(node, p);
    }
  })(tokens, []);

  /* 2b — alias 可解性（淺/深各自追完整 chain）與 CSS variable 命名唯一性。
     buildManifest 是唯一 resolver；gate 只把其結構化診斷翻成 Finding，
     避免「編譯用一套邏輯、驗證又用另一套」。 */
  for (const issue of manifest.aliasIssues ?? []) {
    if (issue.kind === 'cycle') {
      const cycle = (issue.cycle ?? issue.chain ?? []).join(' → ');
      findings.push(makeFinding({
        ruleId: 'tokens/alias-cycle', file: rel,
        ...fmsg('contract.aliasCycle', { token: issue.token, mode: issue.mode, cycle }),
        evidence: cycle,
        meta: issue,
      }));
    } else {
      findings.push(makeFinding({
        ruleId: 'tokens/unresolved-alias', file: rel,
        ...fmsg('contract.unresolvedAlias', { token: issue.token, mode: issue.mode, ref: issue.ref }),
        evidence: (issue.chain ?? []).join(' → '),
        meta: issue,
      }));
    }
  }
  for (const collision of manifest.collisions ?? []) {
    findings.push(makeFinding({
      ruleId: 'tokens/css-var-collision', file: rel,
      ...fmsg('contract.cssVarCollision', { cssVar: collision.cssVar, paths: collision.paths.join(' / ') }),
      evidence: `${collision.cssVar} ← ${collision.paths.join(', ')}`,
      meta: collision,
    }));
  }

  /* 3 — 必要 token */
  const required = [...new Set([...REQUIRED, ...(config.requiredTokens ?? [])])];
  for (const r of required) {
    if (!isLeaf(nodeAt(tokens, r))) {
      findings.push(makeFinding({
        ruleId: 'tokens/required', file: rel,
        ...fmsg('contract.required', { token: r }), evidence: r,
      }));
    }
  }

  /* 4 — 對比（淺+深）；通過的當 verifiedPairs 播出、不足的當 unsafePairs */
  const algorithm = config.contrast?.algorithm ?? 'wcag';
  const isApca = algorithm === 'apca';
  const modes = config.contrast?.modes ?? ['light', 'dark'];
  // 內建 PAIRS 依演算法選擇 WCAG 比值或 APCA Lc，兩種單位不可混用。
  // config.contrast.pairs 為 [fg, bg, min]：algorithm='wcag' 時 min 是比值、='apca' 時 min 是 Lc；
  // 照原樣併入，由下方以正確門檻量測——兩邊此時皆為同一演算法的單位，可直接比大小。
  const builtin = PAIRS.map(([fg, bg, wcagMin, apcaMin]) => [fg, bg, isApca ? apcaMin : wcagMin]);
  // 內建 ∪ config：同一 fg|bg 去重（保留最嚴 min），避免 config 覆蓋內建組合時重複量測/計數。
  const pairs = dedupePairs([...builtin, ...(config.contrast?.pairs ?? [])]);
  const measure = isApca ? apca : wcag;
  const verifiedPairs = [];
  const unsafePairs = [];
  const skippedPairs = []; // { fg, bg, mode, reason }——被跳過但「使用者以為驗了」的 pair，可見記錄

  for (const mode of modes) {
    for (const [fg, bg, min] of pairs) {
      const f = resolve(fg, mode), b = resolve(bg, mode);
      // 無法量測的 pair 必須記錄 reason，不能被視為已驗證。
      if (f == null || b == null) { skippedPairs.push({ fg, bg, mode, reason: 'missing-token' }); continue; }
      const value = measure(f, b);
      if (value == null) { skippedPairs.push({ fg, bg, mode, reason: 'non-hex' }); continue; }
      const entry = { fg, bg, mode, value: round(value), min, algorithm };
      if (value < min) {
        unsafePairs.push(entry);
        findings.push(makeFinding({
          ruleId: 'tokens/contrast', file: rel,
          ...fmsg('contract.contrast', { valueFmt: fmt(value, algorithm), min, fg, bg, mode }),
          evidence: `${f} on ${b}`,
          meta: entry,
        }));
      } else {
        verifiedPairs.push(entry);
      }
    }
  }

  // 跳過的 pair 以 info 級 Finding 可見列出（不進 verifiedPairs、不擋關，但絕不無聲蒸發）。
  // 跨 mode 依 fg|bg|reason 去重（缺 token 與 mode 無關，一組報一次）。
  const skipSeen = new Set();
  for (const sp of skippedPairs) {
    const key = `${sp.fg}|${sp.bg}|${sp.reason}`;
    if (skipSeen.has(key)) continue;
    skipSeen.add(key);
    const reasonZh = sp.reason === 'missing-token'
      ? '引用的 token 不存在（缺 fg 或 bg——如非 REQUIRED 的語意 token muted/link 未定義時）'
      : '解析值非 hex（rgba/named/漸層等 WCAG/APCA 數學無法量測的值）';
    const reasonEn = sp.reason === 'missing-token'
      ? 'a referenced token does not exist (missing fg or bg — e.g. a non-REQUIRED semantic token like muted/link is undefined)'
      : 'resolved value is not hex (rgba/named/gradient — a value WCAG/APCA math cannot measure)';
    const zh = `對比 pair ${sp.fg} on ${sp.bg} 未被驗證（跳過）：${reasonZh}。此組不列入 verifiedPairs。`;
    const en = `Contrast pair ${sp.fg} on ${sp.bg} was not verified (skipped): ${reasonEn}. It is not counted in verifiedPairs.`;
    findings.push(makeFinding({
      ruleId: 'tokens/contrast-skipped', severity: 'info', file: rel, line: null, col: null,
      message: pick(zh, en), fp: zh,
      fix: pick('若此組該被把關：把缺的 token 補上 hex 值（或從 config.contrast.pairs 移除不需要的組合）。',
        'If this pair should be enforced: define the missing token with a hex value (or drop the unneeded pair from config.contrast.pairs).'),
      meta: { fg: sp.fg, bg: sp.bg, reason: sp.reason, algorithm },
    }));
  }

  return {
    findings,
    emits: {
      verifiedPairs,
      unsafePairs,
      skippedPairs,
      tokenHash: manifest.tokenHash,
      manifest,
    },
  };
}

export function ssotSyncGate(ctx) {
  const { tokens, config } = ctx;
  const findings = [];
  const cssPath = config.output?.css;
  if (!cssPath) return { findings }; // 沒設定 CSS 產物就不檢查

  const { css } = compile(tokens, { formats: ['css'] });
  let disk = '';
  try { disk = readFileSync(cssPath, 'utf8'); } catch { disk = null; }

  if (disk == null) {
    findings.push(makeFinding({
      ruleId: 'tokens/ssot-sync', file: relFrom(config, cssPath),
      ...fmsg('ssot.missing'),
    }));
  } else if (disk !== css) {
    findings.push(makeFinding({
      ruleId: 'tokens/ssot-sync', file: relFrom(config, cssPath),
      ...fmsg('ssot.drift', { file: relFrom(config, cssPath) }),
    }));
  }
  return { findings };
}

/* ---- 小工具 ---- */
// 去重對比組合：以 fg|bg 為鍵，保留最嚴（最大 min）。共用於 contract 關卡與 dk tokens contrast。
export function dedupePairs(pairs) {
  const byKey = new Map();
  for (const [fg, bg, min] of pairs ?? []) {
    const key = `${fg}|${bg}`;
    const prev = byKey.get(key);
    if (!prev || min > prev[2]) byKey.set(key, [fg, bg, min]);
  }
  return [...byKey.values()];
}
function round(v) { return Math.round(v * 100) / 100; }
function fmt(v, algo) { return algo === 'apca' ? `Lc ${v.toFixed(1)}` : `${v.toFixed(2)}:1`; }
function relFrom(config, abs) {
  if (!abs) return null;
  const c = config.cwd ?? process.cwd();
  return abs.startsWith(c) ? abs.slice(c.length + 1) : abs;
}
function relTokensPath(ctx) { return relFrom(ctx.config, ctx.config.tokensPath); }
