/* ============================================================
   Finding 記錄、Rule 契約與規則登錄表。
   每道關卡只能「產生 Finding」；每個表面只「消費 Finding」。
   零依賴。
   ============================================================ */

import { LANG, tr } from './i18n.mjs';

export const SEVERITIES = ['error', 'warn', 'info'];
const SEVERITY_SET = new Set([...SEVERITIES, 'off']);

/**
 * Finding — 全系統唯一的發現記錄。關卡回傳 Finding[]；報告消費 Finding[]。
 * @typedef {Object} Finding
 * @property {string}  ruleId    'category/name'（如 slop/hardcoded-color）
 * @property {'error'|'warn'|'info'} severity
 * @property {string|null} file   repo 相對路徑
 * @property {number|null} line   1-based
 * @property {number|null} col    1-based
 * @property {string}  message
 * @property {string=} evidence   觸發的原始片段
 * @property {string=} fix        一行怎麼修
 * @property {string=} docs       'dk explain <ruleId>'
 * @property {object=} meta       規則專屬結構化資料
 */

/** 填預設＋驗證，回傳規範化的 Finding。 */
export function makeFinding(partial = {}) {
  const ruleId = partial.ruleId;
  if (!ruleId || typeof ruleId !== 'string') {
    throw new Error(`makeFinding: 缺少 ruleId（收到 ${JSON.stringify(ruleId)}）`);
  }
  const rule = RULES[ruleId];
  const severity = partial.severity ?? rule?.severity ?? 'error';
  if (!SEVERITY_SET.has(severity)) {
    throw new Error(`makeFinding: 非法 severity '${severity}'（rule ${ruleId}）`);
  }
  // message = 顯示語言（LANG）；fp = 語言中性指紋參考（zh-TW 正規訊息，見 i18n.mjs 抬頭）。
  // gate 走 i18n.fmsg() 會同時給 message+fp；未給 fp 者（自訂規則、stylelint 文案等語言中性/
  // 使用者文案）退回 message；連 message 都沒給者（如 slop/lorem）用規則 title 的 zh-TW 分支當 fp。
  const message = partial.message ?? tr(rule?.title) ?? ruleId;
  const fp = partial.fp ?? partial.message ?? tr(rule?.title, 'zh-TW') ?? ruleId;
  return {
    ruleId,
    severity,
    file: partial.file ?? null,
    line: partial.line ?? null,
    col: partial.col ?? null,
    message,
    fp,
    evidence: partial.evidence,
    fix: partial.fix ?? tr(rule?.fix),
    docs: partial.docs ?? `dk explain ${ruleId}`,
    meta: partial.meta,
  };
}

/**
 * Rule — 規則契約。內建規則以資料表達，可被 config 覆寫 severity。
 * @typedef {Object} Rule
 * @property {string} id
 * @property {string} title
 * @property {string} category  'tokens'|'slop'|'a11y'|'visual'|'brand'|string
 * @property {'style'|'text'|'markup'|'token'=} zone
 * @property {'error'|'warn'|'info'|'off'} severity  預設，可被 config.severity 覆寫
 * @property {string} why
 * @property {string} fix
 * @property {boolean=} heavy   需安裝依賴、只在 --full 跑
 * @property {(ctx:any)=>Finding[]=} test  程式式自訂規則專用
 */

// 內建規則登錄表把 title/why/fix 與每個 Finding 的規則身分放在一起。
// 雙語欄位使用 { 'zh-TW', en }，讀取一律經 tr()。
export const RULES = Object.create(null);

function register(rule) {
  RULES[rule.id] = rule;
  return rule;
}

