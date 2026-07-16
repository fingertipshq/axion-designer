/* ============================================================
   共用 DTCG token 引擎。build 命令、contract 關卡、slop 關卡三方共用。
   - loadTokens：讀 tokens.json
   - buildManifest：攤平淺/深具體值 ＋ 算 tokenHash ＋ 產 CSS-var 對照
   - resolve：追 {alias}、套 dark、防環
   - compile：DTCG -> CSS（與 design/build-tokens.mjs 位元組相同）＋可選 js/json
   - contrast / apca：對比數學
   零依賴（僅 node:fs / node:crypto）。
   ============================================================ */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function loadTokens(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const isLeaf = (o) => o && typeof o === 'object' && '$value' in o;

// 原型污染防護：這三個 key 一旦成為「動態寫入路徑」的一段，會改寫 Object.prototype / 綁到
// constructor，匯入他人 token 檔即可注入（真實攻擊向量，見 SECURITY.md）。所有以外部 key 作
// 動態走訪／寫入的點（walkTS / setDeep / walkLeaves / nodeAt）一律拒絕這些 key；被拒者由匯入層
// 可見列出（不靜默）。JSON.parse 會把字面 "__proto__" 建成 own property（defineProperty 語意），
// 故 Object.keys 看得到、可在走訪時攔下。
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isDangerousKey = (k) => DANGEROUS_KEYS.has(k);

// Token paths are emitted as CSS custom-property identifiers. Keep the public
// dot-path/name mapping byte-for-byte for normal DTCG names, but reject syntax
// that could terminate the declaration or create another CSS rule. Non-ASCII
// names remain valid; punctuation with CSS structure semantics does not.
const CSS_IDENT_SEGMENT_RE = /^[-_a-zA-Z0-9\u0080-\u{10ffff}]+$/u;
function assertCssIdentifierPath(path) {
  if (!Array.isArray(path) || path.length === 0) {
    throw new DkTokenError('token path must contain at least one CSS-safe segment.');
  }
  for (const segment of path) {
    if (typeof segment !== 'string' || !segment || !CSS_IDENT_SEGMENT_RE.test(segment)) {
      throw new DkTokenError(`token path segment ${JSON.stringify(segment)} cannot be represented safely as a CSS custom-property identifier; use letters, numbers, "-", "_", or non-ASCII letters.`);
    }
  }
}

function cssVarForPath(path) {
  assertCssIdentifierPath(path);
  return `--${path.join('-')}`;
}

// A DTCG string may legitimately contain spaces, quotes, commas, functions,
// data URLs, or semicolons inside a quoted/balanced construct. Parse just
// enough CSS token structure to preserve those values while rejecting a
// top-level declaration terminator, an unmatched block closer, or malformed
// string/comment syntax that could escape the generated custom property.
function assertCssDeclarationValue(value) {
  const source = String(value ?? '');
  const stack = [];
  let quote = null;
  let comment = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    const code = source.charCodeAt(i);
    if (code === 0 || (code < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== '\f') || code === 0x7f) {
      throw new DkTokenError('CSS token value contains a forbidden control character.');
    }

    if (comment) {
      if (ch === '*' && next === '/') { comment = false; i++; }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        if (i + 1 >= source.length) throw new DkTokenError('CSS token value ends with an incomplete escape.');
        i++;
        continue;
      }
      if (ch === '\n' || ch === '\r' || ch === '\f') {
        throw new DkTokenError('CSS token value contains an unescaped line break inside a string.');
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '/' && next === '*') { comment = true; i++; continue; }
    if (ch === '\\') {
      if (i + 1 >= source.length) throw new DkTokenError('CSS token value ends with an incomplete escape.');
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { stack.push(ch); continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      const expected = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      if (stack.pop() !== expected) throw new DkTokenError(`CSS token value contains an unmatched "${ch}".`);
      continue;
    }
    if (ch === ';' && stack.length === 0) {
      throw new DkTokenError('CSS token value contains a top-level ";" that would terminate the generated declaration.');
    }
  }

  if (quote) throw new DkTokenError('CSS token value contains an unterminated string.');
  if (comment) throw new DkTokenError('CSS token value contains an unterminated comment.');
  if (stack.length) throw new DkTokenError(`CSS token value contains an unclosed "${stack.at(-1)}" block.`);
  return source;
}

/* ============================================================
   DTCG 讀入端方言（向後相容是硬底線）。
   dk 內建 SSOT 維持 2021 字串方言（hex/px/rem 字串）；讀入端「額外」接受
   DTCG 2025.10 物件式 color / dimension，並解析成與等值字串相同的內部值——
   同值必同 tokenHash（見 buildManifest）。畸形物件丟 DkTokenError（教學訊息、
   exit 2），由命令層 validateTokens 一次列出、絕不 crash。
   ============================================================ */
export class DkTokenError extends Error {
  constructor(message) { super(message); this.name = 'DkTokenError'; this.code = 'DK_TOKEN'; this.teaching = true; }
}

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const to2hex = (n) => Math.round(clamp01(n) * 255).toString(16).padStart(2, '0');
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// DTCG 2025.10 color 物件 -> hex 字串。srgb 可由 components 解析（每軸 0–1）；
// 其他 colorSpace 僅在有 hex fallback 時可用（不發明色彩空間轉換）。無法解析 → 教學錯誤。
function colorObjectToHex(v) {
  const space = v.colorSpace;
  const hex = typeof v.hex === 'string' && HEX_RE.test(v.hex.trim()) ? v.hex.trim().toLowerCase() : null;
  const comps = v.components;
  const compsOk = Array.isArray(comps) && comps.length === 3 && comps.every((n) => typeof n === 'number' && Number.isFinite(n));
  if (space === 'srgb') {
    if (compsOk) {
      let out = '#' + to2hex(comps[0]) + to2hex(comps[1]) + to2hex(comps[2]);
      if (typeof v.alpha === 'number' && v.alpha < 1) out += to2hex(v.alpha); // <1 → 8 位 hex（DTCG 序列化慣例）
      return out;
    }
    if (hex) return hex; // components 缺/畸形 → hex fallback（若有）
    throw new DkTokenError(`color 物件（colorSpace:"srgb"）需要 components:[r,g,b]（三個 0–1 數值）或 hex fallback——兩者皆缺或格式不符。`);
  }
  if (space == null) throw new DkTokenError(`color 物件缺少 colorSpace 欄位（DTCG 2025.10 要求）。`);
  if (hex) return hex; // 非 srgb：目前僅在有 hex fallback 時可用
  throw new DkTokenError(`colorSpace "${space}" 的 components 尚不支援解析（讀入端目前僅 srgb 可由 components 解析）；請補上 hex fallback，或改用 srgb components。`);
}

// DTCG 2025.10 dimension 物件 { value, unit } -> CSS 字串。unit 僅 px/rem。
function dimensionObjectToString(v) {
  if (typeof v.value !== 'number' && typeof v.value !== 'string') throw new DkTokenError(`dimension 物件的 value 必須是數值（收到 ${typeof v.value}）。`);
  if (v.unit !== 'px' && v.unit !== 'rem') throw new DkTokenError(`dimension 物件的 unit 僅支援 "px" 或 "rem"（收到 ${JSON.stringify(v.unit)}）。`);
  return `${v.value}${v.unit}`;
}

/**
 * 把一個「原始 $value」正規化成內部字串值（tokenHash / CSS / 對比皆吃這個）。
 *   · 字串（2021 方言、alias {a.b}）→ 原樣（完全不變，既有行為零改動）。
 *   · DTCG 2025.10 物件式 color（colorSpace/components/hex）→ 等值 hex 字串。
 *   · DTCG 2025.10 物件式 dimension（value/unit）→ 等值 "16px"/"0.5rem" 字串。
 *   · 其他物件（composite：typography、shadow 物件…）→ DkTokenError（讀入端尚未支援）。
 * 純函式、可對單值呼叫；畸形丟 DkTokenError。
 */
export function normalizeValue(v) {
  if (v == null) return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    if ('colorSpace' in v || 'components' in v) return colorObjectToHex(v);
    if ('value' in v && 'unit' in v) return dimensionObjectToString(v);
    throw new DkTokenError(`不支援的物件式值：讀入端僅接受 DTCG 2025.10 的 color（colorSpace/components/hex）與 dimension（value/unit）物件形；composite 型別（typography、shadow 物件等）尚未支援——請改用字串方言。`);
  }
  return String(v);
}

