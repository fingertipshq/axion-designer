/* ============================================================
   i18n —— findings、報告本文與命令輸出的共用語言層。
   語言優先序：DK_LANG > locale > en 預設。
   ── 指紋參考語（正確性地基）──────────────────────────────────────
   Finding 的 fingerprint 被 baseline、SARIF partialFingerprints/v1 與 dedupeKey 共用，
   因此不能依顯示語言改變。Finding 的 `fp` 固定使用 zh-TW 正規訊息；display `message`
   依 LANG 渲染，而 fingerprint 一律使用 `f.fp ?? f.message`。
   本模組的 fmsg(key,params) 因此同時吐 { message(LANG), fp(zh-TW) }，由 gate spread 進 finding。
   零依賴。
   ============================================================ */

export function resolveLang(env = process.env) {
  const explicit = String(env.DK_LANG ?? '').trim().toLowerCase();
  if (explicit) return explicit.startsWith('zh') ? 'zh-TW' : 'en'; // zh / zh-TW / zh_TW / zh-tw → zh-TW；其餘 → en
  const locale = String(env.LC_ALL || env.LC_MESSAGES || env.LANG || '').toLowerCase();
  return locale.includes('zh') ? 'zh-TW' : 'en'; // 未設定 → 偵測 locale；否則 en 預設
}
export const LANG = resolveLang();

/** 從 { 'zh-TW', en } 雙語物件取當前語言值；純字串（如使用者自訂規則文案）原樣返回。 */
export function tr(val, lang = LANG) {
  if (val && typeof val === 'object' && ('zh-TW' in val || 'en' in val)) return val[lang] ?? val['zh-TW'];
  return val;
}
/** 簡易二選一：pick(zh, en)。用於命令輸出等無指紋顧慮的一次性字串。 */
export function pick(zh, en) { return LANG === 'en' ? en : zh; }

/* ============================================================
   Finding 訊息目錄。每 key：m = { 'zh-TW', en } 訊息函式；x?（可選）= { 'zh-TW', en } fix 函式。
   fmsg(key, params) 回 { message: m[LANG], fp: m['zh-TW'], fix?: x[LANG] }。
   fp 恆取 zh-TW 指紋參考語，不隨顯示語言改變。
   ============================================================ */

// scale 強制的分類標籤（訊息內嵌，需雙語）。
const SCALE_LABEL = {
  spacing: { 'zh-TW': '間距', en: 'Spacing' },
  radius: { 'zh-TW': '圓角', en: 'Radius' },
  type: { 'zh-TW': '字級', en: 'Font size' },
};