/* ---- tokens：SSOT / 契約 / 對比（零依賴核心） ---- */
register({
  id: 'tokens/ssot-sync',
  title: { 'zh-TW': 'tokens.css 必須與 tokens.json 同步', en: 'tokens.css must stay in sync with tokens.json' },
  category: 'tokens',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': '編譯產物是唯一真相的投影。若手改產物或忘了重編，主題與換膚會悄悄失真——原始碼與畫面各說各話。', en: 'The compiled artifact is a projection of the single source of truth. Hand-edit it or forget to recompile, and theming/reskinning silently drifts — source and screen tell different stories.' },
  fix: { 'zh-TW': '執行 `dk build` 重新編譯，然後一起 commit tokens.json 與 tokens.css。', en: 'Run `dk build` to recompile, then commit tokens.json and tokens.css together.' },
});
register({
  id: 'tokens/structure',
  title: { 'zh-TW': '每個 leaf token 必須有非空 $value', en: 'Every leaf token must have a non-empty $value' },
  category: 'tokens',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': '空的或缺失的 $value 會編出無效的 CSS 變數，讓所有引用它的元件靜默壞掉。', en: 'An empty or missing $value compiles to an invalid CSS variable, silently breaking every component that references it.' },
  fix: { 'zh-TW': '在 tokens.json 給該 token 一個具體 $value（或用 {alias} 指向另一個 token）。', en: 'Give the token a concrete $value in tokens.json (or point it at another token with {alias}).' },
});
register({
  id: 'tokens/naming',
  title: { 'zh-TW': 'token 命名必須是 kebab-case 或純數字階梯', en: 'Token names must be kebab-case or a pure-number ramp' },
  category: 'tokens',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': '一致的命名是契約穩定的前提；混用大小寫/底線會讓自動編譯與跨團隊引用碎裂。', en: 'Consistent naming is the premise of a stable contract; mixing case/underscores fractures auto-compilation and cross-team references.' },
  fix: { 'zh-TW': '把 token 的 key 改成 kebab-case（如 on-accent）或純數字（如 space.4）。', en: 'Rename the token key to kebab-case (e.g. on-accent) or a pure number (e.g. space.4).' },
});
register({
  id: 'tokens/required',
  title: { 'zh-TW': '必要語意 token 必須齊全', en: 'Required semantic tokens must be complete' },
  category: 'tokens',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': '語意層是元件唯一該碰的介面。缺少必要 token 等於契約破洞，換品牌時會露出未定義的洞。', en: 'The semantic layer is the only interface components should touch. A missing required token is a hole in the contract that shows up as undefined gaps when you rebrand.' },
  fix: { 'zh-TW': '在 tokens.json 補齊缺少的語意 token；用 config.tokens_required 擴充你自己的必要清單。', en: 'Add the missing semantic tokens to tokens.json; extend your own required list with config.tokens_required.' },
});
register({
  id: 'tokens/unresolved-alias',
  title: { 'zh-TW': 'token alias 必須指向存在的 token', en: 'Token aliases must point to an existing token' },
  category: 'tokens',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': '未解析 alias 會編出不存在的 CSS variable；當前 token 本身看似存在，元件卻在執行時才失效。', en: 'An unresolved alias compiles to a missing CSS variable: the token appears to exist but components fail only at runtime.' },
  fix: { 'zh-TW': '修正 {dot.path} 參照，或在 tokens.json 補上目標 token；淺色與深色 chain 都必須可解。', en: 'Correct the {dot.path} reference or add the target token; both light and dark chains must resolve.' },
});
register({
  id: 'tokens/alias-cycle',
  title: { 'zh-TW': 'token alias 不得形成循環', en: 'Token aliases must not form a cycle' },
  category: 'tokens',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': '循環 alias 永遠無法收旂成具體值，也會讓深色模式與建置產物不可預測。', en: 'A cyclic alias can never converge to a concrete value and makes modes and build output unpredictable.' },
  fix: { 'zh-TW': '打斷循環 chain，讓至少一個 token 指向具體值。', en: 'Break the cycle so at least one token in the chain points to a concrete value.' },
});
register({
  id: 'tokens/css-var-collision',
  title: { 'zh-TW': 'token dot-path 不得壓成同一個 CSS variable', en: 'Token dot paths must not collapse to the same CSS variable' },
  category: 'tokens',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': '`foo.bar-baz` 與 `foo-bar.baz` 都會變成 `--foo-bar-baz`。若任由後寫覆蓋，設計結果會取決於 JSON key 順序。', en: '`foo.bar-baz` and `foo-bar.baz` both become `--foo-bar-baz`. Last-write-wins would make design output depend on JSON key order.' },
  fix: { 'zh-TW': '重命名其中一條 dot-path，使壓平後的 CSS variable 唯一；衝突組在修正前不會被編譯。', en: 'Rename one dot path so the flattened CSS variable is unique; colliding entries are not compiled until fixed.' },
});
register({
  id: 'tokens/unknown-reference',
  title: { 'zh-TW': 'token namespace 不得引用 manifest 不存在的 CSS variable', en: 'Token namespaces must not reference a CSS variable absent from the manifest' },
  category: 'tokens',
  zone: 'style',
  severity: 'error',
  why: { 'zh-TW': '已受治理的 token namespace（如 `--color-*`）若拼錯，瀏覽器不會在 build 期報錯；fallback 可防無效 computed value，但仍代表元件繞過 token 契約。第三方或元件自有 namespace 不在此規則範圍。', en: 'Browsers do not report a misspelled variable inside a governed token namespace such as `--color-*`. A fallback can preserve a computed value, but the component still bypasses the token contract. Third-party and component-owned namespaces are outside this rule.' },
  fix: { 'zh-TW': '改用 manifest 內存在的 var(--token)，或先在 tokens.json 定義並重新 build。', en: 'Use an existing var(--token), or define it in tokens.json and rebuild first.' },
});
register({
  id: 'tokens/contrast',
  title: { 'zh-TW': '關鍵文字/底色對比必須在淺+深都達標', en: 'Key text/background contrast must pass in both light and dark' },
  category: 'tokens',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': '可用性不是選配。在 token 層就證明對比達 WCAG AA，token-driven 的頁面幾乎不可能再出對比違規。', en: 'Usability is not optional. Prove contrast meets WCAG AA at the token layer and token-driven pages can barely produce a contrast violation.' },
  fix: { 'zh-TW': '調整 tokens.json 裡該組 fg/bg 的色階直到達標；用 config.contrast.pairs 加你自己的必過組合。', en: 'Adjust the fg/bg color steps in tokens.json until they pass; add your own must-pass pairs with config.contrast.pairs.' },
});