/**
 * 走訪所有 leaf 的 $value 與 modes.dark，逐一嘗試 normalizeValue，蒐集畸形值錯誤。
 * 回傳教學字串陣列（空＝全部可解析）。命令層在動工前呼叫，畸形 → exit 2、不 crash。
 */
export function validateTokens(tokens) {
  const errors = [];
  walkLeaves(tokens, (p, leaf) => {
    const dot = p.join('.');
    try { assertCssIdentifierPath(p); } catch (e) { errors.push(`token ${dot} 的 path：${e.message}`); }
    const dark = leaf.$extensions?.modes?.dark;
    for (const [label, val] of [['$value', leaf.$value], ['modes.dark', dark]]) {
      if (val == null) continue;
      try { toCss(val); } catch (e) { errors.push(`token ${dot} 的 ${label}：${e.message}`); }
    }
  });
  return errors;
}

// dk 的字串方言以「整個值剛好是 {dot.path}」代表 alias。抽成單一 helper，
// 避免 resolve / manifest 診斷 / CSS 編譯三邊對 alias 邊界有不同理解。
const aliasTarget = (v) => {
  if (typeof v !== 'string' || !v.startsWith('{') || !v.endsWith('}')) return null;
  const target = v.slice(1, -1);
  assertCssIdentifierPath(target.split('.'));
  return target;
};