const FCAT = {
  /* ---- contract（token 契約 / SSOT 同步）---- */
  'contract.naming': {
    m: { 'zh-TW': (p) => `命名不符 kebab-case：${p.path}`, en: (p) => `Naming is not kebab-case: ${p.path}` },
  },
  'contract.emptyValue': {
    m: { 'zh-TW': (p) => `空的 $value：${p.path}`, en: (p) => `Empty $value: ${p.path}` },
  },
  'contract.required': {
    m: { 'zh-TW': (p) => `缺少必要 token：${p.token}`, en: (p) => `Missing required token: ${p.token}` },
  },
  'contract.unresolvedAlias': {
    m: {
      'zh-TW': (p) => `token alias 無法解析：${p.token} [${p.mode}] → {${p.ref}}`,
      en: (p) => `Unresolved token alias: ${p.token} [${p.mode}] → {${p.ref}}`,
    },
    x: {
      'zh-TW': (p) => `修正 ${p.token} 的 alias chain，或補上 ${p.ref}。`,
      en: (p) => `Fix the alias chain for ${p.token}, or add ${p.ref}.`,
    },
  },
  'contract.aliasCycle': {
    m: {
      'zh-TW': (p) => `token alias 循環：${p.token} [${p.mode}] — ${p.cycle}`,
      en: (p) => `Token alias cycle: ${p.token} [${p.mode}] — ${p.cycle}`,
    },
    x: {
      'zh-TW': () => '打斷循環，讓 chain 最後指向具體值。',
      en: () => 'Break the cycle so the chain ends at a concrete value.',
    },
  },
  'contract.cssVarCollision': {
    m: {
      'zh-TW': (p) => `CSS variable 命名碰撞：${p.cssVar} 同時來自 ${p.paths}`,
      en: (p) => `CSS variable name collision: ${p.cssVar} comes from both ${p.paths}`,
    },
    x: {
      'zh-TW': () => '重命名其中一條 token dot-path；碰撞項在修正前不會被編譯。',
      en: () => 'Rename one token dot path; colliding entries are not compiled until fixed.',
    },
  },
  'contract.contrast': {
    m: {
      'zh-TW': (p) => `對比不足 ${p.valueFmt} < ${p.min} — ${p.fg} on ${p.bg} [${p.mode}]`,
      en: (p) => `Contrast too low ${p.valueFmt} < ${p.min} — ${p.fg} on ${p.bg} [${p.mode}]`,
    },
    x: {
      'zh-TW': (p) => `調整 tokens.json 讓 ${p.fg} 與 ${p.bg} 在 ${p.mode} 達標。`,
      en: (p) => `Adjust tokens.json so ${p.fg} and ${p.bg} pass in ${p.mode}.`,
    },
  },
  'ssot.missing': {
    m: { 'zh-TW': () => `找不到編譯產物（尚未 build）。`, en: () => `Compiled artifact not found (not built yet).` },
    x: { 'zh-TW': () => '執行 `dk build`。', en: () => 'Run `dk build`.' },
  },
  'ssot.drift': {
    m: { 'zh-TW': (p) => `${p.file} 與 SSOT 不同步。`, en: (p) => `${p.file} is out of sync with the SSOT.` },
    x: { 'zh-TW': () => '執行 `dk build` 重新編譯，再一起 commit。', en: () => 'Run `dk build` to recompile, then commit them together.' },
  },

  /* ---- slop（反 AI-slop）---- */
  'slop.hardcodedColor.known': {
    m: { 'zh-TW': (p) => `寫死顏色 ${p.hex} — 這其實是 ${p.cssVar}`, en: (p) => `Hardcoded color ${p.hex} — this is really ${p.cssVar}` },
    x: { 'zh-TW': (p) => `改用 ${p.cssVar}`, en: (p) => `Use ${p.cssVar}` },
  },
  'slop.hardcodedColor.unknown': {
    m: { 'zh-TW': (p) => `寫死顏色（改用 var(--token)）：${p.evidence}`, en: (p) => `Hardcoded color (use var(--token)): ${p.evidence}` },
    x: { 'zh-TW': () => '把顏色抬進 tokens.json 並改用 var(--token)。', en: () => 'Lift the color into tokens.json and use var(--token).' },
  },
  'slop.unknownTokenReference': {
    m: {
      'zh-TW': (p) => `引用了 token manifest 不存在的 ${p.cssVar}${p.hasFallback ? '（雖有 fallback，仍未納入 token 契約）' : ''}`,
      en: (p) => `Referenced ${p.cssVar}, which is absent from the token manifest${p.hasFallback ? ' (a fallback exists, but it is still outside the token contract)' : ''}`,
    },
    x: {
      'zh-TW': (p) => `改用存在的 var(--token)，或在 tokens.json 定義 ${p.cssVar} 後重新 build。`,
      en: (p) => `Use an existing var(--token), or define ${p.cssVar} in tokens.json and rebuild.`,
    },
  },
  'slop.aiFont.builtin': {
    m: { 'zh-TW': (p) => `AI 預設字體（${p.font}）在首位——請刻意選字`, en: (p) => `AI default font (${p.font}) in the primary slot — choose type deliberately` },
  },
  'slop.aiFont.custom': {
    m: { 'zh-TW': (p) => `被 deny 的字體（${p.font}）在首位——config.slop.fonts.deny`, en: (p) => `Denied font (${p.font}) in the primary slot — config.slop.fonts.deny` },
  },
  'slop.gradientHero': {
    m: { 'zh-TW': () => '疑似紫/靛漸層 hero（AI 指紋）', en: () => 'Suspected purple/indigo gradient hero (AI fingerprint)' },
  },
  'slop.emojiHeading': {
    m: { 'zh-TW': () => '標題以 emoji 開頭——避免用 emoji 當區塊符號', en: () => 'Heading starts with an emoji — avoid emoji as section bullets' },
  },
  'slop.vanityNumber': {
    m: { 'zh-TW': (p) => `疑似虛榮數字（${p.token}）——請用可溯源的真數字`, en: (p) => `Suspected vanity number (${p.token}) — use a real, sourceable figure` },
  },
  'slop.offScale': {
    m: {
      'zh-TW': (p) => `${tr(SCALE_LABEL[p.cat], 'zh-TW')} ${p.len} 不在 ${p.scale} scale — off-scale 值繞過 token 治理`,
      en: (p) => `${tr(SCALE_LABEL[p.cat], 'en')} ${p.len} is not on the ${p.scale} scale — off-scale value bypasses token governance`,
    },
    x: {
      'zh-TW': (p) => `改用最接近的 var(--${p.varName}-*)。`,
      en: (p) => `Use the nearest var(--${p.varName}-*).`,
    },
  },
  'slop.customError': {
    m: { 'zh-TW': (p) => `自訂規則拋錯：${p.msg}`, en: (p) => `Custom rule threw: ${p.msg}` },
  },

  /* ---- heavy：css-strict / a11y / visual ---- */
  'heavy.cssStrict.fix': {
    // message 由 stylelint 給（英文、語言中性）；只有 fix 是 dk 文案。以 message 佔位、只取 fix。
    m: { 'zh-TW': (p) => p.text, en: (p) => p.text },
    x: { 'zh-TW': () => '把該值抬進 tokens.json 改用 var(--token)，或跑 `dk fix`。', en: () => 'Lift the value into tokens.json and use var(--token), or run `dk fix`.' },
  },
  'a11y.contrast': {
    m: {
      'zh-TW': (p) => `${p.id}: 對比違規（${p.selector}）——contract 已證 ${p.n} 組 token 配色達標；此處用了未驗證的值`,
      en: (p) => `${p.id}: contrast violation (${p.selector}) — contract proved ${p.n} token color pairs pass; this uses an unverified value`,
    },
  },
  'a11y.generic': {
    m: {
      'zh-TW': (p) => `${p.id}: ${p.help}（${p.selector}）`,
      en: (p) => `${p.id}: ${p.help} (${p.selector})`,
    },
  },
  'a11y.fix.url': {
    m: { 'zh-TW': (p) => p.url, en: (p) => p.url },
    x: { 'zh-TW': (p) => `依 axe 指引修正：${p.url}`, en: (p) => `Follow the axe guidance: ${p.url}` },
  },
  'a11y.fix.noUrl': {
    m: { 'zh-TW': () => '', en: () => '' },
    x: { 'zh-TW': () => '依 Finding 指出的元素修正結構/標籤。', en: () => 'Fix the structure/label on the element the finding points to.' },
  },
  'visual.updateRefused': {
    m: {
      'zh-TW': () => '拒絕更新視覺基準：既有 baseline 與目前像素不同；tokenHash 不構成因果豁免。',
      en: () => 'Refusing to update the visual baseline: pixels differ from the existing baseline; tokenHash is not a causal waiver.',
    },
    x: {
      'zh-TW': () => '先確認這不是回歸（去查最近的樣式/版面改動）；若確為刻意改版，用 DK_UPDATE_VISUAL=force 明確蓋章更新。',
      en: () => 'First confirm this is not a regression (check recent style/layout changes); if it is a deliberate redesign, stamp it with DK_UPDATE_VISUAL=force to update.',
    },
  },
  'visual.created': {
    m: { 'zh-TW': (p) => `已建立視覺基準（tokenHash ${p.hash}）`, en: (p) => `Visual baseline created (tokenHash ${p.hash})` },
    x: {
      'zh-TW': () => '之後 dk verify --full / --gate visual 會以此基準比對；任何超出容差的 pixel diff 都會擋關。',
      en: () => 'Later dk verify --full / --gate visual compares against this baseline; every pixel diff beyond tolerance blocks.',
    },
  },
  'visual.synced': {
    m: { 'zh-TW': (p) => `基準畫面一致，已同步 tokenHash 為 ${p.hash}`, en: (p) => `Baseline screen matches; synced tokenHash to ${p.hash}` },
  },
  'visual.updated': {
    m: { 'zh-TW': (p) => `已更新視覺基準（${p.why}）`, en: (p) => `Visual baseline updated (${p.why})` },
  },
  'visual.noHash': {
    m: {
      'zh-TW': () => `視覺回歸：畫面與基準不符；基準沒有 tokenHash 稽核脈絡，仍以 pixel diff 擋關。`,
      en: () => `Visual regression: pixels differ from baseline; the baseline has no tokenHash audit context, so the pixel diff still blocks.`,
    },
    x: {
      'zh-TW': () => '人工審查 diff；若新畫面確為預期，再以 DK_UPDATE_VISUAL=force 重建帶 tokenHash 稽核脈絡的基準。',
      en: () => 'Review the diff; if the new appearance is intentional, rebuild the baseline with tokenHash audit context via DK_UPDATE_VISUAL=force.',
    },
  },
  'visual.unchangedHash': {
    m: {
      'zh-TW': (p) => `視覺回歸：畫面已變但 tokenHash 未變（${p.hash}）；差異可能來自 token 來源之外的程式、內容或渲染環境，仍須人工審查。`,
      en: (p) => `Visual regression: pixels changed while tokenHash stayed ${p.hash}; the difference may come from code, content, or the rendering environment outside the token source and still requires human review.`,
    },
    x: {
      'zh-TW': () => '檢查最近的樣式、版面、元件、內容與瀏覽器環境；若差異確為刻意，以 DK_UPDATE_VISUAL=force 明確接受。',
      en: () => 'Check recent styles, layout, components, content, and browser environment; if the difference is intentional, explicitly accept it with DK_UPDATE_VISUAL=force.',
    },
  },

  /* ---- ledger（鏈自身）---- */
  'ledger.noTargets': {
    m: {
      'zh-TW': () => 'targets 掃到 0 檔——沒有東西被把關（檢查 targets glob / 路徑）。',
      en: () => 'targets matched 0 files — nothing is being checked (check the targets glob / paths).',
    },
  },
  'ledger.gateError': {
    m: { 'zh-TW': (p) => `關卡 ${p.gate} 執行時拋錯：${p.msg}`, en: (p) => `Gate ${p.gate} threw while running: ${p.msg}` },
  },
  'ledger.fatalTokens': {
    m: {
      'zh-TW': (p) => `讀不到 / 解析失敗 tokens：${p.path}\n  ${p.msg}`,
      en: (p) => `Cannot read / parse tokens: ${p.path}\n  ${p.msg}`,
    },
  },

  /* ---- config 健全性錯誤（reportConfigErrors 顯示；非 findings 管線，指紋不參與 baseline）---- */
  'config.unknownPreset': {
    m: { 'zh-TW': (p) => `未知的 preset '${p.preset}'（可用：${p.avail}）`, en: (p) => `Unknown preset '${p.preset}' (available: ${p.avail})` },
    x: { 'zh-TW': () => `把 preset 改成 recommended / strict / minimal 其中之一。`, en: () => `Set preset to one of recommended / strict / minimal.` },
  },
  'config.badFailOn': {
    m: { 'zh-TW': (p) => `failOn 必須是 'error' 或 'warn'（收到 '${p.got}'）`, en: (p) => `failOn must be 'error' or 'warn' (got '${p.got}')` },
    x: { 'zh-TW': () => `把 failOn 設成 'error'（預設）或 'warn'。`, en: () => `Set failOn to 'error' (default) or 'warn'.` },
  },
  'config.badTargets': {
    m: { 'zh-TW': () => `targets 必須是字串陣列（glob）。`, en: () => `targets must be an array of strings (globs).` },
    x: { 'zh-TW': () => `例：targets: ['src/**/*.{html,tsx}']`, en: () => `e.g. targets: ['src/**/*.{html,tsx}']` },
  },
  'config.badAlgorithm': {
    m: { 'zh-TW': (p) => `contrast.algorithm 必須是 'wcag' 或 'apca'（收到 '${p.got}'）。`, en: (p) => `contrast.algorithm must be 'wcag' or 'apca' (got '${p.got}').` },
    x: { 'zh-TW': () => `wcag = AA 比值門檻；apca = 感知對比 Lc。`, en: () => `wcag = AA ratio thresholds; apca = perceptual contrast Lc.` },
  },
};