/* ---- direction：AI 創意方向契約與 Taste Lock（零依賴核心） ---- */
register({
  id: 'direction/missing',
  title: { 'zh-TW': '要求的設計方向契約必須存在', en: 'A required design direction contract must exist' },
  category: 'direction',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': '沒有可攜的方向契約，AI 只能每回合重新猜品味；同一產品做出更多頁面後就會逐漸失去身份。', en: 'Without a portable direction contract, AI must guess the taste again every turn, so product identity decays as more screens are added.' },
  fix: { 'zh-TW': '執行 `dk design init`；只有新產品或改版才探索三個方向，選定後檢查並鎖定。', en: 'Run `dk design init`; explore three directions only for new work or redesign, then check and lock the selection.' },
});
register({
  id: 'direction/contract',
  title: { 'zh-TW': '設計方向必須具體、完整且可執行', en: 'The design direction must be concrete, complete, and executable' },
  category: 'direction',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': '「乾淨、現代、漂亮」不是方向。可執行的核心只保留任務脈絡、具體視覺身份與已解析的 semantic bindings。', en: '“Clean, modern, beautiful” is not a direction. The executable core keeps task context, concrete visual identity, and resolved semantic bindings.' },
  fix: { 'zh-TW': '依 Finding 指出的 path 補上真實內容與明確決策，再執行 `dk design check`。', en: 'Fill the reported path with real content and a concrete decision, then run `dk design check`.' },
});
register({
  id: 'direction/token-binding',
  title: { 'zh-TW': '方向角色必須綁到存在的語意 token', en: 'Direction roles must bind to existing semantic tokens' },
  category: 'direction',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': '方向若只停在文字，實作仍能任意發明色彩、字體與尺度。綁到 SSOT 才能把美感意圖帶進可驗證的程式碼。', en: 'If direction remains prose, implementation can still invent colors, type, and scales. Binding it to the SSOT carries aesthetic intent into verifiable code.' },
  fix: { 'zh-TW': '將 binding 改成 tokens.json 內可解析的 dot-path，或先建立對應語意 token。', en: 'Point the binding at a resolvable dot path in tokens.json, or create the semantic token first.' },
});
register({
  id: 'direction/draft',
  title: { 'zh-TW': '設計方向仍是草稿或尚未做出取捨', en: 'The design direction is still a draft or lacks real tradeoffs' },
  category: 'direction',
  zone: 'token',
  severity: 'warn',
  why: { 'zh-TW': '沒有選定的方向不能成為跨頁身份；只有平均形容詞、沒有構圖取捨與 signature，也無法約束 AI。', en: 'An unselected direction cannot become cross-screen identity; generic adjectives without composition tradeoffs or a signature cannot constrain AI.' },
  fix: { 'zh-TW': '新產品或改版時比較三個結構方向；選定後只把勝出的 identity 寫進契約並設為 approved。', en: 'For new work or redesign, compare three structural directions; keep only the selected identity in the contract and set approved.' },
});
register({
  id: 'direction/unlocked',
  title: { 'zh-TW': 'approved 方向必須建立 Taste Lock', en: 'An approved direction should have a Taste Lock' },
  category: 'direction',
  zone: 'token',
  severity: 'warn',
  why: { 'zh-TW': '沒有 direction hash，後續修改無法區分「刻意改版」與「AI 不小心飄移」。', en: 'Without a direction hash, later work cannot distinguish an intentional redesign from accidental AI drift.' },
  fix: { 'zh-TW': '審查方向後執行 `dk design lock --accept`。', en: 'After reviewing the direction, run `dk design lock --accept`.' },
});
register({
  id: 'direction/drift',
  title: { 'zh-TW': '設計方向不得未經審查偏離 Taste Lock', en: 'Design direction must not drift from its Taste Lock without review' },
  category: 'direction',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': '功能迭代不應偷偷改變品牌身份。方向差異必須和 token、畫面差異一起被看見與接受。', en: 'Feature work must not silently change brand identity. Direction deltas must be reviewed alongside token and pixel changes.' },
  fix: { 'zh-TW': '還原非預期改動；刻意改版則先審查，再執行 `dk design lock --accept` 並更新視覺基準。', en: 'Restore unintended edits; for an intentional redesign, review first, then run `dk design lock --accept` and update the visual baseline.' },
});
register({
  id: 'direction/approval-history',
  title: { 'zh-TW': '設計核准歷史必須保持完整且可驗證', en: 'Design approval history must remain intact and verifiable' },
  category: 'direction',
  zone: 'token',
  severity: 'error',
  why: { 'zh-TW': 'Taste Lock 只能指出目前狀態；防竄改核准鏈才能證明誰在何時接受了哪個改版，以及當時綁定的驗證證據。', en: 'A Taste Lock identifies current state; the tamper-evident approval chain proves who accepted each redesign, when, and with which verification evidence.' },
  fix: { 'zh-TW': '從版本控制還原 design/approval-history.json；只能以 `dk design lock --accept` 追加，不可手動覆寫、刪除或重排 entry。', en: 'Restore design/approval-history.json from version control; only append through `dk design lock --accept`, never rewrite, delete, or reorder entries.' },
});