// 值 -> CSS：alias {a.b} 轉成 var(--a-b)，物件式 color/dimension 先正規化成等值字串，其餘原樣。
// 既有字串方言完全不變（normalizeValue 對字串是恆等）；與 build-tokens.mjs 對字串輸入位元組相同。
export const toCss = (v) => {
  const nv = normalizeValue(v);
  const target = aliasTarget(nv);
  if (target != null) return `var(${cssVarForPath(target.split('.'))})`;
  return assertCssDeclarationValue(nv);
};

// 只沿 own property 下探（hasOwnProperty）——alias/dotPath 絕不解析到 prototype 鏈上的繼承
// 屬性（如 {constructor} / {__proto__.x}），避免 read 端被誘導走出 token 樹。
const nodeAt = (tokens, dotPath) =>
  dotPath.split('.').reduce(
    (o, k) => (o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null ? o[k] : undefined),
    tokens);

/**
 * 追蹤單一 token 在指定 mode 的 alias chain，同時保留可報告的失敗原因。
 * 回傳 { value, issue? }；issue.kind = unresolved | cycle。
 * dark 不只檢查起點 override：alias 鏈上每個節點都優先取 dark override。
 */
function resolveDetailed(tokens, dotPath, mode = 'light') {
  const seen = new Map();
  const chain = [];
  let current = dotPath;

  while (true) {
    if (seen.has(current)) {
      const cycleStart = seen.get(current);
      const cycle = [...chain.slice(cycleStart), current];
      return {
        value: null,
        issue: { kind: 'cycle', token: dotPath, mode, ref: current, chain: [...chain, current], cycle },
      };
    }
    seen.set(current, chain.length);
    chain.push(current);

    const node = nodeAt(tokens, current);
    if (!isLeaf(node)) {
      return {
        value: null,
        issue: { kind: 'unresolved', token: dotPath, mode, ref: current, chain: [...chain] },
      };
    }

    const raw = (mode === 'dark' && node.$extensions?.modes?.dark != null)
      ? node.$extensions.modes.dark
      : node.$value;
    const next = aliasTarget(raw);
    if (next != null) { current = next; continue; }
    return { value: raw == null ? null : normalizeValue(raw) };
  }
}

/** 走訪所有 leaf；cb(pathArray, leafNode)。 */
export function walkLeaves(tokens, cb) {
  (function walk(obj, path) {
    for (const k of Object.keys(obj)) {
      if (k.startsWith('$')) continue;
      if (isDangerousKey(k)) continue; // 原型污染防護：不走訪危險 key（與 walkTS 一致）
      const node = obj[k];
      const p = [...path, k];
      if (isLeaf(node)) cb(p, node);
      else if (node && typeof node === 'object') walk(node, p);
    }
  })(tokens, []);
}

/**
 * 解析一個 dotPath 在指定 mode 下的「具體值」，追 {alias}、套 dark、防環。
 * 回傳字串（hex / rgba / px / …）或 null（找不到）。
 */
export function resolve(tokens, dotPath, mode = 'light') {
  return resolveDetailed(tokens, dotPath, mode).value;
}