/** 依 key + params 產 { message(LANG), fp(zh-TW), fix?(LANG) }。gate 直接 spread 進 makeFinding partial。 */
export function fmsg(key, params = {}) {
  const e = FCAT[key];
  if (!e) return { message: key, fp: key };
  const out = { message: e.m[LANG](params), fp: e.m['zh-TW'](params) };
  if (e.x) out.fix = e.x[LANG](params);
  return out;
}

/* ============================================================
   關卡 skipped reason / 其他非-finding 顯示字串（不進指紋，只需 display 語言）。
   ============================================================ */
const SR = {
  'heavy.notEnabled': { 'zh-TW': () => '未啟用（--full，或 config.gates 設 enabled:true 可開啟）', en: () => 'not enabled (use --full, or set config.gates.<id>.enabled:true)' },
  'css.noStylelint': { 'zh-TW': () => '未安裝 stylelint（dk doctor 看安裝指令）', en: () => 'stylelint not installed (run dk doctor for the install command)' },
  'css.noFiles': { 'zh-TW': () => '無 CSS/樣式檔可檢查', en: () => 'no CSS/style files to check' },
  'css.runFail': { 'zh-TW': (p) => `stylelint 執行失敗（${p.why}）`, en: (p) => `stylelint failed to run (${p.why})` },
  'css.unparsable': { 'zh-TW': () => 'stylelint 輸出無法解析（stdout/stderr 皆非合法 JSON 陣列）', en: () => 'stylelint output could not be parsed (neither stdout nor stderr is a valid JSON array)' },
  'a11y.missingDeps': { 'zh-TW': (p) => `未安裝 ${p.deps}（dk doctor 看安裝指令）`, en: (p) => `${p.deps} not installed (run dk doctor for the install command)` },
  'a11y.noHtml': { 'zh-TW': () => '無 .html target 可供 axe 渲染', en: () => 'no .html target for axe to render' },
  'a11y.runFail': { 'zh-TW': (p) => `a11y runner 無法執行（${p.why}）— 可能缺 chromium：npx playwright install chromium`, en: (p) => `a11y runner could not run (${p.why}) — chromium may be missing: npx playwright install chromium` },
  'a11y.unparsable': { 'zh-TW': () => 'a11y runner 輸出無法解析', en: () => 'a11y runner output could not be parsed' },
  'visual.noPlaywright': { 'zh-TW': () => '未安裝 @playwright/test（dk doctor 看安裝指令）', en: () => '@playwright/test not installed (run dk doctor for the install command)' },
  'visual.noSpec': { 'zh-TW': (p) => `無 ${p.spec}（視覺關卡需要 playwright 規格檔來截圖）`, en: (p) => `no ${p.spec} (the visual gate needs a playwright spec file to screenshot)` },
  'visual.pwFail': { 'zh-TW': (p) => `playwright 執行失敗（${p.msg}）`, en: (p) => `playwright failed to run (${p.msg})` },
  'visual.createFail': { 'zh-TW': (p) => `建立視覺基準失敗（${p.diag}）`, en: (p) => `failed to create the visual baseline (${p.diag})` },
  'visual.updateFail': { 'zh-TW': (p) => `更新視覺基準失敗（${p.diag}）`, en: (p) => `failed to update the visual baseline (${p.diag})` },
  'visual.noBaseline': { 'zh-TW': () => '無視覺基準快照——先建立 baseline（DK_UPDATE_VISUAL=1 dk verify --gate visual）', en: () => 'no visual baseline snapshot — create one first (DK_UPDATE_VISUAL=1 dk verify --gate visual)' },
};
/** skipped reason / 診斷字串（display 語言）。 */
export function sr(key, params = {}) {
  const e = SR[key];
  return e ? e[LANG](params) : key;
}

// 視覺 baseline 更新的 why 子字串（display 語言）。
export function visualWhy(kind, params = {}) {
  return pick('強制（force）', 'forced (force)');
}