/* ---- slop：token-aware 反 AI-slop（零依賴核心） ---- */
register({
  id: 'slop/hardcoded-color',
  title: { 'zh-TW': '不得寫死顏色（顏色屬性用 #hex）', en: 'No hardcoded colors (a #hex in a color property)' },
  category: 'slop',
  zone: 'style',
  severity: 'error',
  why: { 'zh-TW': '一個鬆散的 #hex 繞過 SSOT：它不會跟著換膚、會悄悄弄壞深色模式、也讓一致性無法被機器保證。', en: 'A loose #hex bypasses the SSOT: it will not follow reskinning, silently breaks dark mode, and makes consistency unprovable by machine.' },
  fix: { 'zh-TW': '把顏色抬進 tokens.json，改寫成 var(--token)。dk 會告訴你這個 #hex 對應哪個既有 token。', en: 'Lift the color into tokens.json and rewrite it as var(--token). dk tells you which existing token this #hex maps to.' },
});
register({
  id: 'slop/ai-font',
  title: { 'zh-TW': '不使用 AI 預設字體', en: 'No AI default fonts' },
  category: 'slop',
  zone: 'style',
  severity: 'error',
  why: { 'zh-TW': 'Inter / Roboto / DM Sans 等是生成式工具的預設指紋。刻意選字是「這是人做的」最便宜的訊號。', en: 'Inter / Roboto / DM Sans and friends are the default fingerprints of generative tools. Deliberate type choice is the cheapest signal that "a human made this."' },
  fix: { 'zh-TW': '在 tokens.json 的 font.family 選一個你刻意挑的字型；用 config.slop.fonts.allow/deny 定義白/黑名單。', en: 'Pick a deliberate typeface in tokens.json font.family; define allow/deny lists with config.slop.fonts.allow/deny.' },
});
register({
  id: 'slop/lorem',
  title: { 'zh-TW': '不得出現 lorem ipsum', en: 'No lorem ipsum' },
  category: 'slop',
  zone: 'text',
  severity: 'error',
  why: { 'zh-TW': 'placeholder 文案代表這頁還沒被真正想過。真實內容會逼出真實的版面決策。', en: 'Placeholder copy means the page has not really been thought through. Real content forces real layout decisions.' },
  fix: { 'zh-TW': '換成真實文案。內容先行，版面才誠實。', en: 'Replace it with real copy. Content first, then the layout is honest.' },
});
register({
  id: 'slop/gradient-hero',
  title: { 'zh-TW': 'hero 不用紫/靛漸層', en: 'No purple/indigo gradient hero' },
  category: 'slop',
  zone: 'style',
  severity: 'warn',
  why: { 'zh-TW': '紫到靛的對角漸層是最容易辨認的 AI 指紋之一。它讀起來像範本，不像品牌。', en: 'A purple-to-indigo diagonal gradient is one of the most recognizable AI fingerprints. It reads like a template, not a brand.' },
  fix: { 'zh-TW': '用單色 token 底或克制的 var(--shadow-*)；把強調留給內容本身。', en: 'Use a solid token background or a restrained var(--shadow-*); leave the emphasis to the content itself.' },
});
register({
  id: 'slop/emoji-heading',
  title: { 'zh-TW': '標題不以 emoji 當區塊符號', en: 'No emoji as heading section bullets' },
  category: 'slop',
  zone: 'markup',
  severity: 'warn',
  why: { 'zh-TW': '用 emoji 當標題項目符號是範本感的來源；它替代了真正的視覺層級決策。', en: 'Emoji as heading bullets is a source of template feel; it substitutes for a real visual-hierarchy decision.' },
  fix: { 'zh-TW': '移除標題開頭的 emoji，用字級/字重/字距建立層級。', en: 'Remove the leading emoji and build hierarchy with size/weight/tracking.' },
});
register({
  id: 'slop/vanity-number',
  title: { 'zh-TW': '不放虛榮數字（24/7、50+、100% 保證）', en: 'No vanity numbers (24/7, 50+, 100% guaranteed)' },
  category: 'slop',
  zone: 'text',
  severity: 'warn',
  why: { 'zh-TW': '「24/7」「50+」是無法溯源的空話。可信來自具體、可查證的真數字。', en: '"24/7" and "50+" are unsourceable filler. Credibility comes from concrete, verifiable real numbers.' },
  fix: { 'zh-TW': '換成可溯源的真實數字，或直接拿掉。', en: 'Replace with a sourceable real figure, or drop it.' },
});

