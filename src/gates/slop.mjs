/* ============================================================
   token-aware 反 AI-slop 關卡 ＋ 自訂規則宿主。
   內建規則以資料表達（可個別開關）：hardcoded-color / ai-font / lorem /
   gradient-hero / emoji-heading / vanity-number。
   證據不變量：
     - 精確 file:line:col
     - 讀 manifest 把寫死 #hex 反查「最近的 token」
     - 讀 verifiedPairs 供下游 a11y 反查
     - 宿主自訂規則（宣告式 regex 或程式式 test(ctx)）
   EMIT: usedTokens（原始碼用到的 var(--token)）
   零依賴。
   ============================================================ */
import { makeFinding } from '../core/finding.mjs';
import { fmsg } from '../core/i18n.mjs';
import { extname } from 'node:path';

// 合法 CSS 顏色的 hex 長度只有 3/4/6/8 位；`(?![0-9a-fA-F])` 確保後面沒有更多 hex 位，
// 使非法 7 碼（#1234567）不被當成「6 碼 + 尾字」誤報成寫死色。
const HEX_LEN = '(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])';
// 寫死色：屬性名 → 值裡含 #hex。字元類排除 `;{},`（宣告/物件邊界）但**允許引號**，
// 涵蓋 CSS-in-JS 的 `color: '#ff00aa'`（值前可有引號）。
// 負向 lookbehind `(?<!url\(\s*['"]?)`：跳過 SVG paint-server 引用 `fill:url(#id)` /
// `stroke:url('#id')` / `background:url("#id")`——那是「引用一個 id」而非寫死色，即使 id 恰為
// 3/4/6/8 位純 hex 字元（url('#a1b2c3')/#deadbeef/#face/#abc）也不該報。仍咬得到 url() 之外的
// 真色（`background:url(#g) #ff0000` 的 #ff0000 照抓，因其前非 url(）。
// 值字元類以 `{0,256}` 限制回溯上限，維持線性掃描；256 足以涵蓋單段 CSS 值，
// 逗號則把多值切成各自的宣告段。
// 屬性名同時涵蓋 kebab 與 camelCase（backgroundColor/borderColor/borderTopColor/boxShadow）——與
// enforceScale 的 camelCase→kebab 正規化使用相同屬性邊界。
const RE_HEX = new RegExp(`(?:color|background(?:-color|Color)?|border(?:-[a-z]+)?-color|border(?:[A-Z][a-z]+)?Color|fill|stroke|box(?:-shadow|Shadow))\\s*:\\s*[^;{},]{0,256}(?<!url\\(\\s*['"]?)#${HEX_LEN}`, 'g');
const RE_HEX_VALUE = new RegExp(`#${HEX_LEN}`);
// 尾錨定 hex：RE_HEX 的樣式以 `#hex` 結尾，故每個 match 的 m[0] 尾端即 RE_HEX 實際錨定的色值
// （不會誤取 url(#id) 內的 id——那類前導已被 RE_HEX 的負向 lookbehind 排除、不會成為尾端）。
// fix --slop 用它精準定位「要被替換的那個 hex」的字元位移，只動色值本身、保留 `color: ` 前綴。
const RE_HEX_TAIL = new RegExp(`#${HEX_LEN}$`);
// ai-font 內建 AI 預設字體集；只在「首位(primary family)」命中才報（見下方迴圈）。
const BUILTIN_FONTS = ['Inter', 'Roboto', 'Arial', 'DM Sans', 'Nunito', 'Space Grotesk'];
// 抓 font-family 宣告的「值」（同時吃 CSS 的 `font-family` 與 JSX/CSS-in-JS 的 `fontFamily`）。
const RE_FONT_DECL = /font-?family\s*:\s*([^;{}\n]*)/gi;
const RE_LOREM = /lorem ipsum|dolor sit amet/gi;
const RE_GRAD = /linear-gradient\([^)]*(purple|indigo|violet|blueviolet|#(6[0-9a-f]|7[0-9a-f]|8[0-9a-f])[0-9a-f]?[ef][0-9a-f])/gi;
// 字素級 emoji 偵測（涵蓋星平面 🚀 U+1F680 與 ZWJ 序列）。取標題首字素後用此比對。
const RE_PICTO = /\p{Extended_Pictographic}/u;
// 虛榮數字：以 lookbehind/lookahead 界定邊界（不消耗前導字元 → match.index 直指數字，可算精確 line/col）。
// 只咬帶「膨脹記號」的數字：N+（50+/300+/5000+）、千分位+（1,000+）、kMm+（10k+/2M+）、24/7、99.9%、100%…保證。
// 刻意放行可溯源真值：純千分位/價格（1,234,567 / $1,200）、無 + 的解析度/單位（4K/8K/3M）、
// 4 位年份（19xx/20xx+）、版本語境——`\d{2,}\+` 分支前置負向 lookbehind「已知技術/平台詞 curated 清單」
// （React 18+/iOS 17+/Android 14+/Chrome 120+/Node 18+…；v18+ 由 `(?<![\w.$])` 的 \w 擋住、`v 18+` 由清單的 v 擋住）。
// 刻意不泛化成任意英文詞（(?<![A-Za-z]\s)）：英文是虛榮數字的主要棲地，泛化會把 Trusted by 1000+ /
// Join 500+ 這類目標格式一起漏掉。curated 取捨：清單外技術詞（小寫 edge、湊巧詞尾 MyReact——
// 由 \b 擋住湊巧詞尾的誤放行）仍會報、清單內詞的非版本語境（Go 500+ miles）會漏——皆罕見，清單可隨 FP 回報增補。
// 清單為定長 alternation，lookbehind 長度有界且無巢狀量詞。千分位群組限 `{1,9}`，
// 固定回溯上限仍涵蓋約 10^28 以內的實際數字；其餘分支由前導 lookbehind 限制重啟位置。
const RE_VANITY = /(?<![\w.$])(?:24\/7|(?<!\b(?:React|Preact|Vue|Svelte|Angular|Ember|[Nn]ode|Deno|Bun|Electron|iOS|iPadOS|macOS|watchOS|tvOS|Android|Windows|Linux|Ubuntu|Debian|Fedora|Chrome|Chromium|Safari|Firefox|Edge|Opera|TypeScript|JavaScript|ECMAScript|ES|Java|Python|PHP|Ruby|Rails|Go|Rust|Swift|Kotlin|Dart|Laravel|Django|Vite|Webpack|Next|Nuxt|Astro|Expo|Unity|Unreal|Postgres|PostgreSQL|MySQL|MongoDB|Redis|v)\s)(?!(?:19|20)\d\d\+)\d{2,}\+|\d{1,3}(?:,\d{3}){1,9}\+|\d+(?:\.\d+)?[kKmM]\+|99\.9%)(?![\w.])|100\s*%\s*(?:免費|滿意|保證|安全)/g;
// 只抓 var() 的第一個 custom-property 名，同時接受 fallback：
//   var(--x) / var(--x, inherit) / var(--x, var(--y))
// 不把 fallback 視為「參照存在」：它只防 computed value 無效，--x 仍繞過 SSOT。
const RE_USED_TOKEN = /var\(\s*(--[a-zA-Z0-9_-]+)(?=\s*(?:,|\)))/g;

export function slopGate(ctx) {
  const findings = [];
  const usedTokens = new Set();
  const knownTokenVars = new Set(
    [...(ctx.manifest?.flat?.keys?.() ?? [])].map((name) => `--${name}`),
  );
  // 只對 manifest 已宣告的 token namespace fail-closed。例如 manifest 有
  // --color-* / --space-*，則拼錯的 --color-brand-accnt 會擋；Radix、動畫或
  // 元件內部的 --radix-* / --component-* 不被誤當成 SSOT token。
  const tokenNamespaces = new Set(
    [...(ctx.manifest?.flat?.keys?.() ?? [])]
      .map((name) => String(name).split('-')[0].toLowerCase())
      .filter(Boolean),
  );
  const isTokenNamespace = (cssVar) =>
    tokenNamespaces.has(cssVar.slice(2).split('-')[0].toLowerCase());
  const fontAllow = ctx.config?.fonts?.allow ?? [];
  const fontDeny = ctx.config?.fonts?.deny ?? [];
  const hexIndex = buildHexIndex(ctx.manifest);
  // scale 強制：由 config.enforce 控制（off | warn | error）。預設全 off。
  const enforce = ctx.config?.enforce ?? {};
  const ramps = buildScaleRamps(ctx.manifest);
  // ai-font 集（僅在首位命中才判定）：明確 allow 的優先權高於內建/custom deny。
  // allow 是使用者對該專案字體選擇的刻意核准；若同一名稱同時列於 allow/deny，
  // 必須 deterministic 地放行，否則 config.slop.fonts.allow 只是沒有作用的假設定。
  const allowedFonts = new Set();
  for (const f of fontAllow) { const n = normFont(f); if (n) allowedFonts.add(n); }
  const builtinDenyFonts = new Map(BUILTIN_FONTS.map((f) => [normFont(f), f]));
  const customDenyFonts = new Map();
  for (const f of fontDeny) { const n = normFont(f); if (n) customDenyFonts.set(n, f); }

  for (const { path, source } of ctx.files) {
    const lc = lineColFn(source);
    const styleRanges = styleZoneRanges(source, path);
    const inStyle = (idx) => styleRanges.some(([s, e]) => idx >= s && idx < e);
    // CSS/HTML block comment 內的 var(--example) 是文件，不是執行時參照。保留原字串
    // 位移，只用 range 排除，所以真 Finding 的 line/col 仍精確。
    const commentRanges = [...source.matchAll(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g)]
      .map((m) => [m.index, m.index + m[0].length]);
    const inComment = (idx) => commentRanges.some(([s, e]) => idx >= s && idx < e);
    // zone 邊界截斷：偵測用的值字元類（如 RE_HEX 的 [^;{},]、enforceScale 的 [^;{},<]）可在無
    // 分號時貪婪衝出 style 屬性引號、把 zone 外 HTML 內容吞進來。evidence 字串以「起點所在 zone 的
    // 結尾」截斷，確保 evidence 與掃描都不越出 style zone。
    const zoneEndAt = (idx) => { const z = styleRanges.find(([s, e]) => idx >= s && idx < e); return z ? z[1] : source.length; };
    const clipToZone = (start, str) => { const max = zoneEndAt(start) - start; return (max > 0 && max < str.length) ? str.slice(0, max) : str; };

    // usedTokens：跨整個檔收集 var(--…)。同一次 parse 中，style zone 內若引用
    // manifest 不存在的 variable，立即產生可阻擋 Finding（有 fallback 也照報並標註）。
    for (const m of source.matchAll(RE_USED_TOKEN)) {
      const cssVar = m[1];
      usedTokens.add(cssVar);
      if (!inStyle(m.index) || inComment(m.index) || knownTokenVars.has(cssVar) || !isTokenNamespace(cssVar)) continue;
      const tail = source.slice(m.index + m[0].length);
      const hasFallback = /^\s*,/.test(tail);
      const { line, col } = lc(m.index);
      findings.push(makeFinding({
        ruleId: 'tokens/unknown-reference', file: path, line, col,
        evidence: `var(${cssVar}${hasFallback ? ', …' : ''})`,
        ...fmsg('slop.unknownTokenReference', {
          cssVar,
          hasFallback,
        }),
        meta: { token: cssVar, namespace: cssVar.slice(2).split('-')[0].toLowerCase(), hasFallback },
      }));
    }

    // hardcoded-color（限 style zone）— 反查最近 token
    for (const m of source.matchAll(RE_HEX)) {
      if (!inStyle(m.index)) continue;
      const hexM = RE_HEX_VALUE.exec(m[0]);
      const hex = hexM ? hexM[0] : null;
      const suggest = hex ? hexIndex.get(normHex(hex)) : null; // manifest 的 kebab name（如 color-text-on-accent）
      const cssVar = suggest ? `var(--${suggest})` : null;
      const { line, col } = lc(m.index);
      const ev = clipToZone(m.index, m[0]).trim(); // evidence 以 zone 邊界截斷（偵測/反查仍用完整 m[0]）
      findings.push(mk(ctx, 'slop/hardcoded-color', {
        file: path, line, col, evidence: ev,
        ...(cssVar ? fmsg('slop.hardcodedColor.known', { hex, cssVar })
                   : fmsg('slop.hardcodedColor.unknown', { evidence: ev })),
        meta: suggest ? { hex, token: '--' + suggest } : { hex },
      }));
    }

    // ai-font（限 style zone）— 只在「首位(primary family)」為 AI 預設/deny 字體時報。
    // fallback 位置的 web-safe（'Söhne',Arial,sans-serif 的 Arial）是刻意且正確的用法，一律放行。
    for (const m of source.matchAll(RE_FONT_DECL)) {
      if (!inStyle(m.index)) continue;
      const first = firstFamily(m[1]);
      if (!first) continue;
      const key = normFont(first);
      if (allowedFonts.has(key)) continue; // explicit allow overrides builtin and custom deny
      const builtin = builtinDenyFonts.get(key);
      const custom = customDenyFonts.get(key);
      if (!builtin && !custom) continue; // 首位非 deny 字體 → 放行（含 web-safe fallback）
      const { line, col } = lc(m.index);
      findings.push(mk(ctx, 'slop/ai-font', {
        file: path, line, col, evidence: `font-family: ${first}`,
        ...(builtin ? fmsg('slop.aiFont.builtin', { font: builtin })
                    : fmsg('slop.aiFont.custom', { font: custom })),
      }));
    }

    // lorem（整檔）
    for (const m of source.matchAll(RE_LOREM)) {
      const { line, col } = lc(m.index);
      findings.push(mk(ctx, 'slop/lorem', { file: path, line, col, evidence: m[0] }));
    }

    // gradient-hero（限 style zone，warn）
    for (const m of source.matchAll(RE_GRAD)) {
      if (!inStyle(m.index)) continue;
      const { line, col } = lc(m.index);
      findings.push(mk(ctx, 'slop/gradient-hero', {
        file: path, line, col, evidence: clipToZone(m.index, m[0]).slice(0, 60),
        ...fmsg('slop.gradientHero'),
      }));
      break; // 每檔提一次就夠
    }

    // emoji-heading（warn）— 字素級：取標題首字素（Array.from 碼點級，涵蓋星平面 emoji 與 ZWJ）
    for (const m of source.matchAll(/<h[1-3][^>]*>\s*(\S[\s\S]{0,15})/g)) {
      const firstGrapheme = Array.from(m[1])[0];
      if (firstGrapheme && RE_PICTO.test(firstGrapheme)) {
        const { line, col } = lc(m.index);
        findings.push(mk(ctx, 'slop/emoji-heading', {
          file: path, line, col, evidence: m[0].trim(),
          ...fmsg('slop.emojiHeading'),
        }));
        break;
      }
    }

    // vanity-number（warn，掃可見文字）—— 遮蔽標籤但保留字元位移，故每筆都有精確 file:line:col。
    const masked = source.replace(/<[^>]+>/g, (t) => ' '.repeat(t.length));
    for (const m of masked.matchAll(RE_VANITY)) {
      const token = (m[1] ?? m[0]).trim();
      const rel = m[0].indexOf(token);
      const { line, col } = lc(m.index + (rel >= 0 ? rel : 0));
      findings.push(mk(ctx, 'slop/vanity-number', {
        file: path, line, col, evidence: token,
        ...fmsg('slop.vanityNumber', { token }),
      }));
    }

    // ── scale 強制：spacing / type / radius（限 style zone，由 config.enforce 控制）──
    enforceScale(source, path, lc, inStyle, enforce, ramps, findings, clipToZone);

    // ── 自訂規則（config.slop.rules）─────────────────
    for (const rule of ctx.config.slopRules ?? []) {
      runCustomRule(rule, { path, source, lc, inStyle }, ctx, findings);
    }
  }

  return { findings, emits: { usedTokens: [...usedTokens] } };
}

function runCustomRule(rule, fileCtx, ctx, findings) {
  const { path, source, lc, inStyle } = fileCtx;
  const restrictStyle = rule.zone === 'style';

  // 程式式：test(ctx) -> partial findings（.mjs 專屬）
  if (typeof rule.test === 'function') {
    let out;
    try {
      out = rule.test({
        source, file: path, manifest: ctx.manifest,
        resolve: ctx.resolve, contrast: ctx.contrast, emits: ctx.emits,
      });
    } catch (err) {
      findings.push(makeFinding({
        ruleId: rule.id, severity: 'warn', file: path,
        ...fmsg('slop.customError', { msg: err.message }),
      }));
      return;
    }
    for (const f of out ?? []) {
      findings.push(makeFinding({
        ruleId: rule.id, severity: f.severity ?? rule.severity ?? 'warn',
        file: f.file ?? path, line: f.line ?? null, col: f.col ?? null,
        message: f.message ?? rule.message ?? rule.id, evidence: f.evidence,
        fix: f.fix ?? rule.hint ?? rule.fix,
      }));
    }
    return;
  }

  // 宣告式：regex + severity + hint
  if (rule.regex instanceof RegExp) {
    const re = new RegExp(rule.regex.source, rule.regex.flags.includes('g') ? rule.regex.flags : rule.regex.flags + 'g');
    for (const m of source.matchAll(re)) {
      if (restrictStyle && !inStyle(m.index)) continue;
      const { line, col } = lc(m.index);
      findings.push(makeFinding({
        ruleId: rule.id, severity: rule.severity ?? 'warn',
        file: path, line, col, evidence: m[0].trim(),
        message: rule.message ?? rule.id, fix: rule.hint ?? rule.fix,
      }));
    }
  }
}

/* ---- scale 強制（spacing / type / radius）---- */
const RE_LEN = /-?\d*\.?\d+(?:px|rem|em)\b/g;
// CSS 屬性 -> 尺度分類。只認「間距 / 圓角 / 字級」三類；其餘屬性不管。
const PROP_CAT = {
  padding: 'spacing', margin: 'spacing', gap: 'spacing', 'row-gap': 'spacing', 'column-gap': 'spacing',
  'padding-top': 'spacing', 'padding-right': 'spacing', 'padding-bottom': 'spacing', 'padding-left': 'spacing',
  'padding-block': 'spacing', 'padding-inline': 'spacing', 'margin-top': 'spacing', 'margin-right': 'spacing',
  'margin-bottom': 'spacing', 'margin-left': 'spacing', 'margin-block': 'spacing', 'margin-inline': 'spacing',
  'border-radius': 'radius', 'border-top-left-radius': 'radius', 'border-top-right-radius': 'radius',
  'border-bottom-left-radius': 'radius', 'border-bottom-right-radius': 'radius',
  'font-size': 'type',
};
const CAT_META = {
  spacing: { ruleId: 'slop/hardcoded-spacing', rampKey: 'space', label: '間距', scale: 'space' },
  radius: { ruleId: 'slop/hardcoded-radius', rampKey: 'radius', label: '圓角', scale: 'radius' },
  type: { ruleId: 'slop/hardcoded-type', rampKey: 'type', label: '字級', scale: 'type' },
};

// 長度值數值正規化：把等價寫法收斂成標準形（.5rem→0.5rem、8.0px→8px、16.0PX→16px），供 scale 比對用——
// 避免「無前導零 / 多餘尾零」被純字串比對誤判為 off-scale。非「數字＋單位」的值原樣返回（clamp() 等不動）。
function normLen(s) {
  const str = String(s).trim().toLowerCase();
  const m = /^(-?\d*\.?\d+)([a-z%]*)$/.exec(str);
  return m ? String(parseFloat(m[1])) + m[2] : str;
}

function buildScaleRamps(manifest) {
  // ramp 值一律以 normLen 正規化入集，與 enforceScale 比對端同一標準（token 寫 0.5rem、程式碼寫 .5rem 亦等價）。
  const space = new Set(['0', '0px']), radius = new Set(['0', '0px']), type = new Set();
  if (manifest?.flat) {
    for (const [name, val] of manifest.flat) {
      const v = (val?.light ?? '').toString().trim().toLowerCase();
      if (!v) continue;
      if (name.startsWith('space-')) space.add(normLen(v));
      else if (name.startsWith('radius-')) radius.add(normLen(v));
      else if (name.startsWith('font-size-')) type.add(normLen(v));
    }
  }
  return { space, radius, type };
}

// 掃 style zone 的宣告，對啟用的分類檢查每個長度是否落在 token 階梯。
// 只擋「off-scale」的裸值（在 ramp 內的裸值放行——它本就對齊尺度）；用 var() 的值無裸長度、自然通過。
// 值字元類排除 `;{},<` 但允許引號，因此 CSS-in-JS 內聯字串值 `margin:'13px'` 也受檢查；
// 排除逗號使物件內多屬性（margin:'13px', width:'17px'）各自成段，避免把 width 的值誤算進 margin。
function enforceScale(source, path, lc, inStyle, enforce, ramps, findings, clipToZone) {
  if (!enforce || (enforce.spacing === 'off' && enforce.radius === 'off' && enforce.type === 'off')) return;
  for (const m of source.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{},<]+)/g)) {
    if (!inStyle(m.index)) continue;
    // camelCase（CSS-in-JS：marginTop/borderRadius/fontSize）→ kebab，與 CSS 同樣受治理。
    const prop = m[1].replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    const cat = PROP_CAT[prop];
    if (!cat) continue;
    const level = enforce[cat];
    if (!level || level === 'off') continue;
    const meta = CAT_META[cat];
    const ramp = ramps[meta.rampKey];
    // 值以 zone 邊界截斷：`[^;{},<]+` 在無分號時會衝出 style 屬性引號（`padding:0.5rem">on scale`），
    // 把 zone 外 HTML 內容帶進 RE_LEN 掃描與 evidence。截斷後只量測/顯示 zone 內的真值。
    const valStart = m.index + m[0].length - m[2].length;
    const value = clipToZone(valStart, m[2]);
    // evidence 去掉 zone 邊界殘留的收尾引號（spacing/radius/type 值不會合法以引號結尾）。
    const evValue = value.trim().replace(/["']+$/, '').trim();
    const seen = new Set();
    for (const lm of value.matchAll(RE_LEN)) {
      const len = lm[0].toLowerCase();
      if (parseFloat(len) === 0) continue;   // 0 永遠合法
      if (ramp.has(normLen(len))) continue;  // 數值正規化後比對（.5rem≡0.5rem、16.0px≡16px）：在階梯內即放行
      if (seen.has(len)) continue; seen.add(len);
      const { line, col } = lc(m.index);
      findings.push(makeFinding({
        ruleId: meta.ruleId, severity: level, file: path, line, col,
        evidence: `${prop}: ${evValue}`,
        ...fmsg('slop.offScale', { cat, len, scale: meta.scale, varName: meta.scale === 'type' ? 'font-size' : meta.scale }),
      }));
    }
  }
}

/* ---- helpers ---- */
function mk(ctx, ruleId, partial) {
  return makeFinding({ ruleId, ...partial });
}

// style zone 的字元範圍（檔類型感知）：
//   .css/.scss/.less           → 整檔即 style zone
//   .html/.vue/.svelte/.astro  → style="…" 與 <style>…</style>
//   CSS-in-JS(.jsx/.tsx/.vue/.svelte/.astro) → style/css/sx={{…}}、tagged template（styled.x`…` / css`…`…）
// 明確不在掃描範圍：SVG 的 fill="#hex"/stroke="#hex" XML 屬性，以及 Tailwind arbitrary
// utility（text-[#ff0000] / mt-[13px]）；兩者都不是目前 parser 支援的宣告語法。
// 刻意排除（非誤報）：CSS 宣告裡的 SVG paint-server 引用 fill:url(#id)/stroke:url('#id')/background:url("#id")
// 是「引用一個 id」而非寫死色，由 RE_HEX 的負向 lookbehind 放行（正面 fixture 見 fp-clean.html）。
const CSS_FILE_EXT = new Set(['.css', '.scss', '.less']);
const CSS_IN_JS_EXT = new Set(['.jsx', '.tsx', '.vue', '.svelte', '.astro']);
function styleZoneRanges(src, filePath = '') {
  const ext = extname(filePath).toLowerCase();
  if (CSS_FILE_EXT.has(ext)) return [[0, src.length]]; // 整檔即樣式
  const ranges = [];
  // HTML-ish：style="…"／style='…'（單雙引號皆支援；各自成對的替代分支，故 style="a'b" 不被內嵌引號截斷）與 <style>…</style>
  for (const m of src.matchAll(/style=(?:"[^"]*"|'[^']*')|<style[\s\S]*?<\/style>/gi)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  // CSS-in-JS：內聯物件 style={{…}}／emotion css={{…}}／MUI sx={{…}}；styled/css/keyframes/createGlobalStyle 樣板字串
  if (CSS_IN_JS_EXT.has(ext)) {
    for (const m of src.matchAll(/(?<![\w$])(?:style|css|sx)\s*=\s*\{\{[\s\S]*?\}\}/g)) ranges.push([m.index, m.index + m[0].length]);
    for (const m of src.matchAll(/(?<![\w$])(?:styled(?:\.[a-zA-Z0-9]+|\([^)]*\))?|createGlobalStyle|keyframes|css)\s*`[\s\S]*?`/g)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}

// 由字元 index 算 1-based line/col（一次建行首表，O(log n) 查詢）
function lineColFn(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (idx) => {
    // binary search 最後一個 <= idx
    let lo = 0, hi = starts.length - 1, line = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= idx) { line = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return { line: line + 1, col: idx - starts[line] + 1 };
  };
}

// 反查表：normalized hex -> 語意 token dotPath（優先語意層、避開 base primitives）
function buildHexIndex(manifest) {
  const idx = new Map();      // hex -> dotPath
  const chosen = new Map();   // hex -> 已選 token 的 rank
  if (!manifest?.flat) return idx;
  const rank = (name) => (name.startsWith('color-base-') ? 0 : name.startsWith('color-') ? 2 : 1);
  for (const [name, val] of manifest.flat) {
    for (const v of [val.light, val.dark]) {
      const h = normHex(v);
      if (!h) continue;
      const r = rank(name);
      if (!idx.has(h) || r > chosen.get(h)) {
        idx.set(h, name); // manifest 的 kebab name（可直接組成 var(--name)，不猜 dot-path）
        chosen.set(h, r);
      }
    }
  }
  return idx;
}

function normHex(v) {
  if (typeof v !== 'string') return null;
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(v.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return '#' + h;
}
// font-family 值 → 首位字型（去引號、去前後空白）。用於 ai-font 只認 primary family。
function firstFamily(value) {
  if (typeof value !== 'string') return '';
  const first = value.split(',')[0] ?? '';
  return first.replace(/["'`]/g, '').trim();
}
// 字型名正規化：去引號、摺疊空白、小寫（供 deny 集比對）。
function normFont(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/["'`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/* ============================================================
   fix --slop 專用：SSOT 精確反查（exact-match）＋ style-zone 精準定位。
   與偵測共用同一組 RE_HEX / RE_HEX_TAIL / styleZoneRanges / normHex——保證只在
   slop 關卡「認定寫死色」的同一處替換，且反查是「與 token 解析值完全相等」的 exact
   match（絕不最近似）。這是 dk fix 的第三種白名單機械動作，仍是校正、不是作曲：值全
   數來自使用者自己的 tokens.json（SSOT），替換是逐字元的雙射改寫。
   ============================================================ */

// 反查索引：normHex(僅 light 解析值) -> { semantic:[name], primitive:[name] }。
// 為何只比對 light 值（而非同時吃 dark）：寫死的 #hex 在預設（light）語境如實渲染成該色；
// var(--token) 在 :root（light）解析為 token 的 light 值——兩者在預設語境逐像素相等＝真雙射改寫。
// 若拿 dark 值反查，替換會改動 light 的渲染，因此一律不採。替換後的 dark 模式由 SSOT 自動適配。
// 只收 color-* token；border 等
// 解析為 rgba（normHex 回 null）自然排除。
export function buildColorFixIndex(manifest) {
  const idx = new Map();
  if (!manifest?.flat) return idx;
  for (const [name, val] of manifest.flat) {
    if (!name.startsWith('color-')) continue;
    const h = normHex(val?.light);
    if (!h) continue;
    let e = idx.get(h);
    if (!e) idx.set(h, e = { semantic: [], primitive: [] });
    if (name.startsWith('color-base-')) e.primitive.push(name);
    else e.semantic.push(name);
  }
  for (const e of idx.values()) { e.semantic.sort(); e.primitive.sort(); } // deterministic 排序
  return idx;
}

// deterministic 三層選擇（DESIGN.md 三層原則：元件只碰 semantic）：
//   · 恰好 1 個 semantic 同值            → exact（用它；即使同時有 primitive 同值也優先 semantic）
//   · >1 個 semantic 同值                → ambiguous（歧義，絕不猜；跳過並可見列出）
//   · 0 個 semantic、僅 primitive 同值    → primitive-only（不把 primitive var 注入元件碼；列為需人工）
//   · 完全無同值 token                   → none（無 exact match；列為需人工）
export function resolveColorFix(hex, index) {
  const h = normHex(hex);
  if (!h) return { kind: 'none' };
  const e = index.get(h);
  if (!e) return { kind: 'none' };
  if (e.semantic.length === 1) return { kind: 'exact', name: e.semantic[0], primitiveAlso: e.primitive.length > 0 };
  if (e.semantic.length > 1) return { kind: 'ambiguous', names: e.semantic };
  if (e.primitive.length) return { kind: 'primitive-only', names: e.primitive };
  return { kind: 'none' };
}

// 掃單檔、回傳每個「style-zone 內、property-anchored」寫死色的精準字元位移與反查判定。
// 位移用 RE_HEX_TAIL 取 m[0] 尾端 hex（即 RE_HEX 實際錨定的色值）→ [hexStart,hexEnd) 供精準替換。
// 非 style zone（HTML 屬性等）一律不入列（inStyle 擋掉），與 slop 關卡的 style zone 定義完全一致。
export function scanColorFixes(source, path, index) {
  const lc = lineColFn(source);
  const styleRanges = styleZoneRanges(source, path);
  const out = [];
  const seen = new Set(); // zone 若重疊，同一 hexStart 只計一次（避免重複替換同一處）
  // 每個 style zone 獨立執行 RE_HEX，避免 regex 跨越 zone 邊界。
  // 因 RE_HEX 的值字元類 `[^;{},]{0,256}` 會跨換行貪婪吞字——整檔跑時，style="color: #x"（值末
  // 無分號、極常見）可能把 zone 外的 #hex（如 HTML meta theme-color）吞成同一 match 的尾端，導致
  // 對 zone 外的位置動刀。以 zone 子字串為界，match 結構上不可能越出 zone → var() 一定落在合法的
  // CSS 宣告值位置；同時 zone 內的真色值（含末無分號者）仍被正常涵蓋（不因跨界吞併而漏修）。
  for (const [zs, ze] of styleRanges) {
    const zone = source.slice(zs, ze);
    for (const m of zone.matchAll(RE_HEX)) {
      const tail = RE_HEX_TAIL.exec(m[0]); // m[0] 尾端即 RE_HEX 錨定的色值（lookbehind 已排除 url(#id)）
      if (!tail) continue;
      const hexStart = zs + m.index + tail.index; // 換算回整檔絕對位移
      if (seen.has(hexStart)) continue;
      seen.add(hexStart);
      const hex = tail[0];
      const { line, col } = lc(hexStart);
      out.push({ hexStart, hexEnd: hexStart + hex.length, hex, line, col, decision: resolveColorFix(hex, index) });
    }
  }
  return out;
}