/**
 * buildManifest — 一次走訪同時產出：
 *   flat:  Map<name, {light, dark}>  攤平的「具體」解析值（追完 alias）
 *   light/dark: [ [--css-var, aliasPreservingValue] ]  供 compile 產 CSS
 *   aliasIssues / collisions: 供 contract 轉成可阻擋 Finding 的結構化診斷
 *   tokenHash: 穩定雜湊（供快取失效與視覺差的稽核脈絡；不當作因果證明）
 *   count / darkCount: 實際可安全產出數；sourceCount: 原始 leaf 數
 * name 不含前導 --（如 'color-text-primary'、'space-4'），與 config 範例一致。
 */
export function buildManifest(tokens) {
  const records = [];
  walkLeaves(tokens, (p, leaf) => {
    const name = p.join('-');
    const dotPath = p.join('.');
    records.push({
      leaf, name, dotPath, cssVar: cssVarForPath(p),
      lightResolved: resolveDetailed(tokens, dotPath, 'light'),
      darkResolved: resolveDetailed(tokens, dotPath, 'dark'),
    });
  });

  // dot-path → CSS custom property 是有損壓扁（`.` 與原有 `-` 都變 `-`）；
  // foo.bar-baz / foo-bar.baz 會同時變 --foo-bar-baz。不能以 JSON key 順序
  // 決定誰覆蓋誰，因此整組不產出，交給 contract 以 Finding 擋下。
  const byName = new Map();
  for (const r of records) {
    const bucket = byName.get(r.name) ?? [];
    bucket.push(r);
    byName.set(r.name, bucket);
  }
  const collisions = [];
  const ambiguousNames = new Set();
  for (const [name, bucket] of byName) {
    if (bucket.length < 2) continue;
    ambiguousNames.add(name);
    collisions.push({ name, cssVar: '--' + name, paths: bucket.map((r) => r.dotPath).sort() });
  }

  const flat = new Map();
  const light = [];
  const dark = [];
  const aliasIssues = [];
  for (const r of records) {
    for (const detail of [r.lightResolved, r.darkResolved]) {
      if (detail.issue) aliasIssues.push(detail.issue);
    }
    if (ambiguousNames.has(r.name)) continue;
    light.push([r.cssVar, toCss(r.leaf.$value)]);
    const d = r.leaf.$extensions?.modes?.dark;
    if (d != null) dark.push([r.cssVar, toCss(d)]);
    flat.set(r.name, {
      light: r.lightResolved.value,
      dark: r.darkResolved.value,
    });
  }

  collisions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  aliasIssues.sort((a, b) => {
    const ak = `${a.token}|${a.mode}|${a.kind}|${a.ref}`;
    const bk = `${b.token}|${b.mode}|${b.kind}|${b.ref}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  // 乾淨 token 樹維持原 tokenHash 算法（既有 baseline 不漂移）；異常時才把
  // 診斷納入 hash，使碰撞集合改變時 slop cache 必定失效。
  let stable = JSON.stringify([...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  if (collisions.length || aliasIssues.length) stable += JSON.stringify({ collisions, aliasIssues });
  const tokenHash = createHash('sha256').update(stable).digest('hex').slice(0, 16);
  return {
    flat, light, dark, tokenHash,
    count: light.length,
    sourceCount: records.length,
    darkCount: dark.length,
    collisions,
    aliasIssues,
  };
}

// 預設 header：位元組重現 design/build-tokens.mjs 的產物，確保既有 tokens.css 不變、
// 既有 `node design/build-tokens.mjs --check` 與 CI 不破。可用 opts.header 覆寫。
const defaultHeader = (count, darkCount) =>
`/* ============================================================
   AUTO-GENERATED by Axion Designer (design/build-tokens.mjs).
   SSOT = design/tokens.json — 不要手改這個檔。
   tokens: ${count} · dark overrides: ${darkCount}
   ============================================================ */`;

const cssBlock = (arr, ind = '  ') => arr.map(([n, v]) => `${ind}${n}: ${v};`).join('\n');

/**
 * compile — DTCG tokens -> 多格式產物。
 * formats: 陣列或以逗號分隔字串，可含 'css' | 'js' | 'json'。
 * 回傳 { css, js?, json?, resolved, tokenCount, darkCount, tokenHash }
 */
export function compile(tokens, opts = {}) {
  const formats = normalizeFormats(opts.formats ?? ['css']);
  const m = buildManifest(tokens);
  const out = { tokenCount: m.count, darkCount: m.darkCount, tokenHash: m.tokenHash };

  if (formats.has('css')) {
    const header = opts.header ?? defaultHeader(m.count, m.darkCount);
    if (typeof header !== 'string' || !header.startsWith('/*') || !header.endsWith('*/') || header.slice(2, -2).includes('*/')) {
      throw new DkTokenError('CSS header must be one closed /* ... */ comment.');
    }
    out.css =
`${header}
:root {
${cssBlock(m.light)}
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${cssBlock(m.dark)}
  }
}
:root[data-theme="dark"] {
${cssBlock(m.dark)}
}
:root[data-theme="light"] {
${cssBlock(m.light)}
}
`;
  }

  const resolved = {};
  for (const [name, val] of m.flat) resolved[name] = val;
  out.resolved = { tokenHash: m.tokenHash, tokens: resolved };

  if (formats.has('json')) {
    out.json = JSON.stringify(out.resolved, null, 2) + '\n';
  }
  if (formats.has('js')) {
    const entries = [...m.flat.entries()]
      .map(([name, v]) => `  ${JSON.stringify(name)}: ${JSON.stringify(v.light)},`)
      .join('\n');
    out.js =
`// AUTO-GENERATED by dk build — do not edit. SSOT tokens (light values).
export const tokens = {
${entries}
};
export default tokens;
`;
  }
  return out;
}

function normalizeFormats(f) {
  const arr = Array.isArray(f) ? f : String(f).split(',');
  return new Set(arr.map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/* ============================================================
   Tokens Studio → dk（DTCG 字串方言）匯入器。純函式、零 I/O（fs 在命令層）。
   吃已解析的 set 陣列 [{ name, data }]，回：
     { tree, converted:[dotPath], skipped:[{path,type}], unresolved:[{path,ref}], setNames, aliasCount }
   哲學：格式搬運，不改值、不補值、不發明轉換。
     · 簡單型別（color/dimension/spacing/…）→ 原值搬運（字串保留、type 映射到 DTCG $type）。
     · 複合型別 / 物件值（typography、boxShadow、border …）→ 可見跳過、原樣不轉，計入 skipped。
     · alias {a.b.c} 原樣保留；對合併後的 tree 檢查解析度，未解析者列入 unresolved。
   Tokens Studio 慣例：頂層 key 為 token set 名、references 省略 set 名（跨 set 共享命名空間），
   故各 set 內容攤平合併到同一 tree（見命令層 readTokensStudio*）。
   ============================================================ */

// Tokens Studio 的 value/type 與 DTCG $value/$type 都映射為 dk 的 DTCG $type。
const TS_TYPE_MAP = {
  color: 'color',
  dimension: 'dimension', spacing: 'dimension', sizing: 'dimension',
  borderRadius: 'dimension', borderWidth: 'dimension',
  fontSize: 'dimension', lineHeight: 'dimension', letterSpacing: 'dimension', paragraphSpacing: 'dimension',
  fontFamily: 'fontFamily', fontFamilies: 'fontFamily',
  fontWeight: 'fontWeight', fontWeights: 'fontWeight',
  number: 'number', opacity: 'number',
  text: 'string', other: 'string', boolean: 'boolean',
};
// 複合型別（物件值）—— 讀入端不轉換、可見跳過。物件值一律跳過（不論 type），此集合僅供錯誤訊息分類。
const TS_COMPOSITE_TYPES = new Set(['typography', 'boxShadow', 'shadow', 'border', 'composition', 'asset', 'gradient']);

function walkTS(obj, path, cb, onUnsafe) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    if (k.startsWith('$')) continue; // 跳過 $themes/$metadata/$extensions 等 metadata
    if (isDangerousKey(k)) { onUnsafe?.([...path, k]); continue; } // 原型污染防護：拒絕危險 key、可見記錄、不下探
    const node = obj[k];
    if (!node || typeof node !== 'object') continue;
    const p = [...path, k];
    if ('value' in node || '$value' in node) cb(p, node); // Tokens Studio leaf（value/type）或 DTCG leaf（$value/$type）
    else walkTS(node, p, cb, onUnsafe);
  }
}
// 縱深防禦：即使 path 漏網含危險 key 也絕不寫到 prototype 鏈上（回 false＝未寫）。中繼層以
// hasOwnProperty 判存在，繼承屬性（如 o.constructor）一律視為不存在、改建全新物件。
function setDeep(root, path, leaf) {
  let o = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (isDangerousKey(k)) return false;
    if (!Object.prototype.hasOwnProperty.call(o, k) || o[k] == null || typeof o[k] !== 'object' || isLeaf(o[k])) o[k] = {};
    o = o[k];
  }
  const last = path[path.length - 1];
  if (isDangerousKey(last)) return false;
  o[last] = leaf;
  return true;
}
function collectRefs(val, path, out) {
  if (typeof val !== 'string') return;
  const re = /\{([^{}]+)\}/g;
  let m;
  while ((m = re.exec(val))) out.push({ path: path.join('.'), ref: m[1].trim() });
}

export function fromTokensStudio(sets) {
  const tree = {};
  const converted = [];
  const skipped = [];
  const refs = [];
  const setNames = [];
  // 被拒的危險 key（原型污染防護）——併入 skipped 以 type '(unsafe-key)' 可見列出，絕不靜默丟失。
  const onUnsafe = (p) => skipped.push({ path: p.join('.'), type: '(unsafe-key)' });
  for (const { name, data } of sets) {
    if (name) setNames.push(name);
    walkTS(data, [], (p, leaf) => {
      const type = leaf.$type ?? leaf.type;
      const rawVal = leaf.$value ?? leaf.value;
      // 複合 / 物件值：不發明轉換，可見跳過。
      if (rawVal !== null && typeof rawVal === 'object') { skipped.push({ path: p.join('.'), type: type ?? '(object)' }); return; }
      if (type && TS_COMPOSITE_TYPES.has(type)) { skipped.push({ path: p.join('.'), type }); return; }
      // 搬運（原值不動——不補單位、不改色）。
      const out = {};
      const dtcg = type ? TS_TYPE_MAP[type] : undefined;
      if (dtcg) out.$type = dtcg;
      out.$value = rawVal;
      const desc = leaf.$description ?? leaf.description;
      if (desc) out.$description = desc;
      if (!setDeep(tree, p, out)) { onUnsafe(p); return; } // 縱深防禦：拒寫（危險 key）→ 併入可見清單
      converted.push(p.join('.'));
      collectRefs(rawVal, p, refs);
    }, onUnsafe);
  }
  // alias 解析度：對「合併後」的 tree 檢查每個 ref 是否指到 leaf。
  const unresolved = refs.filter((r) => !isLeaf(nodeAt(tree, r.ref)));
  return { tree, converted, skipped, unresolved, setNames, aliasCount: refs.length };
}

/* ---- 對比數學 ---- */

function rgbChannels(hex) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function relLum(hex) {
  const ch = rgbChannels(hex);
  if (!ch) return null;
  const c = ch.map((v) => v / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** WCAG 2.x 對比比值。非 hex（rgba/named）回傳 null。 */
export function contrast(a, b) {
  const la = relLum(a), lb = relLum(b);
  if (la == null || lb == null) return null;
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** APCA (W3 0.1.9) Lc。回傳絕對亮度對比 Lc（0..~108）；非 hex 回傳 null。 */
export function apca(text, bg) {
  const yt = sRGBtoY(text), yb = sRGBtoY(bg);
  if (yt == null || yb == null) return null;
  const Ytxt = clampBlack(yt), Ybg = clampBlack(yb);
  if (Math.abs(Ybg - Ytxt) < 0.0005) return 0;
  let sapc, out;
  if (Ybg > Ytxt) { // 深字淺底
    sapc = (Ybg ** 0.56 - Ytxt ** 0.57) * 1.14;
    out = sapc < 0.1 ? 0 : sapc - 0.027;
  } else {           // 淺字深底
    sapc = (Ybg ** 0.65 - Ytxt ** 0.62) * 1.14;
    out = sapc > -0.1 ? 0 : sapc + 0.027;
  }
  return Math.abs(out) * 100;
}

function sRGBtoY(hex) {
  const ch = rgbChannels(hex);
  if (!ch) return null;
  const [r, g, b] = ch.map((v) => (v / 255) ** 2.4);
  return 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
}
function clampBlack(Y) {
  return Y >= 0.022 ? Y : Y + (0.022 - Y) ** 1.414;
}