/* ---- scale 強制：spacing / type / radius 必須落在 token 階梯。
        預設 off；由 config.enforce.* 或 strict preset 啟用。 ---- */
register({
  id: 'slop/hardcoded-spacing',
  title: { 'zh-TW': '間距必須來自 space ramp', en: 'Spacing must come from the space ramp' },
  category: 'slop',
  zone: 'style',
  severity: 'warn',
  why: { 'zh-TW': 'off-scale 的 padding/margin/gap 會破壞版面節奏。把間距鎖進 space ramp，整站的呼吸感才由 SSOT 統一控制、換膚時一起縮放。', en: 'Off-scale padding/margin/gap breaks layout rhythm. Lock spacing to the space ramp so the whole site\'s breathing is governed by the SSOT and scales together on reskin.' },
  fix: { 'zh-TW': '改用最接近的 var(--space-*)；要開關這條規則用 config.enforce.spacing（off | warn | error）。', en: 'Use the nearest var(--space-*); toggle this rule with config.enforce.spacing (off | warn | error).' },
});
register({
  id: 'slop/hardcoded-radius',
  title: { 'zh-TW': '圓角必須來自 radius scale', en: 'Radius must come from the radius scale' },
  category: 'slop',
  zone: 'style',
  severity: 'warn',
  why: { 'zh-TW': '散落的 border-radius 讓元件的圓角語言不一致。鎖進 radius scale 讓「多圓」變成一個可被機器保證的設計決策。', en: 'Scattered border-radius makes a component\'s corner language inconsistent. Lock it to the radius scale so "how round" becomes a machine-provable design decision.' },
  fix: { 'zh-TW': '改用 var(--radius-*)；要開關這條規則用 config.enforce.radius（off | warn | error）。', en: 'Use var(--radius-*); toggle this rule with config.enforce.radius (off | warn | error).' },
});
register({
  id: 'slop/hardcoded-type',
  title: { 'zh-TW': '字級必須來自 type scale', en: 'Font size must come from the type scale' },
  category: 'slop',
  zone: 'style',
  severity: 'warn',
  why: { 'zh-TW': 'off-scale 的 font-size 破壞字級階層。鎖進 type scale 讓層級由 SSOT 統一，避免 13px/15px/17px 這種無意義的碎裂。', en: 'Off-scale font-size breaks the type hierarchy. Lock it to the type scale so hierarchy is unified by the SSOT, avoiding meaningless 13px/15px/17px fragmentation.' },
  fix: { 'zh-TW': '改用 var(--font-size-*)；要開關這條規則用 config.enforce.type（off | warn | error）。', en: 'Use var(--font-size-*); toggle this rule with config.enforce.type (off | warn | error).' },
});

/* ---- config：鏈自身的健全性（掃 0 檔＝目標設定有誤，不能靜默綠燈） ---- */
register({
  id: 'config/no-targets',
  title: { 'zh-TW': 'targets 掃到 0 檔——鏈沒有東西可把關', en: 'targets matched 0 files — the chain has nothing to check' },
  category: 'config',
  zone: 'token',
  severity: 'warn',
  why: { 'zh-TW': '若 targets glob 打錯或路徑不存在，slop/a11y 可能掃描 0 個檔案。這不代表專案通過，因此必須明確回報。', en: 'If the targets glob is wrong or the path is missing, slop/a11y may scan zero files. That is not a verified pass and must be reported explicitly.' },
  fix: { 'zh-TW': '檢查 dk.config 的 targets 是否指向存在的檔案；或用 dk verify <glob> 明確指定要掃的檔。', en: 'Check that dk.config targets point at existing files; or pass dk verify <glob> to name the files explicitly.' },
});

/* ---- Axion Bridge：外部工具證據的信任、時效與 commit 綁定 ---- */
register({
  id: 'bridge/missing-evidence',
  title: { 'zh-TW': '必要外部連接必須留下可驗證證據', en: 'A required external connection must provide verifiable evidence' },
  category: 'bridge', zone: 'token', severity: 'error',
  why: { 'zh-TW': '連接器存在不等於證據存在。必要 provider 若沒有成功 envelope，PR 不能把「尚未同步」當成通過。', en: 'A configured connector is not evidence. When a required provider has no successful envelope, a PR must not treat “not synced” as a pass.' },
  fix: { 'zh-TW': '執行 `dk bridge sync <id>`，修正 provider 設定或將非必要連接明確標為 optional。', en: 'Run `dk bridge sync <id>`, fix the provider configuration, or explicitly make a nonessential connection optional.' },
});
register({
  id: 'bridge/invalid-evidence',
  title: { 'zh-TW': '外部證據 envelope 與 ledger 必須完整且防竄改', en: 'External evidence envelopes and their ledger must be complete and tamper-evident' },
  category: 'bridge', zone: 'token', severity: 'error',
  why: { 'zh-TW': '缺 schema、digest、provider 身分或被改寫的 artifact 無法證明來源，不能升級成 trusted evidence。', en: 'An artifact with no schema, digest, provider identity, or with modified bytes cannot establish provenance and must not become trusted evidence.' },
  fix: { 'zh-TW': '重新由原 provider 同步；不要手動編輯 `.dk/bridge/ledger.json`。', en: 'Sync again from the original provider; do not hand-edit `.dk/bridge/ledger.json`.' },
});
register({
  id: 'bridge/stale-evidence',
  title: { 'zh-TW': '外部證據必須在核准的新鮮度期限內', en: 'External evidence must remain within the approved freshness window' },
  category: 'bridge', zone: 'token', severity: 'error',
  why: { 'zh-TW': '昨天的成功不能證明今天的程式。過期 evidence 仍可供追溯，但不能滿足目前 gate。', en: 'Yesterday’s success does not prove today’s code. Expired evidence remains traceable but cannot satisfy the current gate.' },
  fix: { 'zh-TW': '重新執行 `dk bridge sync`，或在審查風險後調整 bridge.freshnessMs。', en: 'Run `dk bridge sync` again, or adjust bridge.freshnessMs after reviewing the risk.' },
});
register({
  id: 'bridge/commit-mismatch',
  title: { 'zh-TW': '外部證據必須綁定目前 repository commit', en: 'External evidence must bind to the current repository commit' },
  category: 'bridge', zone: 'token', severity: 'error',
  why: { 'zh-TW': '若 build、preview 或視覺測試不是目前 SHA，綠燈可能屬於另一版程式。', en: 'If a build, preview, or visual test does not belong to the current SHA, its green result may describe different code.' },
  fix: { 'zh-TW': '用目前 commit 重新執行 provider，並讓 adapter 回傳精確 SHA。', en: 'Run the provider for the current commit and make the adapter return the exact SHA.' },
});
register({
  id: 'bridge/provider-failed',
  title: { 'zh-TW': '必要外部 provider 必須成功完成', en: 'A required external provider must complete successfully' },
  category: 'bridge', zone: 'token', severity: 'error',
  why: { 'zh-TW': 'timeout、權限錯誤、HTTP 失敗或 provider 自身紅燈都是真實的不完整狀態，不能被吞掉。', en: 'A timeout, permission error, HTTP failure, or provider failure is a real incomplete state and must not be swallowed.' },
  fix: { 'zh-TW': '查看 connection error，修正權限、環境變數、網路或外部測試後重跑同步。', en: 'Inspect the connection error, fix permissions, environment variables, network, or external tests, then sync again.' },
});

/* ---- 重關卡：需安裝依賴、只在 --full 跑（登錄 metadata 供 explain/rules；
        實作由 heavy 關卡 pass 提供） ---- */
register({
  id: 'css/strict-value',
  title: { 'zh-TW': 'CSS 顏色/陰影必須來自 token', en: 'CSS colors/shadows must come from tokens' },
  category: 'css',
  zone: 'style',
  severity: 'error',
  heavy: true,
  why: { 'zh-TW': 'stylelint 的 strict-value 抓 anti-slop 正則漏掉的非-token 值，把「只用 var()」變成編譯期保證。', en: 'stylelint\'s strict-value catches non-token values the anti-slop regexes miss, turning "var() only" into a compile-time guarantee.' },
  fix: { 'zh-TW': '把該值抬進 tokens.json 並改用 var(--token)；或跑 `dk fix` 讓 stylelint --fix 機械修正。', en: 'Lift the value into tokens.json and use var(--token); or run `dk fix` to let stylelint --fix mechanically fix it.' },
});
register({
  id: 'a11y/axe',
  title: { 'zh-TW': '無 WCAG A/AA 無障礙違規', en: 'No WCAG A/AA accessibility violations' },
  category: 'a11y',
  zone: 'markup',
  severity: 'error',
  heavy: true,
  why: { 'zh-TW': 'axe 掃渲染後的頁面。因為契約已在 token 層證明對比，這裡抓到的多是結構性問題（label/roles/順序）。', en: 'axe scans the rendered page. Because the contract already proved contrast at the token layer, what surfaces here is mostly structural (labels/roles/order).' },
  fix: { 'zh-TW': '依 Finding 指出的元素修正；對比類違規會用 verifiedPairs 反查確切病灶。', en: 'Fix the element the finding points to; contrast violations use verifiedPairs to pinpoint the exact culprit.' },
});
register({
  id: 'visual/regression',
  title: { 'zh-TW': '畫面不得被 token/CSS 改動悄悄弄跑', en: 'The screen must not silently drift from a token/CSS change' },
  category: 'visual',
  zone: 'markup',
  severity: 'error',
  heavy: true,
  why: { 'zh-TW': '截圖 baseline 是畫面證據；全域 tokenHash 只記錄設計脈絡，不能證明某張快照的 pixel diff 由 token 造成，因此任何 diff 都維持 error。', en: 'A screenshot baseline is visual evidence. A global tokenHash records design context but cannot prove that tokens caused a specific snapshot diff, so every diff remains an error.' },
  fix: { 'zh-TW': '先修回非預期差異；若人工確認為刻意改版，再用 `DK_UPDATE_VISUAL=force dk verify --gate visual` 明確接受新基準。', en: 'Fix unintended drift; after a human confirms an intentional redesign, explicitly accept the new baseline with `DK_UPDATE_VISUAL=force dk verify --gate visual`.' },
});

/** 取單一規則（含內建與、若有、已註冊的自訂規則）。title/why/fix 為雙語物件，讀取請經下方存取器。 */
export function getRule(id) {
  return RULES[id] ?? null;
}
/* 規則欄位存取器：把雙語物件解析為顯示語言（LANG，或指定 lang）。自訂規則的字串原樣返回。 */
export function ruleTitle(rule, lang = LANG) { return tr(rule?.title, lang); }
export function ruleWhy(rule, lang = LANG) { return tr(rule?.why, lang); }
export function ruleFix(rule, lang = LANG) { return tr(rule?.fix, lang); }

/**
 * 列出當前生效的所有規則（內建 ∪ 自訂），套用 config.severity 覆寫後回傳。
 * 每筆附 resolvedSeverity 與 source，供 `dk rules` / `dk explain` 自省。
 */
export function listRules(config = {}) {
  const overrides = config.severity ?? {};
  const allowlist = config.allowlist ?? {};
  const custom = config.slopRules ?? [];
  const seen = new Set();
  const out = [];

  const emit = (rule, source) => {
    const resolvedSeverity = overrides[rule.id] ?? rule.severity ?? 'error';
    out.push({
      ...rule,
      resolvedSeverity,
      overridden: overrides[rule.id] != null && overrides[rule.id] !== rule.severity,
      source,
      allowlist: allowlist[rule.id] ?? [],
    });
    seen.add(rule.id);
  };

  for (const rule of Object.values(RULES)) emit(rule, 'builtin');
  for (const rule of custom) {
    if (seen.has(rule.id)) continue; // 自訂規則若與內建同 id，內建優先登錄過了
    emit({ category: rule.id.split('/')[0] || 'custom', zone: rule.zone, severity: rule.severity ?? 'warn',
           why: rule.why ?? rule.hint ?? '（自訂規則）', fix: rule.fix ?? rule.hint ?? '', title: rule.message ?? rule.id,
           ...rule }, 'config');
  }
  return out;
}
