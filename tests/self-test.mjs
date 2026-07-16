/* ============================================================
   dk 自測 — 端到端驗證公開行為與不變量。
   跑：node tests/self-test.mjs
   做什麼：在暫存工作區裡跑真正的 dk 子命令（子行程），斷言：
     · dk new 產物能過 dk verify（exit 0）
     · 每個反面 fixture 都會被對應規則擋下（exit 1）
     · baseline 棘輪、// dk-ignore 抑制、allowlist、config 錯誤都如預期
     · 所有子命令（new/init/verify/build/fix/baseline/tokens/…）都可跑
   無外部依賴——只用 node 內建與 dk 本身。
   ============================================================ */
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, watch as fsWatch, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
// 核心安全斷言直接 import 純函式（污染防護／a11y 翻譯層）；
// 其餘斷言仍以 dk 子行程驗證公開行為。
import { fromTokensStudio } from '../src/core/tokens.mjs';
import { a11yResultsToFindings } from '../src/gates/heavy.mjs';
import { createDirectionTemplate } from '../src/core/direction.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DK = join(REPO, 'bin', 'dk.mjs');
const GOOD_TOKENS = readFileSync(join(REPO, 'design', 'tokens.json'), 'utf8');
const BAD_HTML = readFileSync(join(REPO, 'gates', 'fixtures', 'bad.html'), 'utf8');
const BAD_TOKENS = readFileSync(join(REPO, 'gates', 'fixtures', 'tokens-bad.json'), 'utf8');
const BAD_CSS = readFileSync(join(REPO, 'gates', 'fixtures', 'bad.css'), 'utf8');
const BAD_JSX = readFileSync(join(REPO, 'gates', 'fixtures', 'Bad.jsx'), 'utf8');
const FP_CLEAN = readFileSync(join(REPO, 'gates', 'fixtures', 'fp-clean.html'), 'utf8');
const FP_STYLED = readFileSync(join(REPO, 'gates', 'fixtures', 'fp-styled.jsx'), 'utf8');

/* ---- 迷你斷言框架 ---- */
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail });
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  process.stdout.write(`  ${mark} ${name}${ok || !detail ? '' : `\n      ${detail}`}\n`);
}
function group(title) { process.stdout.write(`\n${title}\n`); }

/* ---- dk 子行程 ----
   共用 spawn helper 預設注入 DK_LANG='zh-TW'，讓中文 help／usage 斷言具決定性。
   第三參數 envExtra 可覆寫語言以驗證英文與 locale 偵測；值為 null/undefined 的 key
   會從環境移除（供顯式 unset DK_LANG）。 */
function dk(cwd, args, envExtra = {}) {
  const env = { ...process.env, NO_COLOR: '1', DK_LANG: 'zh-TW', ...envExtra };
  for (const k of Object.keys(env)) if (env[k] == null) delete env[k];
  const r = spawnSync(process.execPath, [DK, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function verifyJson(cwd, extra = []) {
  const r = dk(cwd, ['verify', '--json', ...extra]);
  let data = null;
  try { data = JSON.parse(r.out); } catch { /* */ }
  return { ...r, data, rules: data ? new Set(data.findings.map((f) => f.ruleId)) : new Set() };
}
// 讀持久化帳本 .dk/report.json（供 ledger 持久化不變量斷言使用）。
function readReport(cwd) {
  try { return JSON.parse(readFileSync(join(cwd, '.dk', 'report.json'), 'utf8')); } catch { return null; }
}
// 某 ruleId 的 Finding 筆數（精確計數，抓「多筆塌成一筆」的去重回歸）。
const countRule = (findings, id) => (findings ?? []).filter((f) => f.ruleId === id).length;
// dk slop <targets> --json —— 供反面 golden 用（回傳 filesScanned / findings 數 / ruleId 集）。
function slopJson(cwd, targets) {
  const r = dk(cwd, ['slop', ...targets, '--json']);
  let data = null;
  try { data = JSON.parse(r.out); } catch { /* */ }
  return {
    ...r, data,
    n: data?.findings?.length ?? 0,
    scanned: data?.filesScanned ?? 0,
    rules: new Set((data?.findings ?? []).map((f) => f.ruleId)),
  };
}

/* ---- 暫存工作區 ---- */
function ws(name, files) {
  const dir = mkdtempSync(join(tmpdir(), `dk-${name}-`));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}
const config = (o = {}) =>
  `export default ${JSON.stringify({
    tokens: { source: 'design/tokens.json', output: { css: 'styles/tokens.css' } },
    targets: ['*.html'],
    ...o,
  })};\n`;
const hasAll = (set, ids) => ids.every((id) => set.has(id));

// 一份真的、可鎖定的 UI 方向契約。不直接寫 fixture JSON，而是從公開 template
// 開始填寫，才能在 template 日後新增必填欄位時讓這個 golden 立即飄紅。
function goodDirection() {
  const d = createDirectionTemplate();
  d.status = 'approved';
  d.name = 'Quiet Signal';
  d.context = {
    register: 'product',
    product: 'A focused launch dashboard that turns release risk into one clear decision.',
    audience: ['Product engineers shipping high-trust web applications'],
    task: 'Understand whether a release is safe to ship right now',
    action: 'Approve the release',
    constraints: ['Keep release status understandable without relying on color alone'],
  };
  d.identity = {
    thesis: 'Make release confidence feel calm, legible, and earned before asking for approval.',
    qualities: ['calibrated', 'editorial', 'decisive'],
    signature: 'A confidence rail links every claim to its strongest piece of evidence.',
    composition: 'A dominant evidence column and narrow decision rail keep causality visible.',
    responsive: 'Move the decision summary before evidence on mobile while preserving reading order.',
    typography: 'Serif display moments frame decisions; system sans keeps evidence fast to scan.',
    color: 'Neutral paper holds evidence; semantic state color and accent serve only decisions.',
    form: 'Rectilinear evidence regions use restrained corners and borders instead of decorative depth.',
    motion: 'Motion explains state transitions, never decorates idle data, and honors reduced motion.',
    media: 'Use small evidence plots only when they clarify change over time; no stock imagery.',
    avoid: ['glowing dashboard chrome', 'interchangeable grids of decorative metric cards'],
  };
  return d;
}

/* ============================================================ */
process.stdout.write('dk self-test — 端到端\n');

/* 1) dk new 產物能過 dk verify */
group('dk new → dk verify（新工作區預設可通過）');
{
  const parent = mkdtempSync(join(tmpdir(), 'dk-new-'));
  const created = dk(parent, ['new', 'portfolio']);
  const wsDir = join(parent, 'portfolio');
  check('dk new 建立工作區', created.code === 0 && existsSync(join(wsDir, 'index.html')));
  const v = verifyJson(wsDir);
  check('scaffold 通過 dk verify（exit 0）', v.code === 0, `code=${v.code} rules=${[...v.rules]}`);
  check('scaffold 零 findings', v.data && v.data.findings.length === 0, `findings=${v.data?.findings.length}`);
}

/* 2) 反面 fixture：anti-slop 規則均能阻擋對應違規 */
group('反面 fixture：slop 規則均可阻擋違規');
{
  const dir = ws('slop', { 'design/tokens.json': GOOD_TOKENS, 'bad.html': BAD_HTML, 'dk.config.mjs': config({ preset: 'strict' }) });
  dk(dir, ['build']);
  const v = verifyJson(dir);
  check('slop fixture exit 1', v.code === 1, `code=${v.code}`);
  const want = ['slop/hardcoded-color', 'slop/ai-font', 'slop/lorem', 'slop/gradient-hero', 'slop/emoji-heading', 'slop/vanity-number', 'slop/hardcoded-spacing'];
  check('七條 slop 規則全部命中', hasAll(v.rules, want), `缺：${want.filter((w) => !v.rules.has(w))}`);
  const rev = (v.data?.findings ?? []).find((f) => /color-brand-accent/.test(f.message || ''));
  check('#hex 反查最近 token（#0071e3 → color-brand-accent）', !!rev, rev ? rev.message : '(未見反查訊息)');
  const withLine = (v.data?.findings ?? []).find((f) => f.ruleId === 'slop/hardcoded-color' && f.line);
  check('Finding 帶精確 file:line', !!withLine, withLine ? `${withLine.file}:${withLine.line}` : '(無行號)');
}

/* 2b) 反面 golden：style-zone 檔類型感知（.css / CSS-in-JS .jsx）＋ 絕對路徑 */
group('style-zone 覆蓋（.css / .jsx / 絕對路徑 / 星平面 emoji）');
{
  const dir = ws('slopzone', {
    'design/tokens.json': GOOD_TOKENS,
    'bad.css': BAD_CSS,
    'Bad.jsx': BAD_JSX,
    'dk.config.mjs': config({ preset: 'strict', targets: ['*.css', '*.jsx'] }),
  });
  dk(dir, ['build']);

  // 獨立 .css 整檔視為 style zone，寫死色／字型／漸層都必須產生 findings。
  const css = slopJson(dir, ['bad.css']);
  check('bad.css filesScanned>=1', css.scanned >= 1, `scanned=${css.scanned}`);
  check('bad.css findings>=1', css.n >= 1, `n=${css.n} rules=${[...css.rules]}`);
  check('bad.css 命中 slop/hardcoded-color', css.rules.has('slop/hardcoded-color'), `rules=${[...css.rules]}`);

  // CSS-in-JS .jsx：styled 樣板字串 + style={{…}} 都是 style zone
  const jsx = slopJson(dir, ['Bad.jsx']);
  check('Bad.jsx filesScanned>=1', jsx.scanned >= 1, `scanned=${jsx.scanned}`);
  check('Bad.jsx findings>=1', jsx.n >= 1, `n=${jsx.n} rules=${[...jsx.rules]}`);
  check('Bad.jsx 引號寫死色被抓（RE_HEX 不再被引號放行）', jsx.rules.has('slop/hardcoded-color'), `rules=${[...jsx.rules]}`);

  // repo 內的絕對路徑會正規化為 repo-root 相對路徑，並納入掃描與 findings。
  const abs = slopJson(dir, [join(dir, 'bad.css')]);
  check('絕對路徑 filesScanned>=1（不再假通過）', abs.scanned >= 1, `scanned=${abs.scanned} exit=${abs.code}`);
  check('絕對路徑 findings>=1', abs.n >= 1, `n=${abs.n} exit=${abs.code}`);
}

/* 2c) 星平面 emoji 標題（字素級偵測）*/
group('emoji-heading 依字素判定（🚀 U+1F680 星平面）');
{
  const dir = ws('emoji', {
    'design/tokens.json': GOOD_TOKENS,
    'rocket.html': '<h1>🚀 Launch</h1>\n<h2>☀ Sun</h2>\n',
    'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'] }),
  });
  dk(dir, ['build']);
  const em = slopJson(dir, ['rocket.html']);
  check('星平面 🚀 標題被抓（Array.from + Extended_Pictographic）', em.rules.has('slop/emoji-heading'), `rules=${[...em.rules]}`);
}

/* 3) 反面 fixture：token contract 規則均能阻擋對應違規 */
group('反面 fixture：token contract（結構／命名／必要值／對比）');
{
  const dir = ws('contract', { 'design/tokens.json': BAD_TOKENS, 'dk.config.mjs': config() });
  dk(dir, ['build']);
  const v = verifyJson(dir);
  check('contract fixture exit 1', v.code === 1, `code=${v.code}`);
  const want = ['tokens/naming', 'tokens/structure', 'tokens/required', 'tokens/contrast'];
  check('四條 contract 規則全部命中', hasAll(v.rules, want), `缺：${want.filter((w) => !v.rules.has(w))}`);
}

/* 4) SSOT 同步：產物漂移被擋 */
group('SSOT 同步：tokens.css 漂移會阻擋驗證');
{
  const dir = ws('drift', { 'design/tokens.json': GOOD_TOKENS, 'styles/tokens.css': '/* 手改的過時產物 */\n:root{}\n', 'dk.config.mjs': config() });
  const v = verifyJson(dir);
  check('漂移的 tokens.css exit 1', v.code === 1, `code=${v.code}`);
  check('命中 tokens/ssot-sync', v.rules.has('tokens/ssot-sync'), `rules=${[...v.rules]}`);
  // dk build --check 也應偵測漂移
  const chk = dk(dir, ['build', '--check']);
  check('dk build --check 偵測漂移（exit 1）', chk.code === 1, `code=${chk.code}`);
}

/* 5) baseline 棘輪：接受既有債後只擋新增 */
group('baseline 棘輪：接受既有違規後只阻擋新增項目');
{
  const dir = ws('baseline', { 'design/tokens.json': GOOD_TOKENS, 'bad.html': BAD_HTML, 'dk.config.mjs': config({ preset: 'strict', failOnSkipped: false }) });
  dk(dir, ['build']);
  const before = verifyJson(dir);
  check('baseline 前：exit 1', before.code === 1);
  const dry = dk(dir, ['baseline']);
  check('dk baseline（無 --accept）不寫檔、只預覽', dry.code === 0 && !existsSync(join(dir, '.dk', 'baseline.json')), dry.out.split('\n').slice(-4)[0]);
  const acc = dk(dir, ['baseline', '--accept']);
  check('dk baseline --accept 寫入接受清單', acc.code === 0 && existsSync(join(dir, '.dk', 'baseline.json')));
  const after = verifyJson(dir);
  check('baseline 後：既有違規被消音（exit 0）', after.code === 0, `code=${after.code} findings=${after.data?.findings.length}`);
}

/* 6) 逃生口：// dk-ignore 行內抑制 */
group('// dk-ignore 行內抑制');
{
  const html = `<style>\n/* dk-ignore slop/hardcoded-color */\n.a { color: #123456; }\n</style>\n`;
  const dir = ws('ignore', { 'design/tokens.json': GOOD_TOKENS, 'x.html': html, 'dk.config.mjs': config({ targets: ['x.html'] }) });
  dk(dir, ['build']);
  const v = verifyJson(dir);
  check('被 dk-ignore 的寫死色不再擋（exit 0）', v.code === 0 && !v.rules.has('slop/hardcoded-color'), `code=${v.code} rules=${[...v.rules]}`);
}

/* 7) allowlist：逐規則 + glob 豁免 */
group('allowlist：逐規則與 glob 豁免');
{
  const dir = ws('allow', {
    'design/tokens.json': GOOD_TOKENS, 'embed.html': BAD_HTML,
    'dk.config.mjs': config({ preset: 'minimal', targets: ['embed.html'], allowlist: { 'slop/hardcoded-color': ['embed.html'] } }),
  });
  dk(dir, ['build']);
  const v = verifyJson(dir);
  check('allowlist 的檔不再報 hardcoded-color', !v.rules.has('slop/hardcoded-color'), `rules=${[...v.rules]}`);
}

/* 8) config 錯誤走 Finding 教學格式、且不致命 */
group('config 驗證：無效 preset 會回報並退回 recommended');
{
  const dir = ws('badcfg', { 'design/tokens.json': GOOD_TOKENS, 'dk.config.mjs': config({ preset: 'nonsense' }) });
  dk(dir, ['build']);
  const v = dk(dir, ['verify']);
  check('壞 preset 有被回報', /preset/.test(v.err), v.err.trim().split('\n')[0]);
  check('壞 preset 不致命（仍能跑完 → exit 0）', v.code === 0, `code=${v.code}`);
}

/* 9) dk fix：白名單機械修正（重編產物 → 翻綠） */
group('dk fix：重編漂移的 tokens.css');
{
  const dir = ws('fix', { 'design/tokens.json': GOOD_TOKENS, 'styles/tokens.css': '/* stale */\n', 'dk.config.mjs': config() });
  const before = verifyJson(dir);
  check('fix 前：ssot 漂移（exit 1）', before.code === 1 && before.rules.has('tokens/ssot-sync'));
  const f = dk(dir, ['fix']);
  check('dk fix 執行成功', f.code === 0, f.out.split('\n').find((l) => l.includes('已編譯')) ?? '');
  const after = verifyJson(dir);
  check('fix 後：exit 0', after.code === 0, `code=${after.code}`);
}

/* 10) dk init：就地寫 config、偵測 targets、不覆蓋 */
group('dk init：就地採用且不覆蓋既有檔');
{
  const dir = ws('init', { 'src/App.tsx': '<div>hi</div>' });
  const i = dk(dir, ['init', '--preset', 'strict']);
  check('dk init 寫出 dk.config.mjs', i.code === 0 && existsSync(join(dir, 'dk.config.mjs')));
  check('偵測到 .tsx targets', /tsx/.test(readFileSync(join(dir, 'dk.config.mjs'), 'utf8')));
  check('.gitignore 含 .dk/', existsSync(join(dir, '.gitignore')) && /\.dk\//.test(readFileSync(join(dir, '.gitignore'), 'utf8')));
  const again = dk(dir, ['init']);
  check('再次 init 不覆蓋（提示既有）', again.code === 0 && /不覆蓋|已有設定/.test(again.out));
}

/* dk init 必須把 standalone .css 與其他設計副檔名同級納入 targets。 */
group('dk init 會把 standalone .css 納入 targets');
{
  const dir = ws('init-css', {
    'design/tokens.json': GOOD_TOKENS,
    'src/styles.css': '.card { color: #123456; }\n', // standalone .css：整檔即 style zone
    'index.html': '<h1>hi</h1>\n',
  });
  const i = dk(dir, ['init']);
  const cfg = readFileSync(join(dir, 'dk.config.mjs'), 'utf8');
  const targetsLine = (cfg.match(/targets:\s*(\[[^\]]*\])/) ?? [])[1] ?? '';
  check('10b dk init 成功寫出 config', i.code === 0 && existsSync(join(dir, 'dk.config.mjs')));
  check('10b 偵測到的 targets 涵蓋 .css（不再漏掉 standalone .css）', /css/.test(targetsLine), `targets=${targetsLine}`);
  // End to end: init must include standalone CSS in the verified target set.
  dk(dir, ['build']);
  const v = verifyJson(dir);
  check('10b init 後 verify 掃到 .css 的寫死色（exit 1 + slop/hardcoded-color）', v.code === 1 && v.rules.has('slop/hardcoded-color'), `code=${v.code} rules=${[...v.rules]}`);
}

/* 11) 自省 / 工具子命令都可跑 */
group('自省與工具子命令可在乾淨工作區執行');
{
  const dir = ws('introspect', { 'design/tokens.json': GOOD_TOKENS, 'dk.config.mjs': config() });
  dk(dir, ['build']);
  const cases = [
    ['rules', ['rules']],
    ['rules --json', ['rules', '--json']],
    ['explain slop/hardcoded-color', ['explain', 'slop/hardcoded-color']],
    ['tokens list', ['tokens', 'list']],
    ['tokens contrast', ['tokens', 'contrast']],
    ['tokens coverage', ['tokens', 'coverage']],
    ['contrast', ['contrast']],
    ['doctor', ['doctor']],
    ['report --json', ['report', '--json']],
    ['--help', ['--help']],
    ['--version', ['--version']],
  ];
  for (const [name, args] of cases) {
    const r = dk(dir, args);
    check(`dk ${name} exit 0`, r.code === 0, `code=${r.code} ${r.err.trim().split('\n')[0] ?? ''}`);
  }
  // tokens diff（比對兩份 tokens）
  const other = join(dir, 'design', 'tokens-bad.json');
  writeFileSync(other, BAD_TOKENS);
  const d = dk(dir, ['tokens', 'diff', 'design/tokens-bad.json']);
  check('dk tokens diff exit 0 且有差異輸出', d.code === 0 && /tokenHash/.test(d.out));
  // 錯誤路徑：未知規則 / 未知命令 → exit 2
  check('dk explain 未知規則 → exit 2', dk(dir, ['explain', 'no/such']).code === 2);
  check('dk 未知命令 → exit 2', dk(dir, ['frobnicate']).code === 2);
}

/* 驗證結果完整性：防止 false-green，並覆蓋重關卡、通用性與輸出表面。 */
group('驗證結果完整性（錯誤通過／重關卡狀態／SARIF／HTML）');
{
  const dir = ws('gate', { 'design/tokens.json': GOOD_TOKENS, 'a.html': '<!doctype html><h1>hi</h1>', 'dk.config.mjs': config({ targets: ['a.html'] }) });
  dk(dir, ['build']);
  // Unknown gate ids must not produce an empty successful run.
  check('未知 --gate → exit 2（不再跑 0 關卡卻全數通過）', dk(dir, ['verify', '--gate', 'typo-nope']).code === 2);
  // Explicit positional targets that match zero files are a usage error.
  check('positional glob 掃 0 檔 → exit 2', dk(dir, ['verify', 'src/**/*.tsx']).code === 2);
  // 重關卡誠實：--full 把 css-strict/a11y/visual 明列（帳本可見），不靜默 no-op
  const full = dk(dir, ['verify', '--full']);
  check('--full 報告明列重關卡跳過（非靜默）', /跳過/.test(full.out) && /(無障礙|a11y)/.test(full.out), full.out.split('\n').find((l) => /無障礙|a11y/.test(l)) ?? '');
  const rep = JSON.parse(readFileSync(join(dir, '.dk', 'report.json'), 'utf8'));
  const a11y = (rep.gates ?? []).find((g) => g.id === 'a11y');
  check('--full：a11y 關卡以 status=skipped 存在帳本', a11y && a11y.status === 'skipped', JSON.stringify(a11y));
}
{
  // A config target set that scans zero files must emit config/no-targets.
  const dirZ = ws('zero', { 'design/tokens.json': GOOD_TOKENS, 'dk.config.mjs': config({ targets: ['nope/**/*.vue'] }) });
  dk(dirZ, ['build']);
  const vz = verifyJson(dirZ);
  check('config targets 掃 0 檔 → config/no-targets warn', vz.rules.has('config/no-targets'), `rules=${[...vz.rules]}`);
}
{
  // 通用（不綁 HTML）＋ 精確定位 ＋ 輸出表面
  const jsx = `export const X = () => (\n  <div style={{ color: '#6d28d9', fontFamily: 'Inter' }}>\n    <h1>🚀 Go</h1>\n    <p>300+ fans · 10k+ users · 24/7</p>\n  </div>\n);\n`;
  const dirJ = ws('jsx', { 'design/tokens.json': GOOD_TOKENS, 'C.jsx': jsx, 'dk.config.mjs': config({ preset: 'strict', targets: ['C.jsx'] }) });
  dk(dirJ, ['build']);
  const vj = verifyJson(dirJ);
  check('JSX 內聯樣式寫死色被擋（通用，不只 HTML）', vj.rules.has('slop/hardcoded-color'), `rules=${[...vj.rules]}`);
  check('JSX camelCase fontFamily 觸發 ai-font', vj.rules.has('slop/ai-font'));
  check('astral emoji 🚀 標題被擋', vj.rules.has('slop/emoji-heading'));
  const van = (vj.data?.findings ?? []).find((f) => f.ruleId === 'slop/vanity-number');
  check('vanity-number 帶精確 line（非 null）', !!van && van.line != null, van ? `line=${van.line}` : '(無 vanity finding)');
  // 輸出表面：sarif（stdout）/ html（檔）/ report --sarif --out
  const sarif = dk(dirJ, ['verify', '--sarif']);
  let sj = null; try { sj = JSON.parse(sarif.out); } catch { /* */ }
  check('verify --sarif 產出合法 SARIF 2.1.0（有 results）', sj?.version === '2.1.0' && (sj?.runs?.[0]?.results?.length ?? 0) > 0, `results=${sj?.runs?.[0]?.results?.length}`);
  dk(dirJ, ['verify', '--html', 'r.html']);
  check('verify --html 寫出自包含 HTML', existsSync(join(dirJ, 'r.html')) && /<html[\s\S]*prefers-color-scheme/.test(readFileSync(join(dirJ, 'r.html'), 'utf8')));
  dk(dirJ, ['report', '--sarif', '--out', 'r.sarif']);
  check('report --sarif --out 寫出檔案', existsSync(join(dirJ, 'r.sarif')));
  // build --format 無輸出路徑 → 非零，不假裝成功
  check('build --format js 無輸出路徑 → 非零（不假裝同步/寫出）', dk(dirJ, ['build', '--format', 'js']).code !== 0);
}

/* 13) slop 誤報收斂（可辯護性護欄）：D5 vanity/hex · D6 ai-font fallback · D7 css/sx zone + 引號值 */
group('slop 精確度：正面 fixture 不誤報、反面 fixture 仍命中');
{
  // 正面：價格/千分位/解析度/年份/版本/fallback 字型/非法 7 碼 hex — 全部不該報
  const dirC = ws('fpclean', {
    'design/tokens.json': GOOD_TOKENS, 'fp-clean.html': FP_CLEAN,
    'dk.config.mjs': config({ preset: 'strict', targets: ['fp-clean.html'] }),
  });
  dk(dirC, ['build']);
  const clean = slopJson(dirC, ['fp-clean.html']);
  check('正面 fixture 掃到檔（filesScanned>=1）', clean.scanned >= 1, `scanned=${clean.scanned}`);
  check('可溯源真值/合法用法零誤報（findings=0）', clean.n === 0, `n=${clean.n} rules=${[...clean.rules]}`);
  check('  · 千分位/價格不誤報 vanity（1,000 / $1,200 / 1,234,567）', !clean.rules.has('slop/vanity-number'));
  check('  · fallback web-safe 不誤報 ai-font（首位=Söhne）', !clean.rules.has('slop/ai-font'));
  check('  · 非法 7 碼 hex 不誤報 hardcoded-color（#1234567）', !clean.rules.has('slop/hardcoded-color'));
  check('  · SVG url(#hexid) 引用不誤報 hardcoded-color（fill/stroke/background/border-color: url(#a1b2c3)）', !clean.rules.has('slop/hardcoded-color'));

  // 反面（收斂後仍必須擋）：帶膨脹記號的 vanity 一律照抓
  const dirV = ws('fpvanity', {
    'design/tokens.json': GOOD_TOKENS,
    'v.html': '<p>1000+ 隊伍 · 10k+ 用戶 · 2M+ 下載 · 24/7 · 99.9% · 100% 保證</p>\n',
    'dk.config.mjs': config({ preset: 'strict', targets: ['v.html'] }),
  });
  dk(dirV, ['build']);
  const van = slopJson(dirV, ['v.html']);
  check('帶膨脹記號的 vanity 仍被抓（1000+/10k+/2M+/24-7/99.9%/100%保證）', van.rules.has('slop/vanity-number'), `rules=${[...van.rules]}`);
  check('  · vanity 至少抓到多筆（>=5）', van.n >= 5, `n=${van.n}`);

  // D7 反面：CSS-in-JS style / sx / css 內聯物件皆為 style zone，引號值不再放行
  const dirS = ws('fpstyled', {
    'design/tokens.json': GOOD_TOKENS, 'P.jsx': FP_STYLED,
    'dk.config.mjs': config({ preset: 'strict', targets: ['P.jsx'] }),
  });
  dk(dirS, ['build']);
  const styled = slopJson(dirS, ['P.jsx']);
  const spN = (styled.data?.findings ?? []).filter((f) => f.ruleId === 'slop/hardcoded-spacing').length;
  const clrN = (styled.data?.findings ?? []).filter((f) => f.ruleId === 'slop/hardcoded-color').length;
  check('D7a：JSX 內聯引號值 off-scale 被抓（style/sx/css 三處 13px）', spN >= 3, `hardcoded-spacing=${spN}`);
  check('D7b：sx/css 內聯物件成 style zone → 寫死色被抓（>=2）', clrN >= 2, `hardcoded-color=${clrN}`);
}

/* ledger 核心不變量：finding 精確計數、partial merge、gate enabled 與 --gate 依賴閉包。 */
group('ledger 不變量（精確筆數／帳本合併／config 閘門／依賴閉包）');
{
  // line／col 皆為 null 的同規則多筆 Finding 必須各自保留。
  //      缺 N 個 required token → 恰好 N 筆（省略 4 個非 pair 的 required token）。
  const reqBad = {
    color: { $type: 'color',
      text: { primary: { $value: '#000000' }, secondary: { $value: '#444444' }, muted: { $value: '#767676' }, 'on-accent': { $value: '#ffffff' }, link: { $value: '#003366' } },
      surface: { page: { $value: '#ffffff' } },
      brand: { accent: { $value: '#0071e3' } },
      // 省略 color.state.positive / color.state.negative（2 個 required）
    },
    space: { $type: 'dimension', 4: { $value: '16px' } },
    // 省略 radius.md / shadow.card（2 個 required）→ 共缺 4 個
    font: { family: { $type: 'fontFamily', base: { $value: 'system-ui' } }, size: { $type: 'dimension', base: { $value: '1rem' } } },
  };
  const dirReq = ws('ledger-req', { 'design/tokens.json': JSON.stringify(reqBad, null, 2), 'index.html': '<h1>hi</h1>\n', 'dk.config.mjs': config({ targets: ['index.html'] }) });
  const vReq = verifyJson(dirReq);
  const reqN = countRule(vReq.data?.findings, 'tokens/required');
  check('缺 4 個 required token → 恰好 4 筆', reqN === 4, `got=${reqN} msgs=${(vReq.data?.findings ?? []).filter((f) => f.ruleId === 'tokens/required').map((f) => f.message)}`);
  check('required 精確計數時 contrast 不污染（=0）', countRule(vReq.data?.findings, 'tokens/contrast') === 0, `contrast=${countRule(vReq.data?.findings, 'tokens/contrast')}`);

  // M 組對比不足（pair×mode）必須產生 M 筆；2 pair 在淺／深模式均失敗時共 4 筆。
  const conBad = {
    color: { $type: 'color',
      text: { primary: { $value: '#eeeeee' }, secondary: { $value: '#dddddd' }, muted: { $value: '#767676' }, 'on-accent': { $value: '#ffffff' }, link: { $value: '#003366' } },
      surface: { page: { $value: '#ffffff' } },
      brand: { accent: { $value: '#0071e3' } },
      state: { positive: { $value: '#1d9e63' }, negative: { $value: '#e0301e' } },
    },
    space: { $type: 'dimension', 4: { $value: '16px' } },
    radius: { $type: 'dimension', md: { $value: '12px' } },
    shadow: { card: { $value: '0 4px 24px rgba(0,0,0,0.06)' } },
    font: { family: { $type: 'fontFamily', base: { $value: 'system-ui' } }, size: { $type: 'dimension', base: { $value: '1rem' } } },
  };
  const dirCon = ws('ledger-con', { 'design/tokens.json': JSON.stringify(conBad, null, 2), 'index.html': '<h1>hi</h1>\n', 'dk.config.mjs': config({ targets: ['index.html'] }) });
  const vCon = verifyJson(dirCon);
  const conN = countRule(vCon.data?.findings, 'tokens/contrast');
  check('2 組對比不足 × 淺深兩模式 → 恰好 4 筆', conN === 4, `got=${conN} msgs=${(vCon.data?.findings ?? []).filter((f) => f.ruleId === 'tokens/contrast').map((f) => f.message)}`);
  check('contrast 精確計數時 required 不污染（=0）', countRule(vCon.data?.findings, 'tokens/required') === 0);
}
{
  // 全量 verify 後跑單檔 slop，帳本走 merge-by-file；其他檔案的 findings 與
  // 未執行的 gate 都必須保留。
  const badStyle = '<style>.a{ color:#123456; }</style>\n';
  const dir = ws('ledger-merge', { 'design/tokens.json': GOOD_TOKENS, 'a.html': badStyle, 'b.html': badStyle, 'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'] }) });
  dk(dir, ['build']);
  dk(dir, ['verify']); // 全量 → 整檔覆寫
  const full = readReport(dir);
  check('全量 verify 帳本含 a.html+b.html findings 與 ssot-sync gate', !!full && full.findings.some((f) => f.file === 'a.html') && full.findings.some((f) => f.file === 'b.html') && full.gates.some((g) => g.id === 'ssot-sync'), `files=${[...new Set((full?.findings ?? []).map((f) => f.file))]}`);
  dk(dir, ['slop', 'a.html']); // 單檔 partial → merge-by-file
  const part = readReport(dir);
  check('單檔 slop 後：b.html 的 findings 仍在（merge-by-file）', !!part && part.findings.some((f) => f.file === 'b.html'), `files=${[...new Set((part?.findings ?? []).map((f) => f.file))]}`);
  check('單檔 slop 後：ssot-sync / contract 等其他 gate 仍在帳本', !!part && part.gates.some((g) => g.id === 'ssot-sync') && part.gates.some((g) => g.id === 'contract'), `gates=${(part?.gates ?? []).map((g) => g.id)}`);
  check('單檔 slop 標記 partial 並記錄 scope', !!part && part.partial === true && part.scope?.targets?.[0] === 'a.html', JSON.stringify(part?.scope));
  check('單檔 slop 後 filesScanned 保留帳本全貌（>= 2）', !!part && part.filesScanned >= 2, `filesScanned=${part?.filesScanned}`);
}
{
  // config.gates.<heavy>.enabled=true 時，該重關卡必須併入跑序。
  //      Missing dependencies remain visible as status:skipped with a reason.
  const dirEn = ws('ledger-enabled', { 'design/tokens.json': GOOD_TOKENS, 'index.html': '<h1>hi</h1>\n', 'dk.config.mjs': config({ gates: { cssStrict: { enabled: true } }, targets: ['index.html'] }) });
  dk(dirEn, ['build']);
  dk(dirEn, ['verify']); // 無 --full
  const repEn = readReport(dirEn);
  const cs = (repEn?.gates ?? []).find((g) => g.id === 'css-strict');
  check('config.gates.cssStrict.enabled=true → css-strict 併入跑序', !!cs, `gates=${(repEn?.gates ?? []).map((g) => g.id)}`);
  check('缺 stylelint → css-strict status=skipped 且帶 reason', !!cs && cs.status === 'skipped' && !!cs.reason, JSON.stringify(cs));
  // 對照：未啟用（recommended、無 --full）→ 重關卡不入跑序，維持零依賴核心。
  const dirDis = ws('ledger-disabled', { 'design/tokens.json': GOOD_TOKENS, 'index.html': '<h1>hi</h1>\n', 'dk.config.mjs': config({ targets: ['index.html'] }) });
  dk(dirDis, ['build']);
  dk(dirDis, ['verify']);
  const repDis = readReport(dirDis);
  check('未啟用（recommended、無 --full）→ css-strict 不入跑序', !(repDis?.gates ?? []).some((g) => g.id === 'css-strict'), `gates=${(repDis?.gates ?? []).map((g) => g.id)}`);
}
{
  // --gate slop 時，其 dep contract 必須一起跑（傳遞閉包）、標為 auxiliary，
  // 並提供 verifiedPairs 證據。
  const dirG = ws('ledger-gatedep', { 'design/tokens.json': GOOD_TOKENS, 'index.html': '<h1>hi</h1>\n', 'dk.config.mjs': config({ targets: ['index.html'] }) });
  dk(dirG, ['build']);
  dk(dirG, ['verify', '--gate', 'slop']);
  const repG = readReport(dirG);
  const contract = (repG?.gates ?? []).find((g) => g.id === 'contract');
  check('--gate slop → contract（其 dep）有跑並列入 gates', !!contract && contract.status === 'ran', JSON.stringify(contract));
  check('--gate slop → contract 標 auxiliary（不計入 exit code）', !!contract && contract.auxiliary === true, JSON.stringify(contract));
  check('--gate slop → verifiedPairs 證據存在', Array.isArray(repG?.emits?.verifiedPairs) && repG.emits.verifiedPairs.length > 0, `verifiedPairs=${repG?.emits?.verifiedPairs?.length}`);
}

/* CLI 命令不變量：baseline 棘輪、報告覆寫保護、help 短路、旗標驗證與 report exit 語意。 */
group('CLI 命令不變量（baseline 棘輪／報告覆寫保護／help／旗標驗證）');
// 讀 .dk/baseline.json 的 accepted（供 baseline 棘輪回歸）。
const readBaseline = (cwd) => { try { return JSON.parse(readFileSync(join(cwd, '.dk', 'baseline.json'), 'utf8')).accepted ?? []; } catch { return null; } };
{
  // 15a) baseline 棘輪：合併不毀債 / 只擋新增 / --prune 單向收緊 / error 級進 baseline 有警告。
  const dir = ws('cli-baseline', {
    'design/tokens.json': GOOD_TOKENS,
    'a.html': '<style>.a{ color:#123456; }</style>\n',
    'b.html': '<h1>clean</h1>\n',
    'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'], failOnSkipped: false }),
  });
  dk(dir, ['build']);
  // 第一次 accept：收 a.html 的 error 級違規。
  const acc1 = dk(dir, ['baseline', '--accept']);
  const b1 = readBaseline(dir);
  check('15a accept 收錄 a.html 違規', !!b1 && b1.some((x) => x.file === 'a.html'), `accepted=${JSON.stringify(b1)}`);
  check('15a 收進 error 級 finding → 終端顯式警告（列筆數與規則）', /error 級 finding 收進 baseline/.test(acc1.out) && /slop\/hardcoded-color/.test(acc1.out), acc1.out.split('\n').find((l) => /error 級/.test(l)) ?? '');
  check('15a accept 後既有違規被消音（exit 0）', verifyJson(dir).code === 0);
  // (1a) accept 後製造新違規 → verify exit 1（棘輪只擋新增）。
  writeFileSync(join(dir, 'c.html'), '<style>.c{ color:#abcdef; }</style>\n');
  check('15a(1a) accept 後新增違規 → verify exit 1（棘輪只擋新增，不放行新錯）', verifyJson(dir).code === 1, `code=${verifyJson(dir).code}`);
  // 第二次 accept 別的檔時，A 檔已接受項目必須保留。
  writeFileSync(join(dir, 'c.html'), '<h1>gone</h1>\n');
  writeFileSync(join(dir, 'b.html'), '<style>.b{ color:#654321; }</style>\n');
  dk(dir, ['baseline', '--accept']);
  const b2 = readBaseline(dir);
  check('15a(1b) 第二次 accept B 檔後：A 檔舊債仍在接受清單（重跑不毀債）', !!b2 && b2.some((x) => x.file === 'a.html'), `files=${(b2 ?? []).map((x) => x.file)}`);
  check('15a(1b) 第二次 accept：B 檔違規也進清單（合併而非覆寫）', !!b2 && b2.some((x) => x.file === 'b.html'), `files=${(b2 ?? []).map((x) => x.file)}`);
  // (1c) 修好 a.html → --prune 清除已修復條目、保留未修復（單向收緊）。
  writeFileSync(join(dir, 'a.html'), '<h1>a fixed</h1>\n');
  dk(dir, ['baseline', '--accept', '--prune']);
  const b3 = readBaseline(dir);
  check('15a(1c) --prune 後：已修復的 a.html 條目被移除', !!b3 && !b3.some((x) => x.file === 'a.html'), `files=${(b3 ?? []).map((x) => x.file)}`);
  check('15a(1c) --prune 後：未修復的 b.html 條目保留（單向收緊，不誤刪）', !!b3 && b3.some((x) => x.file === 'b.html'), `files=${(b3 ?? []).map((x) => x.file)}`);
}
{
  // 15b) 報告覆寫保護（a）＋ 自我污染阻斷（b）。
  const dir = ws('cli-html', {
    'design/tokens.json': GOOD_TOKENS,
    'page.html': '<style>.a{ color:#123456; }</style>\n<p>1000+ users</p>\n',
    'dk.config.mjs': config({ preset: 'strict', targets: ['page.html'] }),
  });
  dk(dir, ['build']);
  // (2a) --html 指到被掃描的來源檔 → exit 2 且來源檔內容不變。
  const srcBefore = readFileSync(join(dir, 'page.html'), 'utf8');
  const clash = dk(dir, ['verify', '--html', 'page.html']);
  const srcAfter = readFileSync(join(dir, 'page.html'), 'utf8');
  check('15b(2a) --html 命中掃描來源檔 → exit 2', clash.code === 2, `code=${clash.code}`);
  check('15b(2a) 被拒後來源檔內容不變（未被報告覆寫）', srcBefore === srcAfter);
  check('15b(2a) 拒絕訊息教用 --out / ignore', /--out|ignore/.test(clash.err), clash.err.trim().split('\n')[0]);
  // 合法情況不被誤傷：落點非掃描 target → 正常寫出。
  const okOut = dk(dir, ['verify', '--html', 'report.html']);
  check('15b 合法落點（非 target）正常寫出，不誤傷', existsSync(join(dir, 'report.html')) && okOut.code !== 2, `code=${okOut.code}`);
}
{
  // (2b) 自我污染阻斷：預設 dk-report.html 落在 **/*.html 掃描集合，但被預設 ignore 擋掉 → findings 不暴增。
  const dir = ws('cli-pollute', {
    'design/tokens.json': GOOD_TOKENS,
    'page.html': '<style>.a{ color:#123456; }</style>\n<p>1000+ users</p>\n',
    'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'], failOnSkipped: false }),
  });
  dk(dir, ['build']);
  const n1 = verifyJson(dir).data?.findings.length ?? -1;
  dk(dir, ['verify', '--html']); // 產出預設 dk-report.html（落點在掃描集合內，靠預設 ignore 保護）
  check('15b(2b) 預設 dk-report.html 有寫出', existsSync(join(dir, 'dk-report.html')));
  const n2 = verifyJson(dir).data?.findings.length ?? -2;
  check('15b(2b) 報告存在後再 verify：findings 數不因報告暴增（自我污染阻斷）', n1 === n2 && n1 > 0, `n1=${n1} n2=${n2}`);
}
{
  // 15c) CLI 一致性：--help 短路不執行、未知旗標 exit 2+建議、report render-only exit 語意。
  const dir = ws('cli-consistency', {
    'design/tokens.json': GOOD_TOKENS, 'x.html': '<h1>hi</h1>\n',
    'dk.config.mjs': config({ targets: ['x.html'] }),
  });
  dk(dir, ['build']);
  // --help 一律短路：不執行 verify、不寫 .dk/report.json、exit 0。
  const help = dk(dir, ['verify', '--help']);
  check('15c(3a) dk verify --help exit 0 且不產生 .dk/report.json', help.code === 0 && !existsSync(join(dir, '.dk', 'report.json')), `code=${help.code} report=${existsSync(join(dir, '.dk', 'report.json'))}`);
  check('15c(3a) --help 印對應命令段落（verify）', /dk verify/.test(help.out) && /--gate/.test(help.out));
  // 未知旗標 → exit 2 + stderr 建議。
  const unk = dk(dir, ['verify', '--nonexist']);
  check('15c(3b) dk verify --nonexist → exit 2', unk.code === 2, `code=${unk.code}`);
  check('15c(3b) 未知旗標 stderr 有建議/提示', /未知旗標|--help/.test(unk.err), unk.err.trim().split('\n')[0]);
  // typo 建議最相近旗標（Damerau：換位算 1）。
  const typo = dk(dir, ['baseline', '--accpet']);
  check('15c(3b) --accpet typo → 建議 --accept', typo.code === 2 && /--accept/.test(typo.err), typo.err.trim().split('\n')[0]);
  // report render-only exit 語意：無帳本 exit 2；有帳本 exit 0。
  const noLedger = dk(dir, ['report']);
  check('15c(3d) dk report 無帳本 → exit 2', noLedger.code === 2, `code=${noLedger.code}`);
  dk(dir, ['verify']); // 建立帳本
  const withLedger = dk(dir, ['report']);
  check('15c(3d) dk report 有帳本 → exit 0（render-only）', withLedger.code === 0, `code=${withLedger.code}`);
}

/* APCA 不變量：algorithm:'apca' 使用 Lc 門檻；WCAG 維持比值門檻，
   兩種演算法都只把符合門檻的 pair 納入 verifiedPairs。 */
group('APCA 模式使用 Lc 門檻判定對比');
{
  // 低對比配色：淺灰放白／近白底；結構、命名與必要欄位皆合法，只應觸發對比 Finding。
  const badPalette = {
    color: { $type: 'color',
      text: { primary: { $value: '#c0c0c0' }, secondary: { $value: '#c8c8c8' }, muted: { $value: '#d0d0d0' }, 'on-accent': { $value: '#f5f5f5' }, link: { $value: '#cfcfcf' } },
      surface: { page: { $value: '#ffffff' } }, brand: { accent: { $value: '#eeeeee' } },
      state: { positive: { $value: '#bfeecf' }, negative: { $value: '#eecfcf' } } },
    space: { $type: 'dimension', 4: { $value: '16px' } }, radius: { $type: 'dimension', md: { $value: '12px' } },
    shadow: { card: { $value: '0 4px 24px rgba(0,0,0,0.06)' } },
    font: { family: { $type: 'fontFamily', base: { $value: 'system-ui' } }, size: { $type: 'dimension', base: { $value: '1rem' } } },
  };
  // 好配色：高對比深字放白、白字放深藍 accent（WCAG 與 APCA 皆過）。
  const goodPalette = {
    color: { $type: 'color',
      text: { primary: { $value: '#000000' }, secondary: { $value: '#111111' }, muted: { $value: '#595959' }, 'on-accent': { $value: '#ffffff' }, link: { $value: '#0a3d91' } },
      surface: { page: { $value: '#ffffff' } }, brand: { accent: { $value: '#0a3d91' } },
      state: { positive: { $value: '#1d7a3f' }, negative: { $value: '#b21f13' } } },
    space: { $type: 'dimension', 4: { $value: '16px' } }, radius: { $type: 'dimension', md: { $value: '12px' } },
    shadow: { card: { $value: '0 4px 24px rgba(0,0,0,0.06)' } },
    font: { family: { $type: 'fontFamily', base: { $value: 'system-ui' } }, size: { $type: 'dimension', base: { $value: '1rem' } } },
  };
  const mk = (name, palette, extra) => {
    const dir = ws(name, { 'design/tokens.json': JSON.stringify(palette, null, 2), 'index.html': '<h1>hi</h1>\n', 'dk.config.mjs': config({ targets: ['index.html'], ...extra }) });
    dk(dir, ['build']); // 編出產物 → ssot-sync 通過，隔離出對比訊號
    return dir;
  };

  // 低對比配色在 APCA 模式必須回報 tokens/contrast。
  const dirBadA = mk('apca-bad', badPalette, { contrast: { algorithm: 'apca' } });
  const vBadA = verifyJson(dirBadA);
  check('16(a) 低對比配色 @apca → tokens/contrast 有回報', countRule(vBadA.data?.findings, 'tokens/contrast') > 0, `n=${countRule(vBadA.data?.findings, 'tokens/contrast')}`);
  // 低對比配色不得進入 verifiedPairs。
  const repBadA = readReport(dirBadA);
  check('16(c) 低對比配色 @apca → verifiedPairs 為空', Array.isArray(repBadA?.emits?.verifiedPairs) && repBadA.emits.verifiedPairs.length === 0, `verifiedPairs=${repBadA?.emits?.verifiedPairs?.length}`);

  // (b) 好配色在 wcag 與 apca 兩模式都過（0 對比 finding、exit 0）且 verifiedPairs 皆有收
  const dirGoodW = mk('apca-good-w', goodPalette, {});
  const vGoodW = verifyJson(dirGoodW); const repGoodW = readReport(dirGoodW);
  check('16(b) 好配色@wcag → 0 對比 finding 且 exit 0', countRule(vGoodW.data?.findings, 'tokens/contrast') === 0 && vGoodW.code === 0, `n=${countRule(vGoodW.data?.findings, 'tokens/contrast')} code=${vGoodW.code}`);
  check('16(b) 好配色@wcag → verifiedPairs 有收（下游 a11y 反查證據存在）', (repGoodW?.emits?.verifiedPairs?.length ?? 0) > 0, `verifiedPairs=${repGoodW?.emits?.verifiedPairs?.length}`);

  const dirGoodA = mk('apca-good-a', goodPalette, { contrast: { algorithm: 'apca' } });
  const vGoodA = verifyJson(dirGoodA); const repGoodA = readReport(dirGoodA);
  check('16(b) 好配色@apca → 0 對比 finding 且 exit 0', countRule(vGoodA.data?.findings, 'tokens/contrast') === 0 && vGoodA.code === 0, `n=${countRule(vGoodA.data?.findings, 'tokens/contrast')} code=${vGoodA.code}`);
  check('16(b) 好配色@apca → verifiedPairs 有收', (repGoodA?.emits?.verifiedPairs?.length ?? 0) > 0, `verifiedPairs=${repGoodA?.emits?.verifiedPairs?.length}`);
  // apca 模式的 verifiedPairs 門檻是 Lc（60/45），不是 WCAG 比值（4.5/3.0）——證明門檻真的隨演算法換算。
  const apcaMins = new Set((repGoodA?.emits?.verifiedPairs ?? []).map((p) => p.min));
  check('16(b) apca verifiedPairs 門檻為 Lc（>=45），非 WCAG 比值（4.5/3.0）', apcaMins.size > 0 && [...apcaMins].every((m) => m >= 45) && !apcaMins.has(4.5) && !apcaMins.has(3.0), `mins=${[...apcaMins]}`);
}

/* ReDoS 防護：病態輸入使用有界量詞；以 Date.now 量測單檔掃描牆鐘時間。 */
group('slop 正則在病態輸入下維持有界執行時間');
{
  // 64KB 連續空白（RE_HEX 攻擊面）＋ 千分位長串（RE_VANITY 攻擊面），合成單檔（<2MB → 會被實際掃描）。
  const evil = `<style>.x{ color:${' '.repeat(64 * 1024)} }</style>\n<p>${'1' + ',000'.repeat(16000)}</p>\n`;
  const dir = ws('redos', { 'design/tokens.json': GOOD_TOKENS, 'evil.html': evil, 'dk.config.mjs': config({ preset: 'strict', targets: ['evil.html'] }) });
  dk(dir, ['build']);
  const t = Date.now();
  const r = slopJson(dir, ['evil.html']);
  const ms = Date.now() - t;
  check('17 病態輸入單檔掃描 < 1000ms', ms < 1000 && r.scanned >= 1, `ms=${ms} scanned=${r.scanned}`);
  // 偵測能力不變：千分位帶 + 仍抓得到（有界量詞未削弱能力）。
  const dir2 = ws('redos-detect', { 'design/tokens.json': GOOD_TOKENS, 'd.html': '<p>下載 1,234,567+ 次 · 銷量 1,000+</p>\n', 'dk.config.mjs': config({ preset: 'strict', targets: ['d.html'] }) });
  dk(dir2, ['build']);
  const det = slopJson(dir2, ['d.html']);
  check('17 有界後偵測不變：千分位帶 + 仍抓 vanity（1,234,567+ / 1,000+）', det.rules.has('slop/vanity-number'), `rules=${[...det.rules]}`);
}

/* collectFiles 單檔大小上限為 2MB：超過時略過、印 stderr 提示，且不進 findings 掃描。 */
group('collectFiles 對超過 2MB 的檔案明確略過');
{
  const big = '<style>.a{ color:#123456; }</style>\n' + ' '.repeat(2 * 1024 * 1024 + 50); // >2MB，含一個本會被抓的寫死色
  const dir = ws('bigfile', { 'design/tokens.json': GOOD_TOKENS, 'big.html': big, 'small.html': '<style>.b{ color:#654321; }</style>\n', 'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'] }) });
  dk(dir, ['build']);
  const r = slopJson(dir, ['big.html', 'small.html']);
  check('18 >2MB 檔被跳過（filesScanned 只計 small.html = 1）', r.scanned === 1, `scanned=${r.scanned}`);
  check('18 >2MB 檔不進 findings 掃描（big.html 無 finding）', !(r.data?.findings ?? []).some((f) => f.file === 'big.html'), `files=${[...new Set((r.data?.findings ?? []).map((f) => f.file))]}`);
  check('18 一般檔仍照掃（small.html 的寫死色被抓）', (r.data?.findings ?? []).some((f) => f.file === 'small.html' && f.ruleId === 'slop/hardcoded-color'));
  check('18 跳過不靜默：stderr 印略過提示（列檔名）', /略過大檔/.test(r.err) && /big\.html/.test(r.err), r.err.trim().split('\n').find((l) => /略過/.test(l)) ?? '(無提示)');
}

/* 機器可讀介面：--summary、--json gates、SARIF fingerprints，以及 config／fatal 狀態持久化。 */
group('機器可讀報告（summary／JSON gates／SARIF fingerprints／失敗持久化）');
{
  // 19a) --summary schema 欄位齊備、counts 與 --json 一致、緊湊（< 10KB 級）、不含逐筆 findings。
  const dir = ws('summary', { 'design/tokens.json': GOOD_TOKENS, 'bad.html': BAD_HTML, 'dk.config.mjs': config({ preset: 'strict' }) });
  dk(dir, ['build']);
  const sr = dk(dir, ['verify', '--summary']);
  let sum = null; try { sum = JSON.parse(sr.out); } catch { /* */ }
  const jr = dk(dir, ['verify', '--json']);
  let js = null; try { js = JSON.parse(jr.out); } catch { /* */ }
  check('19a --summary 有 schema 標記 dk-summary/v1', sum?.schema === 'dk-summary/v1', `schema=${sum?.schema}`);
  check('19a --summary counts 與 --json 完全一致', JSON.stringify(sum?.counts) === JSON.stringify(js?.counts), `s=${JSON.stringify(sum?.counts)} j=${JSON.stringify(js?.counts)}`);
  check('19a --summary 欄位齊備（exitCode/tokenHash/filesScanned/gates/rules/suppressed/baselined/configErrors）',
    sum && typeof sum.exitCode === 'number' && !!sum.tokenHash && typeof sum.filesScanned === 'number'
    && Array.isArray(sum.gates) && !!sum.rules && Array.isArray(sum.rules.top)
    && typeof sum.suppressed === 'number' && typeof sum.baselined === 'number' && Array.isArray(sum.configErrors),
    JSON.stringify(Object.keys(sum ?? {})));
  check('19a --summary 每個 gate 帶 findingCount', (sum?.gates ?? []).every((g) => typeof g.findingCount === 'number'), JSON.stringify(sum?.gates?.map((g) => g.findingCount)));
  check('19a --summary 不含逐筆 findings（機器表面刻意不帶明細）', sum && !('findings' in sum), `keys=${Object.keys(sum ?? {})}`);
  check('19a --summary 輸出緊湊（< 10KB）', Buffer.byteLength(sr.out, 'utf8') < 10240, `bytes=${Buffer.byteLength(sr.out, 'utf8')}`);
}
{
  // 19b) per-rule top-N（N=20）折疊：25 條 distinct 自訂規則 → top 恰 20、other 給總數（不靜默截斷）。
  const custom = [];
  let markerText = '';
  for (let i = 0; i < 25; i++) {
    const id = String(i).padStart(2, '0');
    custom.push({ id: `test/r${id}`, pattern: `MARKER${id}`, severity: 'warn', zone: 'all', message: `marker ${id}` });
    markerText += `MARKER${id} `;
  }
  const dir = ws('summary-fold', { 'design/tokens.json': GOOD_TOKENS, 'm.html': `<p>${markerText}</p>\n`, 'dk.config.mjs': config({ targets: ['m.html'], slop: { rules: custom } }) });
  dk(dir, ['build']);
  const sr = dk(dir, ['verify', '--summary']);
  let sum = null; try { sum = JSON.parse(sr.out); } catch { /* */ }
  const topN = sum?.rules?.top?.length ?? -1;
  const other = sum?.rules?.other;
  const topSum = (sum?.rules?.top ?? []).reduce((n, r) => n + r.count, 0);
  const total = (sum?.counts?.error ?? 0) + (sum?.counts?.warn ?? 0) + (sum?.counts?.info ?? 0);
  check('19b 25 條 distinct 規則 → top 恰 20 筆', topN === 20, `topN=${topN}`);
  check('19b top-N 折疊 other 給總數（rules=5 count=5，不靜默截斷）', !!other && other.rules === 5 && other.count === 5, JSON.stringify(other));
  check('19b top 筆數和 + other.count == 總 findings（25，無截斷遺漏）', topSum + (other?.count ?? 0) === total && total === 25, `topSum=${topSum} other=${other?.count} total=${total}`);
}
{
  // 19c) --json 補 gates（誠實化）：機器表面現有「skipped 帶 reason」，agent 偵測得到關卡被跳過。
  const dir = ws('json-gates', { 'design/tokens.json': GOOD_TOKENS, 'a.html': '<h1>hi</h1>', 'dk.config.mjs': config({ targets: ['a.html'] }) });
  dk(dir, ['build']);
  const jr = dk(dir, ['verify', '--full', '--json']);
  let js = null; try { js = JSON.parse(jr.out); } catch { /* */ }
  check('19c --json 含 gates 陣列，讓 agent 可辨識跳過的關卡', Array.isArray(js?.gates) && js.gates.length > 0, `gates=${JSON.stringify(js?.gates?.map((g) => g.id))}`);
  const a11y = (js?.gates ?? []).find((g) => g.id === 'a11y');
  check('19c --json gates 帶 skipped+reason（--full 缺依賴誠實跳過）', a11y && a11y.status === 'skipped' && !!a11y.reason, JSON.stringify(a11y));
}
{
  // 19d) SARIF partialFingerprints：GitHub code scanning 跨行號漂移追蹤 alert（否則重複開關）。
  const dir = ws('sarif-fp', { 'design/tokens.json': GOOD_TOKENS, 'bad.html': BAD_HTML, 'dk.config.mjs': config({ preset: 'strict' }) });
  dk(dir, ['build']);
  const sarif = dk(dir, ['verify', '--sarif']);
  let sj = null; try { sj = JSON.parse(sarif.out); } catch { /* */ }
  const results = sj?.runs?.[0]?.results ?? [];
  check('19d SARIF 仍為合法 2.1.0 且有 results', sj?.version === '2.1.0' && results.length > 0, `v=${sj?.version} n=${results.length}`);
  check('19d 每筆 result 有 partialFingerprints[dkFingerprint/v1]', results.length > 0 && results.every((r) => typeof r.partialFingerprints?.['dkFingerprint/v1'] === 'string'), `n=${results.length}`);
  check('19d fingerprint 為 ledger 統一格式（ruleId|file|message）', results.length > 0 && results.every((r) => (r.partialFingerprints['dkFingerprint/v1'].match(/\|/g) ?? []).length >= 2), results[0]?.partialFingerprints?.['dkFingerprint/v1']);
}
{
  // 19e) config 壞掉（config.errors 路徑）也落帳——dk report 讀得回「上次 run 其實 config 就壞了」。
  const dir = ws('cfg-persist', { 'design/tokens.json': GOOD_TOKENS, 'x.html': '<h1>hi</h1>\n', 'dk.config.mjs': config({ preset: 'strict', failOn: 'bogus', targets: ['x.html'] }) });
  dk(dir, ['build']);
  dk(dir, ['verify']); // 走 config.errors 旁路，但仍應落帳
  const rep = readReport(dir);
  check('19e 壞 config（failOn:bogus）→ 帳本 configErrors 有記錄', Array.isArray(rep?.configErrors) && rep.configErrors.length > 0 && /failOn/.test(rep.configErrors[0]?.message ?? ''), JSON.stringify(rep?.configErrors));
  check('19e 帳本使用 version 2 schema', rep?.version === 2, `version=${rep?.version}`);
  const rj = dk(dir, ['report', '--json']);
  let rjd = null; try { rjd = JSON.parse(rj.out); } catch { /* */ }
  check('19e dk report --json 讀得到 configErrors（上次 run 的 config 錯誤）', Array.isArray(rjd?.configErrors) && rjd.configErrors.length > 0, JSON.stringify(rjd?.configErrors));
  const sr = dk(dir, ['verify', '--summary']);
  let sum = null; try { sum = JSON.parse(sr.out); } catch { /* */ }
  check('19e --summary 也表達 configErrors（機器表面一致）', Array.isArray(sum?.configErrors) && sum.configErrors.length > 0, JSON.stringify(sum?.configErrors));
}
{
  // 19f) fatal（tokens 壞）也必須持久化，讓 dk report 讀得到當前失敗狀態。
  const dir = ws('fatal-persist', { 'design/tokens.json': '{ not valid json', 'x.html': '<h1>hi</h1>\n', 'dk.config.mjs': config({ targets: ['x.html'] }) });
  const v = dk(dir, ['verify']);
  const rep = readReport(dir);
  check('19f 壞 tokens（fatal）→ verify exit 1 且帳本 fatal:true', v.code === 1 && rep?.fatal === true && rep?.exitCode === 1, `code=${v.code} fatal=${rep?.fatal}`);
  const r = dk(dir, ['report']);
  check('19f dk report 讀得到 fatal 快照（tokens/structure）', r.code === 0 && /tokens|解析失敗|structure/.test(r.out + r.err), r.out.split('\n').find((l) => /解析失敗|tokens/.test(l)) ?? '');
}
/* 20) regex 邊界修正包（四群）：camelCase 色 / 單引號 style / .5rem 正規化 / 版本語境非 vanity
   —— 每群一組「修好前紅→修好後綠」：漏報群用「應抓而沒抓」、誤報群用「不應抓而抓了」的 fp 斷言。 */
group('slop 正則邊界（camelCase 色／單引號 style／數值正規化／版本語境）');
const EDGE_CAMEL = readFileSync(join(REPO, 'gates', 'fixtures', 'edge-camel.jsx'), 'utf8');
const EDGE_SQ = readFileSync(join(REPO, 'gates', 'fixtures', 'edge-singlequote.html'), 'utf8');
const EDGE_SCALE = readFileSync(join(REPO, 'gates', 'fixtures', 'edge-scale.css'), 'utf8');
const FP_EDGE = readFileSync(join(REPO, 'gates', 'fixtures', 'fp-edge.html'), 'utf8');
{
  // CSS-in-JS 的 camelCase 顏色屬性（backgroundColor／borderColor／boxShadow）必須命中。
  const dir = ws('edge-camel', { 'design/tokens.json': GOOD_TOKENS, 'edge-camel.jsx': EDGE_CAMEL, 'dk.config.mjs': config({ preset: 'strict', targets: ['*.jsx'] }) });
  dk(dir, ['build']);
  const r = slopJson(dir, ['edge-camel.jsx']);
  const clrN = countRule(r.data?.findings, 'slop/hardcoded-color');
  const hasCamel = (r.data?.findings ?? []).some((f) => f.ruleId === 'slop/hardcoded-color' && /^(backgroundColor|borderColor|boxShadow)/.test(f.evidence ?? ''));
  check('20a camelCase 色屬性寫死色被抓（backgroundColor/borderColor/boxShadow + color 共 4 筆）', clrN === 4, `hardcoded-color=${clrN}`);
  check('20a 至少一筆 evidence 屬 camelCase 屬性（證明不只 kebab、與 enforceScale 對齊）', hasCamel, `evidences=${(r.data?.findings ?? []).filter((f) => f.ruleId === 'slop/hardcoded-color').map((f) => (f.evidence ?? '').slice(0, 18))}`);
}
{
  // 單引號 style 屬性必須命中；雙引號內嵌單引號不得被截斷。
  const dir = ws('edge-sq', { 'design/tokens.json': GOOD_TOKENS, 'edge-singlequote.html': EDGE_SQ, 'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'] }) });
  dk(dir, ['build']);
  const r = slopJson(dir, ['edge-singlequote.html']);
  const clrN = countRule(r.data?.findings, 'slop/hardcoded-color');
  const spN = countRule(r.data?.findings, 'slop/hardcoded-spacing');
  const keptDouble = (r.data?.findings ?? []).some((f) => f.ruleId === 'slop/hardcoded-color' && /#123456/.test(f.evidence ?? ''));
  check('20b 單+雙引號 style 皆成 zone → 兩段寫死色都被抓（#ff00aa + #123456 = 2 筆）', clrN === 2, `hardcoded-color=${clrN}`);
  check('20b 單引號段的 off-scale 也被抓（padding:15px → hardcoded-spacing>=1）', spN >= 1, `hardcoded-spacing=${spN}`);
  check('20b 雙引號含內嵌單引號未被截斷（style="a\'b" 的 #123456 仍在 zone 內被抓）', keptDouble, `kept=${keptDouble}`);
}
{
  // 無前導零／多餘尾零的等價值經正規化後放行；真正 off-scale 的值仍須回報。
  const scaleTokens = {
    color: { $type: 'color',
      text: { primary: { $value: '#000000' }, secondary: { $value: '#111111' }, muted: { $value: '#595959' }, 'on-accent': { $value: '#ffffff' }, link: { $value: '#0a3d91' } },
      surface: { page: { $value: '#ffffff' } }, brand: { accent: { $value: '#0a3d91' } },
      state: { positive: { $value: '#1d7a3f' }, negative: { $value: '#b21f13' } } },
    space: { $type: 'dimension', 4: { $value: '16px' }, half: { $value: '0.5rem' }, one: { $value: '1rem' } },
    radius: { $type: 'dimension', md: { $value: '12px' } },
    shadow: { card: { $value: '0 4px 24px rgba(0,0,0,0.06)' } },
    font: { family: { $type: 'fontFamily', base: { $value: 'system-ui' } }, size: { $type: 'dimension', base: { $value: '1rem' } } },
  };
  const dir = ws('edge-scale', { 'design/tokens.json': JSON.stringify(scaleTokens, null, 2), 'edge-scale.css': EDGE_SCALE, 'dk.config.mjs': config({ preset: 'strict', targets: ['*.css'] }) });
  dk(dir, ['build']);
  const r = slopJson(dir, ['edge-scale.css']);
  const off = (r.data?.findings ?? []).filter((f) => f.ruleId === 'slop/hardcoded-spacing');
  check('20c .5rem≡0.5rem、16.0px≡16px 正規化後不再誤報；只剩真 off-scale（.7rem）→ 恰 1 筆', off.length === 1, `hardcoded-spacing=${off.length} evidences=${off.map((f) => f.evidence)}`);
  check('20c 存活的唯一 finding 是 .7rem（0.7rem 不在 scale，證明沒放寬過頭）', off.length === 1 && /\.7rem/.test(off[0]?.evidence ?? ''), `evidence=${off[0]?.evidence}`);
}
{
  // 已知技術／平台詞加版本號的語境不應誤報 vanity；
  //      真虛榮（含一般英文語境——虛榮數字的主要棲地）一條都不能少地照抓。
  const dirFp = ws('edge-fp', { 'design/tokens.json': GOOD_TOKENS, 'fp-edge.html': FP_EDGE, 'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'] }) });
  dk(dirFp, ['build']);
  const fp = slopJson(dirFp, ['fp-edge.html']);
  check('20d 版本語境正面 fixture 掃到檔（filesScanned>=1）', fp.scanned >= 1, `scanned=${fp.scanned}`);
  check('20d React 18+/TypeScript 5+/iOS 17+/Chrome 120+/Node 18+ 版本語境零誤報（findings=0）', fp.n === 0, `n=${fp.n} rules=${[...fp.rules]}`);
  check('20d   · 特別是 slop/vanity-number 不再誤報版本號', !fp.rules.has('slop/vanity-number'));
  // 必抓（curated 清單不得傷及偵測力）：README 旗艦格式 Trusted by 1000+、一般英文語境 Join 500+、
  // CJK／分隔前導 300+、kMm 記號 10k+、24/7 都必須維持偵測能力。
  const vanityHtml = '<p>Trusted by 1000+ makers</p>\n<p>Join 500+ teams today</p>\n<p>需 React 18+ · 加入 300+ 隊伍 · 10k+ 用戶 · 24/7</p>\n';
  const dirV = ws('edge-vanity', { 'design/tokens.json': GOOD_TOKENS, 'v.html': vanityHtml, 'dk.config.mjs': config({ preset: 'strict', targets: ['v.html'] }) });
  dk(dirV, ['build']);
  const van = slopJson(dirV, ['v.html']);
  const vanEv = (van.data?.findings ?? []).filter((f) => f.ruleId === 'slop/vanity-number').map((f) => f.evidence);
  check('20d 必抓：Trusted by 1000+ makers（README 旗艦格式，英文語境）', vanEv.includes('1000+'), `evidences=${vanEv}`);
  check('20d 必抓：Join 500+ teams（一般英文詞前導）', vanEv.includes('500+'), `evidences=${vanEv}`);
  check('20d 必抓：· 300+（CJK/分隔前導）', vanEv.includes('300+'), `evidences=${vanEv}`);
  check('20d 必抓：10k+（kMm 膨脹記號）', vanEv.includes('10k+'), `evidences=${vanEv}`);
  check('20d 必抓：24/7', vanEv.includes('24/7'), `evidences=${vanEv}`);
  check('20d 恰 5 筆且 React 18+ 被排除（不含 18+）', vanEv.length === 5 && !vanEv.includes('18+'), `evidences=${vanEv}`);
}

/* 語言層：DK_LANG／locale 決定 help、usage errors、findings 與報告本文的語言。 */
group('語言層（DK_LANG／locale／help／usage errors）');
const hasCJK = (s) => /[一-鿿]/.test(s || '');
{
  const dir = ws('lang', {
    'design/tokens.json': GOOD_TOKENS, 'bad.html': BAD_HTML,
    'dk.config.mjs': config({ preset: 'strict', targets: ['bad.html'] }),
  });
  dk(dir, ['build']);

  // (a) DK_LANG=en → --help 英文（指標字串）且 help 主體不含中文字元。
  const helpEn = dk(dir, ['--help'], { DK_LANG: 'en' });
  check('21(a) DK_LANG=en --help 為英文（"design-quality instrument" / "Getting started" / "usage error"）',
    /design-quality instrument/.test(helpEn.out) && /Getting started/.test(helpEn.out) && /usage error/.test(helpEn.out),
    helpEn.out.split('\n')[1]);
  check('21(a) DK_LANG=en --help 主體不含中文字元', !hasCJK(helpEn.out), `firstCJK=${(helpEn.out.match(/[一-鿿]+/) ?? [''])[0]}`);
  // 聚焦命令 help（dk verify --help）en 亦為英文、無 CJK。
  const vHelpEn = dk(dir, ['verify', '--help'], { DK_LANG: 'en' });
  check('21(a) DK_LANG=en dk verify --help 為英文且無 CJK（"Full usage: dk --help"）',
    /Full usage: dk --help/.test(vHelpEn.out) && /run the whole chain/.test(vHelpEn.out) && !hasCJK(vHelpEn.out), vHelpEn.out.split('\n')[1]);

  // (b) DK_LANG=en 未知旗標建議行為英文（含 did-you-mean）＋未知命令＋dk new 缺參數（驗證矩陣格）。
  const unkEn = dk(dir, ['verify', '--nonexist'], { DK_LANG: 'en' });
  check('21(b) DK_LANG=en 未知旗標 → exit 2 且英文（"Unknown flag" / 無 CJK）',
    unkEn.code === 2 && /Unknown flag: --nonexist/.test(unkEn.err) && !hasCJK(unkEn.err), unkEn.err.trim().split('\n')[0]);
  const typoEn = dk(dir, ['baseline', '--accpet'], { DK_LANG: 'en' });
  check('21(b) DK_LANG=en did-you-mean 建議行為英文（"did you mean --accept"）',
    typoEn.code === 2 && /did you mean --accept/.test(typoEn.err) && !hasCJK(typoEn.err), typoEn.err.trim().split('\n')[0]);
  const cmdEn = dk(dir, ['frobnicate'], { DK_LANG: 'en' });
  check('21(b) DK_LANG=en 未知命令 → 英文（"Unknown command"）',
    cmdEn.code === 2 && /Unknown command: dk frobnicate/.test(cmdEn.err) && !hasCJK(cmdEn.err), cmdEn.err.trim().split('\n')[0]);
  const newEn = dk(dir, ['new'], { DK_LANG: 'en' });
  check('21(b) DK_LANG=en dk new 缺參數 → 英文 usage（"Usage: dk new <dir>"）',
    newEn.code === 2 && /Usage: dk new <dir>/.test(newEn.err) && !hasCJK(newEn.err), newEn.err.trim().split('\n')[0]);

  // (c) DK_LANG=zh-TW → help + usage 維持中文（容錯值 zh 亦同）。
  const helpZh = dk(dir, ['--help'], { DK_LANG: 'zh-TW' });
  check('21(c) DK_LANG=zh-TW --help 維持中文（新定位 "AI UI 導演" + CJK）', /AI UI 導演/.test(helpZh.out) && hasCJK(helpZh.out));
  const newZh = dk(dir, ['new'], { DK_LANG: 'zh' });
  check('21(c) DK_LANG=zh（容錯）dk new 缺參數 → 中文 usage（"用法：dk new"）', newZh.code === 2 && /用法：dk new/.test(newZh.err));

  // (d) 未設 DK_LANG + locale 偵測：LANG=en_US → en；LANG=zh_TW → zh-TW（清 LC_ALL/LC_MESSAGES 保確定性）。
  const noLc = { DK_LANG: null, LC_ALL: null, LC_MESSAGES: null };
  const helpLocEn = dk(dir, ['--help'], { ...noLc, LANG: 'en_US.UTF-8' });
  check('21(d) 未設 DK_LANG + LANG=en_US.UTF-8 → 英文 help（locale 偵測，無 CJK）',
    /Getting started/.test(helpLocEn.out) && !hasCJK(helpLocEn.out), helpLocEn.out.split('\n')[1]);
  const helpLocZh = dk(dir, ['--help'], { ...noLc, LANG: 'zh_TW.UTF-8' });
  check('21(d) 未設 DK_LANG + LANG=zh_TW.UTF-8 → 中文 help（含 "起手" + CJK）', /起手/.test(helpLocZh.out) && hasCJK(helpLocZh.out));

  // findings／報告本文遵循語言設定。bad.html 本身含中文內容，evidence 逐字回顯時仍會有 CJK；
  // 這是使用者內容，不是 dk 文案。
  const vEn = dk(dir, ['verify'], { DK_LANG: 'en' });
  check('21(e) DK_LANG=en 下報告本文已英文化（關卡名 "anti-AI-slop" + finding "Hardcoded color"）',
    vEn.code === 1 && /anti-AI-slop/.test(vEn.out) && /Hardcoded color/.test(vEn.out), vEn.out.split('\n').find((l) => /AI-slop/.test(l)) ?? '');
  // zh 對照：同一違規在 zh-TW 下維持中文。
  const vZh = dk(dir, ['verify'], { DK_LANG: 'zh-TW' });
  check('21(e) DK_LANG=zh-TW 下報告本文仍中文（"反 AI-slop" + "寫死顏色" + CJK）',
    vZh.code === 1 && /反 AI-slop/.test(vZh.out) && /寫死顏色/.test(vZh.out) && hasCJK(vZh.out), `code=${vZh.code}`);
}

/* heavy gates 在依賴齊備時執行真實 css-strict、a11y 與 visual 反面 fixture；
   tokenHash 只作稽核脈絡，不得自動降級 pixel diff。缺任一依賴或 DK_GOLDEN=0 時，
   這組測試必須以可見訊息略過。 */
group('heavy gates（css-strict／a11y／visual／tokenHash 稽核脈絡）');
// ── 依賴偵測工具（本組 guard 專用；核心關卡各自也有 canResolve/skipped，這裡是 self-test 層的偵測）──
function repoHasDep(pkg) { return existsSync(join(REPO, 'node_modules', pkg, 'package.json')); }
// chromium 是否可實際啟動（僅偵測 node module 不夠——瀏覽器二進位另裝）。啟一次即關，定奪 yes/no。
function chromiumReady() {
  const probe = spawnSync(process.execPath,
    ['-e', 'import("@playwright/test").then(async({chromium})=>{const b=await chromium.launch();await b.close();process.exit(0)}).catch(()=>process.exit(1))'],
    { cwd: REPO, encoding: 'utf8', timeout: 60000 });
  return probe.status === 0;
}
function goldenDepsStatus() {
  if (process.env.DK_GOLDEN === '0') return { ok: false, missing: 'DK_GOLDEN=0（顯式停用）' };
  const miss = ['stylelint', '@playwright/test', '@axe-core/playwright'].filter((p) => !repoHasDep(p));
  if (miss.length) return { ok: false, missing: miss.join(' / ') };
  if (!chromiumReady()) return { ok: false, missing: 'chromium（npx playwright install chromium）' };
  return { ok: true, missing: '' };
}
// golden 專用工作區：把 repo 的 node_modules symlink 進暫存工作區——讓重關卡的 canResolve 與
// npx 在隔離工作區內解析得到依賴（不污染 repo、不改共用 ws helper 的既有行為）。
function goldenWs(name, files) {
  const dir = mkdtempSync(join(tmpdir(), `dk-golden-${name}-`));
  try { symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir'); }
  catch { try { symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'junction'); } catch { /* */ } }
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
  }
  return dir;
}
{
  const golden = goldenDepsStatus();
  let goldenN = 0;
  const gck = (name, ok, detail = '') => { goldenN++; check(name, ok, detail); };
  if (!golden.ok) {
    process.stdout.write(`  golden 組：skipped（缺 ${golden.missing}）—— 零依賴環境語意不變；安裝依賴後自動啟用實跑\n`);
  } else {
    const STYLELINTRC = readFileSync(join(REPO, '.stylelintrc.json'), 'utf8');
    const CSS_STRICT_HTML = readFileSync(join(REPO, 'gates', 'golden', 'css-strict.html'), 'utf8');
    const A11Y_HTML = readFileSync(join(REPO, 'gates', 'golden', 'a11y.html'), 'utf8');

    /* css-strict：stylelint strict-value 反面 fixture 必須產生 Finding；
       gate 需同時處理 stylelint 可能寫到 stdout 或 stderr 的 JSON。 */
    {
      const dir = goldenWs('css', {
        'design/tokens.json': GOOD_TOKENS, '.stylelintrc.json': STYLELINTRC,
        'css-strict.html': CSS_STRICT_HTML, 'dk.config.mjs': config({ preset: 'strict', targets: ['css-strict.html'] }),
      });
      dk(dir, ['build']);
      const v = verifyJson(dir, ['--gate', 'css-strict']);
      const cs = (v.data?.gates ?? []).find((g) => g.id === 'css-strict');
      gck('22a css-strict 真跑（status=ran，非 skipped）', cs?.status === 'ran', JSON.stringify(cs));
      const csf = (v.data?.findings ?? []).filter((f) => f.ruleId === 'css/strict-value');
      gck('22a css-strict 產出 css/strict-value Finding（>=2；修好 stdout/stderr 讀取前恆為 0）', csf.length >= 2, `n=${csf.length} rules=${[...v.rules]}`);
      gck('22a css/strict-value 帶精確 file:line', csf.length > 0 && csf.every((f) => f.file && f.line != null), csf.map((f) => `${f.file}:${f.line}`).join(' '));
    }

    /* 22b) a11y：axe 必抓的 WCAG 違規頁真跑、真產 Finding；對比違規對照 verifiedPairs 反查。 */
    {
      const dir = goldenWs('a11y', {
        'design/tokens.json': GOOD_TOKENS, 'a11y.html': A11Y_HTML,
        'dk.config.mjs': config({ preset: 'strict', targets: ['a11y.html'] }),
      });
      dk(dir, ['build']);
      const v = verifyJson(dir, ['--gate', 'a11y']);
      const ax = (v.data?.gates ?? []).find((g) => g.id === 'a11y');
      gck('22b a11y 真跑（status=ran）', ax?.status === 'ran', JSON.stringify(ax));
      const axf = (v.data?.findings ?? []).filter((f) => f.ruleId === 'a11y/axe');
      gck('22b a11y 產出 a11y/axe Finding（>=1）', axf.length >= 1, `n=${axf.length} rules=${[...v.rules]}`);
      gck('22b 抓到 image-alt（缺 alt 的 <img>）', axf.some((f) => /image-alt/.test(f.message)), axf.map((f) => f.message.slice(0, 24)).join(' | '));
      const contrastF = axf.find((f) => /color-contrast/.test(f.message));
      gck('22b 對比違規對照 verifiedPairs 反查（訊息含「contract 已證」）', !!contrastF && /contract 已證/.test(contrastF.message), contrastF?.message?.slice(0, 70) ?? '(無 color-contrast finding)');
    }

    /* 22c) visual：同 run 內自含流程（不 commit PNG baseline，避免跨平台截圖差異的經典陷阱）——
       建 baseline → 不變重跑（綠）→ 只改 token（hash 變 → 畫面變）仍為 error；
       還原 token、只改頁面樣式本身（hash 不變 → 畫面變）亦為 error；普通更新一律 fail-closed。 */
    {
      const pwConfig = `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: 'gates', testMatch: /.*\\.spec\\.mjs$/, expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.005, animations: 'disabled' } }, projects: [{ name: 'chromium', use: { browserName: 'chromium', colorScheme: 'light' } }] });\n`;
      const spec = `import { test, expect } from '@playwright/test';\nimport { pathToFileURL } from 'node:url';\nimport { resolve } from 'node:path';\ntest('golden visual', async ({ page }) => {\n  await page.setViewportSize({ width: 480, height: 320 });\n  await page.goto(pathToFileURL(resolve('page.html')).href);\n  await expect(page).toHaveScreenshot('rect.png', { fullPage: true });\n});\n`;
      // 純色矩形頁（無文字 → 像素確定性）：.a 用 token 色（改 token 會變）、.b 用頁底色。
      const page = (bgVar = '--color-brand-accent') => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles/tokens.css"><style>html,body{margin:0;padding:0}.a{width:480px;height:160px;background:var(${bgVar})}.b{width:480px;height:160px;background:var(--color-surface-page)}</style></head><body><div class="a"></div><div class="b"></div></body></html>\n`;
      const dir = goldenWs('visual', {
        'design/tokens.json': GOOD_TOKENS, 'page.html': page(),
        'gates/visual.spec.mjs': spec, 'playwright.config.mjs': pwConfig,
        'dk.config.mjs': config({ targets: ['page.html'] }),
      });
      // build 印出 "tokenHash XXXX"（build 不寫 report.json，故當下 hash 從 build 輸出取，非讀帳本）。
      const buildHash = () => (/tokenHash\s+([0-9a-f]+)/.exec(dk(dir, ['build']).out) ?? [])[1] ?? null;
      const sidecar = () => { try { return JSON.parse(readFileSync(join(dir, '.dk', 'visual-baseline.json'), 'utf8')); } catch { return null; } };
      const vis = (env = {}) => {
        const r = dk(dir, ['verify', '--gate', 'visual', '--json'], env);
        let d = null; try { d = JSON.parse(r.out); } catch { /* */ }
        return { code: r.code, gates: d?.gates ?? [], f: (d?.findings ?? []).filter((x) => x.ruleId === 'visual/regression') };
      };

      const h1 = buildHash();
      // (1) No baseline → explicit skipped state.
      const v0 = vis();
      gck('22c 無 baseline → visual skipped', (v0.gates.find((g) => g.id === 'visual')?.status) === 'skipped', JSON.stringify(v0.gates.find((g) => g.id === 'visual')));
      // (2) DK_UPDATE_VISUAL=1 建立 baseline + sidecar hash
      dk(dir, ['verify', '--gate', 'visual'], { DK_UPDATE_VISUAL: '1' });
      gck('22c DK_UPDATE_VISUAL=1 建立 baseline，sidecar 記錄 tokenHash', sidecar()?.tokenHash === h1, `sidecar=${sidecar()?.tokenHash} h1=${h1}`);
      // (3) 不變重跑 → 綠
      const v1 = vis();
      gck('22c 不變重跑 → 無 visual finding（綠 · exit 0）', v1.f.length === 0 && v1.code === 0, `n=${v1.f.length} code=${v1.code}`);
      // (4) 只改 token（accent 色）→ hash 變 → 畫面變：全域 hash 不是 snapshot 因果證據，仍擋。
      writeFileSync(join(dir, 'design', 'tokens.json'), GOOD_TOKENS.replace('"accent-500": { "$value": "#0071e3" }', '"accent-500": { "$value": "#d81b60" }'));
      const h2 = buildHash();
      gck('22c 改 token 後 tokenHash 改變（h1≠h2）', !!h1 && !!h2 && h1 !== h2, `h1=${h1} h2=${h2}`);
      const vEx = vis();
      gck('22c 改 token 後 pixel diff 仍為 UNVERIFIED（hash 只作脈絡）', vEx.f.length === 1 && /不能證明|cannot prove/.test(vEx.f[0].message), vEx.f.map((x) => x.message.slice(0, 28)).join(''));
      gck('22c tokenHash 改變不得降級（severity=error · exit 1）', vEx.f[0]?.severity === 'error' && vEx.code === 1, `sev=${vEx.f[0]?.severity} code=${vEx.code}`);
      // (5) 還原 token（hash 回 h1）+ 只改頁面樣式本身（hash 不變）→ 仍為未驗證 pixel diff（error，擋關）
      writeFileSync(join(dir, 'design', 'tokens.json'), GOOD_TOKENS);
      const h1b = buildHash();
      gck('22c 還原 token 後 tokenHash 回 h1（hash 純由 token 決定）', h1b === h1, `h1=${h1} h1b=${h1b}`);
      writeFileSync(join(dir, 'page.html'), page('--color-state-negative')); // 改頁面樣式本身、不動 token
      const vUn = vis();
      gck('22c 改頁面樣式（token 不變）→ 明列需人工審查', vUn.f.length === 1 && /人工審查|human review/.test(vUn.f[0].message), vUn.f.map((x) => x.message.slice(0, 28)).join(''));
      gck('22c tokenHash 未變的 diff 仍 severity=error（擋關 · exit 1）', vUn.f[0]?.severity === 'error' && vUn.code === 1, `sev=${vUn.f[0]?.severity} code=${vUn.code}`);
      // (6) fail-closed：tokenHash 未變的 diff 下 DK_UPDATE_VISUAL=1 拒絕更新 baseline。
      const vRef = vis({ DK_UPDATE_VISUAL: '1' });
      gck('22c fail-closed：普通更新拒絕改寫 baseline（error + 拒絕訊息）', /拒絕更新視覺基準/.test(vRef.f[0]?.message ?? '') && vRef.f[0]?.severity === 'error', vRef.f.map((x) => x.message.slice(0, 24)).join(''));
      gck('22c fail-closed：sidecar hash 未被改寫（仍 h1，未把回歸洗成 baseline）', sidecar()?.tokenHash === h1, `sidecar=${sidecar()?.tokenHash}`);
    }

    process.stdout.write(`  golden 組：${goldenN} 項（依賴齊備，實跑 css-strict / a11y / visual + tokenHash 非因果稽核）\n`);
  }
}

/* 23) dk fix --slop：SSOT 精確反查 MachineApplicable autofix（僅 exact-match、絕不作曲）
   —— 把「寫死 #hex ＝ 某 semantic token 解析值」的宣告替換成 var(--token)。核心不變量：
   修得動 / 三層優先 semantic / 歧義跳過 / dk-ignore 不動 / 非 style zone 不動 / --dry-run 不寫 /
   冪等 / 無 exact match 列需人工。值全來自使用者 SSOT，是雙射改寫、非生成。 */
group('dk fix --slop：以 SSOT 精確反查替換');
{
  const count = (s, sub) => s.split(sub).length - 1;
  // 綜合 fixture：可修（semantic，且同時有 primitive 同值 → 三層優先）/ 歧義（兩 semantic 同值）/
  // 無 exact match（需人工）/ dk-ignore 行 / 非 style zone（meta 屬性）各一。
  const combined = [
    '<!doctype html>',
    '<meta name="theme-color" content="#0071e3">',
    '<style>',
    '.brand { color: #0071e3; }',
    '.bg { background: #ffffff; }',
    '.stroke { border-color: #abcdef; }',
    '/* dk-ignore slop/hardcoded-color */',
    '.ig { color: #0071e3; }',
    '</style>',
    '',
  ].join('\n');
  const dir = ws('fix-slop', {
    'design/tokens.json': GOOD_TOKENS,
    'page.html': combined,
    'fixable.html': '<style>.a{ color:#0071e3; } .b{ background:#f5f5f7; }</style>\n',
    'dk.config.mjs': config({ targets: ['*.html'] }),
  });
  dk(dir, ['build']);

  // (A) --dry-run 不寫檔、但仍列出將修清單。
  const before = readFileSync(join(dir, 'page.html'), 'utf8');
  const dry = dk(dir, ['fix', '--slop', '--dry-run', 'page.html']);
  const afterDry = readFileSync(join(dir, 'page.html'), 'utf8');
  check('23 --dry-run 不寫檔（內容逐字不變）', before === afterDry);
  check('23 --dry-run 仍列出將修清單（brand-accent）＋標記未寫檔', /color-brand-accent/.test(dry.out) && /dry-run（未寫檔）/.test(dry.out), dry.out.split('\n').find((l) => /將替換/.test(l)) ?? '');

  // (B) 實修 page.html。
  const fix = dk(dir, ['fix', '--slop', 'page.html']);
  const after = readFileSync(join(dir, 'page.html'), 'utf8');
  check('23 fix --slop exit 0（操作命令）', fix.code === 0, `code=${fix.code}`);
  check('23 修得動：.brand 寫死色 → var(--color-brand-accent)（精準替換、保留 color: 前綴與 ;）', /\.brand \{ color: var\(--color-brand-accent\); \}/.test(after), after.split('\n')[3]);
  check('23 三層優先：選 semantic 而非 primitive（不出現 color-base-accent-500）', /color-brand-accent/.test(after) && !/color-base-accent-500/.test(after));
  check('23 歧義跳過：#ffffff 不動（surface-page 與 text-on-accent 同值）', count(after, '#ffffff') === 1 && /background: #ffffff/.test(after));
  check('23 歧義可見列出（輸出含兩個 semantic 候選）', /color-surface-page/.test(fix.out) && /color-text-on-accent/.test(fix.out) && /歧義未動/.test(fix.out), fix.out.split('\n').find((l) => /ffffff/.test(l)) ?? '');
  check('23 無 exact match：#abcdef 不動並列「需人工」', count(after, '#abcdef') === 1 && /需人工/.test(fix.out), fix.out.split('\n').find((l) => /abcdef/.test(l)) ?? '');
  check('23 dk-ignore 行不動（.ig 的 #0071e3 保留）', /\.ig \{ color: #0071e3; \}/.test(after));
  check('23 非 style zone 不動（meta theme-color 的 #0071e3 保留，未被當寫死色替換）', /content="#0071e3"/.test(after));
  check('23 只替換 style zone 內的 exact：其餘 #0071e3（meta + dk-ignore 行）保留 → count=2', count(after, '#0071e3') === 2, `count=${count(after, '#0071e3')}`);
  check('23 結語守門：明示「僅精確反查替換，未發明任何值」', /未發明任何值/.test(fix.out) && /絕不作曲/.test(fix.out));

  // (C) 冪等：二跑檔案零變更、回報 0 處。
  const fix2 = dk(dir, ['fix', '--slop', 'page.html']);
  const after2 = readFileSync(join(dir, 'page.html'), 'utf8');
  check('23 冪等：二跑檔案逐字零變更', after === after2);
  check('23 冪等：二跑回報精確反查替換 0 處', /精確反查替換：0 處/.test(fix2.out), fix2.out.split('\n').find((l) => /0 處/.test(l)) ?? '');

  // (D) 全可修檔 → fix 後 verify 綠（0 hardcoded-color、exit 0），且內容為 var 替換。
  dk(dir, ['fix', '--slop', 'fixable.html']);
  const fixableAfter = readFileSync(join(dir, 'fixable.html'), 'utf8');
  check('23 全可修檔：多筆同行寫死色皆替換（brand-accent + surface-subtle）', /var\(--color-brand-accent\)/.test(fixableAfter) && /var\(--color-surface-subtle\)/.test(fixableAfter) && count(fixableAfter, '#') === 0, fixableAfter.trim());
  const vf = slopJson(dir, ['fixable.html']);
  check('23 全可修檔 fix --slop 後 verify 綠（0 hardcoded-color · exit 0）', vf.code === 0 && !vf.rules.has('slop/hardcoded-color'), `code=${vf.code} rules=${[...vf.rules]}`);

  // (E) 邊界回歸：per-zone 掃描——inline style（值末無分號、極常見）的真色值仍可修，且其後
  //     zone 外的 meta #hex 絕不被越界吞併替換（RE_HEX 值字元類跨換行 → 整檔一次跑會誤傷）。
  const inlineHtml = [
    '<span style="color: #0071e3">a</span>',      // 值末無分號 → 仍要能修
    '<meta name="theme-color" content="#f5f5f7">', // zone 外、緊接其後（無 ;{},）→ 絕不動
    '',
  ].join('\n');
  writeFileSync(join(dir, 'inline.html'), inlineHtml);
  const fx = dk(dir, ['fix', '--slop', 'inline.html']);
  const inlineAfter = readFileSync(join(dir, 'inline.html'), 'utf8');
  check('23 per-zone：inline 值末無分號的 #0071e3 仍被修（不因跨界吞併而漏）', /style="color: var\(--color-brand-accent\)"/.test(inlineAfter), inlineAfter.split('\n')[0]);
  check('23 per-zone：zone 外緊接的 meta #f5f5f7 絕不被越界替換', /content="#f5f5f7"/.test(inlineAfter) && !/content="var\(/.test(inlineAfter), inlineAfter.split('\n')[1]);
  check('23 per-zone：本檔恰替換 1 處（只有 zone 內那筆）', /已替換 1 處/.test(fx.out), fx.out.split('\n').find((l) => /已替換/.test(l)) ?? '');
}

/* 24) DTCG 2025.10 物件式讀入（向後相容）＋ tokens import（Tokens Studio） */
group('DTCG 2025.10 物件式讀入與 Tokens Studio 匯入');
{
  const hashOf = (out) => (out.match(/tokenHash (\w+)/) || [])[1];
  const has = (s, sub) => s.includes(sub);

  /* (A) 等值斷言：物件式 color/dimension == 等值字串式 → 相同 tokens.css 與相同 tokenHash。
     obj twin 同時涵蓋三條路徑：srgb components（brand）、srgb hex fallback（text）、
     非 srgb hex fallback + 物件式 dark override（text.dark）、dimension 物件形（space）。 */
  const STR_TWIN = JSON.stringify({
    color: { $type: 'color',
      brand: { $value: '#cc33ff' },
      text: { $value: '#000000', $extensions: { modes: { dark: '#0071e3' } } } },
    space: { $type: 'dimension', md: { $value: '16px' }, sm: { $value: '0.5rem' } },
  });
  const OBJ_TWIN = JSON.stringify({
    color: { $type: 'color',
      brand: { $value: { colorSpace: 'srgb', components: [0.8, 0.2, 1] } },              // → #cc33ff（components 路徑）
      text: { $value: { colorSpace: 'srgb', hex: '#000000' },                            // → #000000（srgb hex fallback）
        $extensions: { modes: { dark: { colorSpace: 'display-p3', hex: '#0071e3' } } } } }, // → #0071e3（非 srgb hex fallback · 物件式 dark）
    space: { $type: 'dimension', md: { $value: { value: 16, unit: 'px' } }, sm: { $value: { value: 0.5, unit: 'rem' } } },
  });
  const wsStr = ws('dtcg-str', { 'design/tokens.json': STR_TWIN, 'dk.config.mjs': config() });
  const wsObj = ws('dtcg-obj', { 'design/tokens.json': OBJ_TWIN, 'dk.config.mjs': config() });
  const bStr = dk(wsStr, ['build']);
  const bObj = dk(wsObj, ['build']);
  check('24 物件式 color/dimension build 成功（exit 0）', bStr.code === 0 && bObj.code === 0, `str=${bStr.code} obj=${bObj.code} ${bObj.err.trim()}`);
  const cssStr = existsSync(join(wsStr, 'styles', 'tokens.css')) ? readFileSync(join(wsStr, 'styles', 'tokens.css'), 'utf8') : '';
  const cssObj = existsSync(join(wsObj, 'styles', 'tokens.css')) ? readFileSync(join(wsObj, 'styles', 'tokens.css'), 'utf8') : '';
  check('24 物件式 == 字串式：tokens.css 逐位元組相同', cssStr && cssStr === cssObj, `len str=${cssStr.length} obj=${cssObj.length}`);
  check('24 物件式 == 字串式：tokenHash 相同（同值必同 hash）', hashOf(bStr.out) && hashOf(bStr.out) === hashOf(bObj.out), `str=${hashOf(bStr.out)} obj=${hashOf(bObj.out)}`);
  // 三條解析路徑落地值正確
  check('24 srgb components → #cc33ff', has(cssObj, '--color-brand: #cc33ff;'), cssObj.split('\n').find((l) => /color-brand/.test(l)));
  check('24 srgb hex fallback → #000000', has(cssObj, '--color-text: #000000;'));
  check('24 非 srgb（display-p3）hex fallback + 物件式 dark override → #0071e3', has(cssObj, '--color-text: #0071e3;'), cssObj.split('\n').filter((l) => /color-text/.test(l)).join(' | '));
  check('24 dimension 物件形 → 16px / 0.5rem', has(cssObj, '--space-md: 16px;') && has(cssObj, '--space-sm: 0.5rem;'));

  /* (B) 畸形物件 → 教學錯誤 exit 2、不 crash（至少 3 種；此處 4 種）。 */
  const malformed = [
    ['srgb 缺 components 無 hex', { color: { x: { $value: { colorSpace: 'srgb' } } } }],
    ['未知 colorSpace 無 hex', { color: { x: { $value: { colorSpace: 'cmyk', components: [0, 0, 0, 0] } } } }],
    ['srgb components 數不對', { color: { x: { $value: { colorSpace: 'srgb', components: [0, 0] } } } }],
    ['dimension unit 非 px/rem', { space: { x: { $value: { value: 1, unit: 'em' } } } }],
  ];
  for (const [label, tok] of malformed) {
    const d = ws('dtcg-bad', { 'design/tokens.json': JSON.stringify(tok), 'dk.config.mjs': config() });
    const r = dk(d, ['build']);
    const crashed = /未預期錯誤/.test(r.err) || /\n\s+at /.test(r.err); // 噴 stack ＝ crash
    check(`24 畸形（${label}）→ exit 2 · 教學紅字 · 不 crash`, r.code === 2 && /讀入端/.test(r.err) && !crashed, `code=${r.code} crashed=${crashed} err=${r.err.trim().split('\n')[0]}`);
  }

  /* (C) import：single-file Tokens Studio → dk。摘要數字、輸出可解析、覆寫保護、消化。 */
  const TS_SINGLE = readFileSync(join(REPO, 'gates', 'fixtures', 'tokens-studio-single.json'), 'utf8');
  const impDir = ws('ts-import', { 'single.json': TS_SINGLE, 'a.html': '<!doctype html><h1>hi</h1>' });
  const imp = dk(impDir, ['tokens', 'import', 'single.json', '--out', 'design/tokens.imported.json']);
  check('24 import single-file exit 0', imp.code === 0, `code=${imp.code} ${imp.err.trim()}`);
  check('24 import 摘要：轉換 8 個 token', /轉換 8 個 token/.test(imp.out), imp.out.split('\n').find((l) => /轉換/.test(l)));
  check('24 import 摘要：跳過 2 個（typography + boxShadow，可見列出）', /跳過 2 個/.test(imp.out) && /typography/.test(imp.out) && /boxShadow/.test(imp.out), imp.out.split('\n').filter((l) => /跳過|typography|boxShadow/.test(l)).join(' | '));
  check('24 import 摘要：未解析 alias 1 個（{color.missing} 列出）', /未解析 alias 1 個/.test(imp.out) && /\{color\.missing\}/.test(imp.out), imp.out.split('\n').find((l) => /missing/.test(l)));
  check('24 import 收尾自檢：buildManifest 解析 8 個 token', /自檢：buildManifest 解析 8 個 token/.test(imp.out));
  check('24 import 寫出輸出檔', existsSync(join(impDir, 'design', 'tokens.imported.json')));
  // 輸出可被 dk 消化：buildManifest 可解析（tokens list 對匯入檔 exit 0）
  writeFileSync(join(impDir, 'dk.config.mjs'), config({ tokens: { source: 'design/tokens.imported.json', output: { css: 'styles/tokens.css' } } }));
  const lst = dk(impDir, ['tokens', 'list']);
  check('24 匯入檔可被 dk 消化：dk tokens list exit 0 且 8 tokens', lst.code === 0 && /8 tokens/.test(lst.out), `code=${lst.code}`);
  const bld = dk(impDir, ['build']);
  check('24 匯入檔 dk build exit 0', bld.code === 0, `code=${bld.code} ${bld.err.trim()}`);
  // 覆寫保護：再次 import 到既有輸出檔 → 拒絕 exit 2（沿用 --html 覆寫保護精神）
  const imp2 = dk(impDir, ['tokens', 'import', 'single.json', '--out', 'design/tokens.imported.json']);
  check('24 覆寫保護：既有輸出檔 → 拒絕覆寫 exit 2', imp2.code === 2 && /拒絕覆寫/.test(imp2.err), `code=${imp2.code}`);
  // dk verify 可跑；contract 對匯入檔缺 required token 如實回報（正確行為，非 crash）
  const vimp = verifyJson(impDir);
  check('24 匯入檔 dk verify 可跑且如實報缺 required（正確行為）', vimp.data != null && vimp.rules.has('tokens/required') && vimp.code === 1, `code=${vimp.code} rules=${[...vimp.rules]}`);

  /* (D) import：multi-file 目錄 → dk。$themes.json / $metadata.json 跳過、各 set 攤平合併。 */
  const multiBase = join(REPO, 'gates', 'fixtures', 'tokens-studio-multi');
  const mdir = ws('ts-multi', {
    'ts/core.json': readFileSync(join(multiBase, 'core.json'), 'utf8'),
    'ts/semantic.json': readFileSync(join(multiBase, 'semantic.json'), 'utf8'),
    'ts/$metadata.json': readFileSync(join(multiBase, '$metadata.json'), 'utf8'),
    'ts/$themes.json': readFileSync(join(multiBase, '$themes.json'), 'utf8'),
  });
  const impM = dk(mdir, ['tokens', 'import', 'ts', '--out', 'imported-multi.json']);
  check('24 import multi-file（目錄）exit 0', impM.code === 0, `code=${impM.code} ${impM.err.trim()}`);
  check('24 import multi-file 摘要：multi-file · 2 個 set · 轉換 5', /multi-file/.test(impM.out) && /2 個 token set/.test(impM.out) && /轉換 5 個 token/.test(impM.out), impM.out.split('\n').filter((l) => /來源|轉換/.test(l)).join(' | '));
  check('24 import multi-file 摘要：跳過 1（boxShadow）· 未解析 alias 1', /跳過 1 個/.test(impM.out) && /boxShadow/.test(impM.out) && /未解析 alias 1 個/.test(impM.out));
  check('24 import multi-file 收尾自檢通過（buildManifest 解析 5）', /自檢：buildManifest 解析 5 個 token/.test(impM.out));

  /* (E) import 用法/錯誤路徑。 */
  check('24 import 無來源引數 → exit 2 用法', dk(mdir, ['tokens', 'import']).code === 2);
  check('24 import 來源不存在 → exit 2', dk(mdir, ['tokens', 'import', 'nope.json']).code === 2 && /找不到匯入來源/.test(dk(mdir, ['tokens', 'import', 'nope.json']).err));

  /* (F) 既有 2021 字串方言零改動（GOOD_TOKENS build 仍全綠、hash 穩定）——向後相容硬底線。 */
  const wsCompat = ws('dtcg-compat', { 'design/tokens.json': GOOD_TOKENS, 'dk.config.mjs': config() });
  const bc = dk(wsCompat, ['build']);
  check('24 向後相容：字串方言 GOOD_TOKENS build exit 0', bc.code === 0, `code=${bc.code}`);
}

/* 規模化不變量：per-file 快取、增量 watch、terminal 折疊上限與效能。 */
group('規模化不變量（per-file 快取／增量 watch／輸出折疊／效能）');
{
  // --summary 讀回 { exitCode, filesScanned, cacheHits, counts, rules }。
  const sumOf = (cwd, extra = []) => {
    const r = dk(cwd, ['verify', '--summary', ...extra]);
    let data = null; try { data = JSON.parse(r.out); } catch { /* */ }
    return { ...r, data };
  };
  const timedSum = (cwd, extra = []) => {
    const t = process.hrtime.bigint();
    const s = sumOf(cwd, extra);
    return { ...s, ms: Number(process.hrtime.bigint() - t) / 1e6 };
  };

  /* (A) 快取正確性 —— 冷/熱等值、單檔增量、過濾層不被快取、全域失效、逃生口、自癒。 */
  {
    const dir = ws('cache', {
      'design/tokens.json': GOOD_TOKENS,
      'dk.config.mjs': config({ targets: ['src/**/*.jsx'] }),
      'src/Clean.jsx': 'export const C = () => <div style={{ color: "var(--color-text-primary)" }}>ok</div>;\n',
      'src/Dirty.jsx': 'export const D = () => <div style={{ color: "#0071e3" }}>lorem ipsum</div>;\n',
    });
    dk(dir, ['build']);
    const cold = verifyJson(dir);           // 冷跑（.dk/cache.json 尚不存在）→ cacheHits 0
    const warm = verifyJson(dir);           // 熱跑（零變更）→ cacheHits 全集
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const fp = (v) => (v.data?.findings ?? []).map((f) => `${f.ruleId}|${f.file}|${f.line}|${f.col}|${f.message}`).sort();
    check('25A 冷跑後熱跑 findings 完全相同', eq(fp(cold), fp(warm)), `cold=${fp(cold).length} warm=${fp(warm).length}`);
    check('25A 冷/熱 filesScanned 一致', cold.data?.filesScanned === warm.data?.filesScanned && warm.data?.filesScanned === 2, `cold=${cold.data?.filesScanned} warm=${warm.data?.filesScanned}`);
    check('25A 冷跑 cacheHits=0、熱跑 cacheHits=全集(2)', cold.data?.cacheHits === 0 && warm.data?.cacheHits === 2, `cold=${cold.data?.cacheHits} warm=${warm.data?.cacheHits}`);
    check('25A 存在 .dk/cache.json', existsSync(join(dir, '.dk', 'cache.json')));

    // 單檔變更：只重掃該檔（cacheHits=全集-1），且新內容反映到 findings。
    writeFileSync(join(dir, 'src', 'Dirty.jsx'), 'export const D = () => <div style={{ color: "#0071e3", background: "#ff00aa" }}>lorem ipsum</div>;\n');
    const afterEdit = verifyJson(dir);
    check('25A 單檔變更 → 只重掃該檔（cacheHits=1，另一檔命中）', afterEdit.data?.cacheHits === 1, `cacheHits=${afterEdit.data?.cacheHits}`);
    check('25A 單檔變更後新增寫死色被抓（2 筆）', countRule(afterEdit.data?.findings, 'slop/hardcoded-color') === 2, `hardcoded-color=${countRule(afterEdit.data?.findings, 'slop/hardcoded-color')}`);

    // 改 severity（不改任何檔）→ 新 severity 立即生效，且快取仍命中（證明過濾層不被快取）。
    writeFileSync(join(dir, 'dk.config.mjs'), config({ targets: ['src/**/*.jsx'], severity: { 'slop/hardcoded-color': 'off' } }));
    const sevJson = verifyJson(dir);
    check('25A 改 severity（不改檔）→ 新 severity 立即生效（hardcoded-color 被消音）', !sevJson.rules.has('slop/hardcoded-color'), `rules=${[...sevJson.rules]}`);
    check('25A 改 severity 不觸發重掃（cacheHits 仍=全集2 → 過濾層不被快取）', sevJson.data?.cacheHits === 2, `cacheHits=${sevJson.data?.cacheHits}`);

    // 改 tokens.json → 全域指紋變 → 整簇作廢重掃（cacheHits=0）。
    writeFileSync(join(dir, 'dk.config.mjs'), config({ targets: ['src/**/*.jsx'] })); // 還原 severity
    verifyJson(dir); // 讓上一個 config 變更後的快取重新命中，隔離 tokens 變因
    const tok = readFileSync(join(dir, 'design', 'tokens.json'), 'utf8').replace(/"#0071e3"/, '"#0061d3"');
    writeFileSync(join(dir, 'design', 'tokens.json'), tok);
    const tokRun = verifyJson(dir);
    check('25A 改 tokens.json → 全簇作廢重掃（cacheHits=0）', tokRun.data?.cacheHits === 0, `cacheHits=${tokRun.data?.cacheHits}`);

    // --no-cache 可跑、findings 與帶快取一致、cacheHits=0。
    const nc = verifyJson(dir, ['--no-cache']);
    const withCache = verifyJson(dir);
    check('25A --no-cache 可跑且 cacheHits=0', nc.data?.cacheHits === 0 && nc.code === withCache.code, `nc.hits=${nc.data?.cacheHits} nc.code=${nc.code} wc.code=${withCache.code}`);
    check('25A --no-cache findings 與帶快取完全相同', eq(fp(nc), fp(withCache)), `nc=${fp(nc).length} wc=${fp(withCache).length}`);

    // 壞快取檔 → 靜默重建、不 crash、findings 正確。
    writeFileSync(join(dir, '.dk', 'cache.json'), 'NOT-JSON{{{ broken');
    const healed = verifyJson(dir);
    check('25A cache 壞檔 → 靜默重建自癒（findings 正確、不 crash）', healed.data != null && eq(fp(healed), fp(withCache)), `code=${healed.code}`);
  }

  /* (B) terminal 折疊上限 —— >N 同規則折疊成誠實計數行；--all 展開；--json/--summary 不受影響。 */
  {
    const HC = Array.from({ length: 13 }, (_, i) => `  <div style={{ color: "#a${i.toString(16)}b0c${(i + 3).toString(16)}" }}>x</div>`).join('\n');
    const dir = ws('collapse', {
      'design/tokens.json': GOOD_TOKENS,
      'dk.config.mjs': config({ targets: ['src/**/*.jsx'] }),
      'src/Many.jsx': `export const M = () => (\n  <section>\n${HC}\n  </section>\n);\n`,
    });
    dk(dir, ['build']);
    const jsonN = countRule(verifyJson(dir).data?.findings, 'slop/hardcoded-color');
    const term = dk(dir, ['verify']).out;
    const termAll = dk(dir, ['verify', '--all']).out;
    // 每筆展開的 finding 印一條 loc 行（含 src/Many.jsx:line）——數 loc 行＝實際展開筆數。
    const locLines = (s) => (s.match(/src\/Many\.jsx:\d+/g) || []).length;
    const collapseM = (term.match(/另有 (\d+) 筆同規則 slop\/hardcoded-color/) || [])[1];
    check('25B >N 同規則 → terminal 折疊行含正確總數（另有 N-10 筆）', collapseM === String(jsonN - 10) && jsonN > 10, `json=${jsonN} 折疊=${collapseM}`);
    check('25B 折疊：預設每規則明細至多 10 筆', locLines(term) === 10, `展開 loc 行=${locLines(term)}`);
    check('25B --all 展開全部、無折疊行', !/另有 \d+ 筆同規則/.test(termAll) && locLines(termAll) === jsonN, `all loc 行=${locLines(termAll)} json=${jsonN}`);
    // --json / --summary 不受折疊影響（誠實全量）。
    const sm = sumOf(dir).data;
    const smTop = (sm?.rules?.top ?? []).find((r) => r.ruleId === 'slop/hardcoded-color');
    check('25B --json 不受折疊影響（完整筆數）', jsonN === 13, `json=${jsonN}`);
    check('25B --summary 不受折疊影響（per-rule 完整計數）', smTop?.count === 13, `summary count=${smTop?.count}`);
  }

  /* (C) 效能 —— 2000 檔冷/熱/單檔變更。cacheHits 是決定性正確性證據；牆鐘只守
     「熱跑至少快 20%」的寬門檻，避免共享 CI runner / filesystem cache 抖動造成假紅。 */
  {
    const N = 2000, LINES = 60;
    const dir = mkdtempSync(join(tmpdir(), 'dk-perf-'));
    mkdirSync(join(dir, 'design'), { recursive: true });
    writeFileSync(join(dir, 'design', 'tokens.json'), GOOD_TOKENS);
    writeFileSync(join(dir, 'dk.config.mjs'), config({ targets: ['src/**/*.jsx'] }));
    const row = (i) => `  <div style={{ color: "var(--color-text-primary)", background: "var(--color-surface-page)", padding: "var(--space-md)", margin: "var(--space-sm)" }}>row ${i} descriptive prose about layout purpose in this component block</div>`;
    for (let i = 0; i < N; i++) {
      const sub = join(dir, 'src', 'd' + (i % 20));
      mkdirSync(sub, { recursive: true });
      const rows = []; for (let k = 0; k < LINES; k++) rows.push(row(i * 1000 + k));
      writeFileSync(join(sub, `C${i}.jsx`), `export const C${i} = () => (\n  <section>\n${rows.join('\n')}\n  </section>\n);\n`);
    }
    dk(dir, ['build']);
    try { rmSync(join(dir, '.dk'), { recursive: true, force: true }); } catch { /* */ }
    const cold = timedSum(dir);
    // 熱跑取多次最小值（避開 GC/排程噪音），與單一冷跑比對。
    const w1 = timedSum(dir), w2 = timedSum(dir), w3 = timedSum(dir);
    const warmMs = Math.min(w1.ms, w2.ms, w3.ms);
    check('25C 2000 檔冷跑 cacheHits=0 · 熱跑 cacheHits=全集(2000)', cold.data?.cacheHits === 0 && w1.data?.cacheHits === N, `cold=${cold.data?.cacheHits} warm=${w1.data?.cacheHits}`);
    // 牆鐘比較只在專用機器上可靠：共享 CI runner 的鄰居噪音可讓快取加速
    // 低於任何固定門檻（實例：同一 commit 兩台 runner 一過一不過）。快取
    // 「機制」由前後的 cacheHits 斷言確定性強制；牆鐘只當本機煙霧測試。
    if (process.env.CI) {
      check('25C 熱跑牆鐘守門（skipped：共享 CI runner 牆鐘不可靠 — cacheHits 斷言仍全數強制）', true);
    } else {
      check('25C 熱跑（零變更）至少比冷跑快 20%（寬鬆牆鐘守門）', warmMs < cold.ms * 0.8, `冷=${cold.ms.toFixed(0)}ms 熱=${warmMs.toFixed(0)}ms 比=${(warmMs / cold.ms).toFixed(3)}`);
    }
    // 單檔變更：只重掃該檔（cacheHits=全集-1）。
    writeFileSync(join(dir, 'src', 'd0', 'C0.jsx'), `export const C0 = () => <div style={{ color: "#0071e3" }}>changed lorem ipsum</div>;\n`);
    const one = timedSum(dir);
    check('25C 2000 檔單檔變更 → 只重掃該檔（cacheHits=1999）', one.data?.cacheHits === N - 1, `cacheHits=${one.data?.cacheHits}`);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }

  /* (D) watch 真增量 —— 黑箱 spawn；單檔變更→增量、合併帳本、tokens 變更→全量、SIGINT 收尾。
     平台守門：Linux Node<20 的 recursive fs.watch 不可用（本機 macOS 可）——不可用則整段可見 skip
     並沿用 heavy gate 的依賴守門語意；零依賴或其他平台會明確略過。 */
  {
    const recursiveOK = (() => {
      const d = mkdtempSync(join(tmpdir(), 'dk-wcap-'));
      try { const w = fsWatch(d, { recursive: true }, () => {}); w.close(); return true; }
      catch { return false; }
      finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    })();
    if (!recursiveOK) {
      check('25D watch 增量（skipped：本平台不支援 recursive fs.watch — 見 watch 平台誠實註解）', true);
    } else {
      const wdir = ws('watch', {
        'design/tokens.json': GOOD_TOKENS,
        'dk.config.mjs': config({ targets: ['src/**/*.jsx'] }),
        'src/A.jsx': 'export const A = () => <div style={{ color: "var(--color-text-primary)" }}>clean</div>;\n',
        'src/B.jsx': 'export const B = () => <div style={{ color: "var(--color-text-primary)" }}>clean</div>;\n',
      });
      dk(wdir, ['build']);
      const out = await new Promise((resolve) => {
        const p = spawn(process.execPath, [DK, 'watch'], { cwd: wdir, env: { ...process.env, NO_COLOR: '1', DK_LANG: 'zh-TW' } });
        let buf = '';
        p.stdout.on('data', (d) => (buf += d));
        p.stderr.on('data', (d) => (buf += d));
        // 存檔單一檔（加寫死色 + lorem）→ 增量；改 tokens.json → 全量；SIGINT → 收尾。
        setTimeout(() => writeFileSync(join(wdir, 'src', 'B.jsx'), 'export const B = () => <div style={{ color: "#0071e3" }}>lorem ipsum</div>;\n'), 800);
        setTimeout(() => writeFileSync(join(wdir, 'design', 'tokens.json'), GOOD_TOKENS.replace(/"#0071e3"/, '"#0061d3"')), 1900);
        setTimeout(() => p.kill('SIGINT'), 3000);
        p.on('close', () => resolve(buf));
      });
      check('25D watch 單檔變更 → 增量重掃該檔（不全量）', /增量重掃\s+src\/B\.jsx/.test(out), out.split('\n').find((l) => /增量重掃/.test(l)) ?? '(無增量行)');
      check('25D watch 增量輸出含該檔新 finding（hardcoded-color）', /增量重掃[\s\S]*slop\/hardcoded-color/.test(out));
      check('25D watch 增量讀合併帳本印全 repo 摘要（2 error，A 乾淨＋B 兩錯）', /全 repo（合併帳本）：2 error/.test(out), out.split('\n').find((l) => /合併帳本/.test(l)) ?? '(無摘要行)');
      check('25D watch tokens 變更 → 全量重跑（跑 ssot-sync：產物與 SSOT 不同步）', /產物與 SSOT 不同步/.test(out));
      check('25D watch SIGINT 收尾（再見）', /再見/.test(out));
    }
  }
}

/* findings 與報告本文完整 i18n：
   —— 語言解析沿用 resolveLang（DK_LANG > locale > en）；Finding 攜語言中性 fp（zh-TW 正規訊息）
   使 baseline / SARIF 指紋跨語言穩定、既有 baseline 檔零遷移即相容（見 src/core/i18n.mjs 抬頭）。
   spawn helper 預設注入 DK_LANG=zh-TW；本組顯式覆寫 en／zh 建立雙語矩陣。 */
group('完整 i18n（英文輸出／中文輸出／跨語言穩定指紋）');
const BAD_MIN = '<!doctype html><html><head><style>.a{color:#0071e3}</style></head><body><h1>Hi</h1><p>lorem ipsum dolor sit amet</p></body></html>\n';
const enJson = (cwd, extra = []) => { const r = dk(cwd, ['verify', '--json', ...extra], { DK_LANG: 'en' }); try { return JSON.parse(r.out); } catch { return null; } };
const summaryLang = (cwd, lang) => { const r = dk(cwd, ['verify', '--summary'], { DK_LANG: lang }); try { return JSON.parse(r.out); } catch { return null; } };
{
  // (a) DK_LANG=en 全流程：報告本文英文、findings 英文、整份輸出無 CJK。
  const dir = ws('i18n', { 'design/tokens.json': GOOD_TOKENS, 'bad.html': BAD_MIN, 'dk.config.mjs': config({ targets: ['bad.html'] }) });
  dk(dir, ['build']);
  const vEn = dk(dir, ['verify'], { DK_LANG: 'en' });
  check('26a en verify 有違規 → exit 1', vEn.code === 1, `code=${vEn.code}`);
  check('26a en 報告本文英文（關卡名 "anti-AI-slop" + finding "Hardcoded color"）',
    /anti-AI-slop/.test(vEn.out) && /Hardcoded color #0071e3/.test(vEn.out), vEn.out.split('\n').find((l) => /AI-slop/.test(l)) ?? '');
  check('26a en verify 整份輸出無 CJK 字元', !hasCJK(vEn.out), `firstCJK=${(vEn.out.match(/[一-鿿]+/) ?? [''])[0]}`);
  const jEn = enJson(dir);
  check('26a en findings.message 為英文（hardcoded-color + lorem 皆無 CJK）',
    !!jEn && jEn.findings.length > 0 && jEn.findings.every((f) => !hasCJK(f.message)),
    (jEn?.findings ?? []).map((f) => f.message).find(hasCJK) ?? 'all-en');
  // 教學卡 / 自省 / 環境 / 對比各抽一驗英文＋無 CJK。
  const exEn = dk(dir, ['explain', 'slop/hardcoded-color'], { DK_LANG: 'en' });
  check('26a en explain 英文（"Why it matters" / "One-line fix" · 無 CJK）',
    /Why it matters/.test(exEn.out) && /One-line fix/.test(exEn.out) && !hasCJK(exEn.out), exEn.out.split('\n')[3] ?? '');
  const rulesEn = dk(dir, ['rules'], { DK_LANG: 'en' });
  check('26a en rules 英文（"Rules in effect" · 無 CJK）', /Rules in effect/.test(rulesEn.out) && !hasCJK(rulesEn.out), rulesEn.out.split('\n')[1] ?? '');
  const docEn = dk(dir, ['doctor'], { DK_LANG: 'en' });
  check('26a en doctor 英文（"environment check" / "Optional deps" · 無 CJK）',
    /environment check/.test(docEn.out) && /Optional deps/.test(docEn.out) && !hasCJK(docEn.out), docEn.out.split('\n')[1] ?? '');
  const conEn = dk(dir, ['contrast'], { DK_LANG: 'en' });
  check('26a en tokens contrast 英文（"Contrast (wcag)" · 無 CJK）', /Contrast \(wcag\)/.test(conEn.out) && !hasCJK(conEn.out), conEn.out.split('\n')[0] ?? '');
  const fixEn = dk(dir, ['fix', '--slop', '--dry-run'], { DK_LANG: 'en' });
  check('26a en fix --slop --dry-run 英文（"Will replace" / "never composes" · 無 CJK）',
    /Will replace/.test(fixEn.out) && /never composes/.test(fixEn.out) && !hasCJK(fixEn.out), fixEn.out.split('\n').find((l) => /replace/i.test(l)) ?? '');

  // DK_LANG=zh-TW：同一違規維持中文。
  const vZh = dk(dir, ['verify'], { DK_LANG: 'zh-TW' });
  check('26b zh verify 中文（"寫死顏色 #0071e3 — 這其實是 var(--color-brand-accent)" 逐字）',
    /寫死顏色 #0071e3 — 這其實是 var\(--color-brand-accent\)/.test(vZh.out), vZh.out.split('\n').find((l) => /寫死顏色/.test(l)) ?? '');
  const exZh = dk(dir, ['explain', 'slop/hardcoded-color'], { DK_LANG: 'zh-TW' });
  check('26b zh explain 中文（"為什麼重要" + "一行怎麼修"）', /為什麼重要/.test(exZh.out) && /一行怎麼修/.test(exZh.out));
}
{
  // (c) baseline 跨語言：zh accept → en 重跑舊債不復活、新增違規照擋（反向 en→zh 亦測）。
  const dir = ws('i18n-bl', { 'design/tokens.json': GOOD_TOKENS, 'bad.html': BAD_MIN, 'dk.config.mjs': config({ targets: ['bad.html'] }) });
  dk(dir, ['build']);
  const acc = dk(dir, ['baseline', '--accept'], { DK_LANG: 'zh-TW' });
  check('26c zh baseline --accept 寫入接受清單', acc.code === 0 && existsSync(join(dir, '.dk', 'baseline.json')));
  const enAfter = dk(dir, ['verify'], { DK_LANG: 'en' });
  check('26c 切 DK_LANG=en 重跑 → 舊 zh 債不復活（exit 0）', enAfter.code === 0, `code=${enAfter.code}`);
  writeFileSync(join(dir, 'bad.html'), BAD_MIN.replace('</body>', '<div style="color:#123456">x</div></body>'));
  const enNew = dk(dir, ['verify', '--json'], { DK_LANG: 'en' });
  let enNewData = null; try { enNewData = JSON.parse(enNew.out); } catch { /* */ }
  check('26c en 下新增違規照擋（exit 1 · 新 hardcoded-color · 英文訊息）',
    enNew.code === 1 && !!enNewData && enNewData.findings.some((f) => f.ruleId === 'slop/hardcoded-color' && /#123456/.test(f.evidence ?? '') && !hasCJK(f.message)), `code=${enNew.code}`);

  // 反向：en accept → zh 重跑不復活。
  const dir2 = ws('i18n-bl2', { 'design/tokens.json': GOOD_TOKENS, 'bad.html': BAD_MIN, 'dk.config.mjs': config({ targets: ['bad.html'] }) });
  dk(dir2, ['build']);
  const accEn = dk(dir2, ['baseline', '--accept'], { DK_LANG: 'en' });
  check('26c 反向 en baseline --accept 寫入', accEn.code === 0 && existsSync(join(dir2, '.dk', 'baseline.json')));
  const zhAfter = dk(dir2, ['verify'], { DK_LANG: 'zh-TW' });
  check('26c 反向：en 建立的 baseline 在 zh 下亦不復活（exit 0）', zhAfter.code === 0, `code=${zhAfter.code}`);
}
{
  // (d) 快取跨語言：zh 冷 → zh 熱（命中）→ 切 en（指紋含語言 → 整簇作廢、冷跑）→ en 熱；en 熱 findings 為英文。
  const dir = ws('i18n-cache', { 'design/tokens.json': GOOD_TOKENS, 'bad.html': BAD_MIN, 'dk.config.mjs': config({ targets: ['bad.html'] }) });
  dk(dir, ['build']);
  const zc = summaryLang(dir, 'zh-TW'); const zh = summaryLang(dir, 'zh-TW');
  check('26d zh 冷跑 cacheHits 0、熱跑 cacheHits=全集（快取命中）', zc?.cacheHits === 0 && zh?.cacheHits === zh?.filesScanned && zh?.filesScanned > 0, `cold=${zc?.cacheHits} hot=${zh?.cacheHits}/${zh?.filesScanned}`);
  const ec = summaryLang(dir, 'en');
  check('26d 切 DK_LANG=en → 快取整簇作廢（cacheHits 0，語言進全域指紋）', ec?.cacheHits === 0, `cacheHits=${ec?.cacheHits}`);
  const eh = summaryLang(dir, 'en');
  check('26d en 熱跑 cacheHits=全集（同語言快取命中）', eh?.cacheHits === eh?.filesScanned && eh?.filesScanned > 0, `hot=${eh?.cacheHits}/${eh?.filesScanned}`);
  const ehJson = enJson(dir);
  check('26d en 熱跑 findings 為英文（不吐 zh 舊語言快取）', !!ehJson && ehJson.findings.some((f) => /Hardcoded color/.test(f.message)) && ehJson.findings.every((f) => !hasCJK(f.message)),
    (ehJson?.findings ?? []).map((f) => f.message).find(hasCJK) ?? 'all-en');
}
{
  // (e) SARIF partialFingerprints 跨語言穩定（同一違規 zh/en 兩跑指紋逐位元組相同）。
  const dir = ws('i18n-sarif', { 'design/tokens.json': GOOD_TOKENS, 'bad.html': BAD_MIN, 'dk.config.mjs': config({ targets: ['bad.html'] }) });
  dk(dir, ['build']);
  dk(dir, ['verify', '--sarif', '--out', 'zh.sarif'], { DK_LANG: 'zh-TW' });
  dk(dir, ['verify', '--sarif', '--out', 'en.sarif'], { DK_LANG: 'en' });
  let zhF = null, enF = null, enMsg = '';
  try {
    const zs = JSON.parse(readFileSync(join(dir, 'zh.sarif'), 'utf8'));
    const es = JSON.parse(readFileSync(join(dir, 'en.sarif'), 'utf8'));
    zhF = zs.runs[0].results.map((r) => r.partialFingerprints['dkFingerprint/v1']).sort();
    enF = es.runs[0].results.map((r) => r.partialFingerprints['dkFingerprint/v1']).sort();
    enMsg = es.runs[0].results[0]?.message?.text ?? '';
  } catch { /* */ }
  check('26e SARIF dkFingerprint/v1 跨語言逐位元組相同（v1 語意不變）',
    !!zhF && zhF.length > 0 && JSON.stringify(zhF) === JSON.stringify(enF), `zh=${JSON.stringify(zhF)} en=${JSON.stringify(enF)}`);
  check('26e SARIF en 訊息本文為英文（"Hardcoded color"），指紋卻仍穩定', /Hardcoded color/.test(enMsg), enMsg.split('\n')[0] ?? '');
}

/* 核心正確性不變量：partial merge、prune 落盤、baseline count、severity 驗證、
   保護性 ignore、heavy 模式快取、compact report 與 EPIPE exit code。 */
group('核心正確性（partial merge／prune／count／severity／ignore／cache／compact／EPIPE）');
// per-gate 分組計數：某 gate 前綴的 findings 數（partial merge 域驗證用）。
const slopN = (findings) => (findings ?? []).filter((f) => f.ruleId.startsWith('slop/')).length;
const summaryJson = (cwd, extra = []) => { const r = dk(cwd, ['verify', '--summary', ...extra]); try { return JSON.parse(r.out); } catch { return null; } };
{
  // partial merge 只能取代本次實際執行 gate 的結果；未執行 gate 的 findings 與記錄必須保留。
  const badStyle = '<style>.a{ color:#123456; }\n.b{ background-color:#abcdef; }</style>\n';
  const dir = ws('fix1-partial', {
    'design/tokens.json': GOOD_TOKENS,
    'p1.html': badStyle, 'p2.html': badStyle, 'p3.html': badStyle,
    'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'], failOnSkipped: false }),
  });
  dk(dir, ['build']);
  dk(dir, ['verify']); // 全量 → 帳本含多筆 slop findings
  const full = readReport(dir);
  const fullSlop = slopN(full?.findings);
  check('27a 全量 verify 持久化多筆 slop findings（前置）', fullSlop >= 6 && full.gates.some((g) => g.id === 'slop' && g.status === 'ran'), `slop=${fullSlop}`);
  dk(dir, ['verify', '--gate', 'contract']); // partial：只跑 contract，slop 沒跑
  const part = readReport(dir);
  check('27a --gate contract 後：slop findings 完整保留', slopN(part?.findings) === fullSlop, `before=${fullSlop} after=${slopN(part?.findings)}`);
  check('27a --gate contract 後：slop gate 記錄仍在帳本', !!part && part.gates.some((g) => g.id === 'slop'), `gates=${(part?.gates ?? []).map((g) => g.id)}`);
  check('27a contract 部分如實更新（contract gate ran）', !!part && part.gates.some((g) => g.id === 'contract' && g.status === 'ran'), JSON.stringify((part?.gates ?? []).find((g) => g.id === 'contract')));
}
{
  // `baseline --accept --prune` 即使 accepted 清空也必須寫入空清單，讓後續同類違規重新被偵測。
  const dir = ws('fix2-prune', {
    'design/tokens.json': GOOD_TOKENS,
    'a.html': '<style>.a{ color:#123456; }</style>\n',
    'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'], failOnSkipped: false }),
  });
  dk(dir, ['build']);
  dk(dir, ['baseline', '--accept']); // 收下違規
  check('27b accept 後違規被消音（exit 0）', verifyJson(dir).code === 0);
  writeFileSync(join(dir, 'a.html'), '<h1>fixed</h1>\n'); // 修好
  const pr = dk(dir, ['baseline', '--accept', '--prune']); // 全綠 → 應落盤清空
  check('27b --prune 全綠時仍落盤（輸出說明清空、baseline 檔存在且 accepted 為空）',
    /清空|Cleared/.test(pr.out) && existsSync(join(dir, '.dk', 'baseline.json')) &&
    (JSON.parse(readFileSync(join(dir, '.dk', 'baseline.json'), 'utf8')).accepted ?? []).length === 0, pr.out.split('\n').find((l) => /清空|Cleared|無需/.test(l)) ?? '');
  writeFileSync(join(dir, 'a.html'), '<style>.a{ color:#123456; }</style>\n'); // 重新引入同一違規
  check('27b 重新引入同一違規 → verify exit 1', verifyJson(dir).code === 1, `code=${verifyJson(dir).code}`);
}
{
  // baseline 以 count 記帳；超過接受數量的同指紋 Finding 必須如實回報。
  // 無 count 的相容格式視為 Infinity，確保既有接受清單可讀。
  const dir = ws('fix3-count', {
    'design/tokens.json': GOOD_TOKENS,
    'a.html': '<style>\n.a{ color:#123456; }\n</style>\n',
    'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'], failOnSkipped: false }),
  });
  dk(dir, ['build']);
  dk(dir, ['baseline', '--accept']);
  const b = JSON.parse(readFileSync(join(dir, '.dk', 'baseline.json'), 'utf8'));
  check('27c accept 單筆 → 條目帶 count=1（精確記帳）', (b.accepted ?? []).length === 1 && b.accepted[0].count === 1, JSON.stringify(b.accepted?.map((e) => e.count)));
  check('27c accept 後 exit 0（單筆被消音）', verifyJson(dir).code === 0);
  // 同檔新增同一顆 hex（同 message、不同行）→ 第 2 筆超過 count=1，恰報 1 筆。
  writeFileSync(join(dir, 'a.html'), '<style>\n.a{ color:#123456; }\n.b{ color:#123456; }\n</style>\n');
  const v = verifyJson(dir);
  check('27c 同檔新增同訊息違規 → verify exit 1 且恰報 1 筆',
    v.code === 1 && countRule(v.data?.findings, 'slop/hardcoded-color') === 1, `code=${v.code} n=${countRule(v.data?.findings, 'slop/hardcoded-color')}`);
  // 相容格式 baseline（剝掉 count）讀入視為 Infinity，兩筆皆被抑制。
  const legacy = { version: 1, accepted: (b.accepted ?? []).map(({ count, ...rest }) => rest) };
  writeFileSync(join(dir, '.dk', 'baseline.json'), JSON.stringify(legacy, null, 2));
  check('27c 無 count 的相容 baseline → 2 筆皆抑制且 exit 0', verifyJson(dir).code === 0, `code=${verifyJson(dir).code}`);
}
{
  // severity 覆寫只接受 error／warn／info／off；非法值須 exit 2 並列出合法選項。
  const mk = (sev) => ws('fix4-sev-' + sev, { 'design/tokens.json': GOOD_TOKENS, 'x.html': '<h1>hi</h1>\n',
    'dk.config.mjs': config({ severity: { 'slop/hardcoded-color': sev } }) });
  const dirBad = mk('banana');
  dk(dirBad, ['build']);
  const bad = dk(dirBad, ['verify']);
  check('27d 非法 severity 值（banana）→ exit 2', bad.code === 2, `code=${bad.code}`);
  check('27d exit 2 訊息列出合法 severity 值', /error \/ warn \/ info \/ off|error \/ warn/.test(bad.err) && /banana/.test(bad.err), bad.err.trim().split('\n').find((l) => /banana|severity/.test(l)) ?? '');
  let allValid = true;
  for (const sev of ['error', 'warn', 'info', 'off']) {
    const d = mk(sev); dk(d, ['build']);
    const c = dk(d, ['verify']).code; if (c === 2) allValid = false;
  }
  check('27d 四個合法 severity 值均可執行', allValid, 'one of error/warn/info/off hit exit 2');
}
{
  // 保護性 ignore 必須永遠附加，避免 dk-report.html 落入掃描集合；使用者 ignore 仍須生效。
  const dir = ws('fix5-ignore', {
    'design/tokens.json': GOOD_TOKENS,
    'index.html': '<h1>hello</h1>\n',
    'vendor/lib.html': '<style>.x{ color:#123456; }</style>\n',
    'dk.config.mjs': config({ targets: ['**/*.html'], ignore: ['**/vendor/**'] }),
  });
  dk(dir, ['build']);
  const v = dk(dir, ['verify', '--html']); // 預設落點 dk-report.html
  check('27e 帶自訂 ignore 的工作區 verify --html → 非 exit 2', v.code !== 2 && existsSync(join(dir, 'dk-report.html')), `code=${v.code}`);
  const scanned = verifyJson(dir).data?.findings ?? [];
  check('27e 使用者 ignore 仍生效（vendor/ 未被掃）', !scanned.some((f) => (f.file ?? '').includes('vendor')), `files=${[...new Set(scanned.map((f) => f.file))]}`);
}
{
  // strict／heavy 模式下，核心 slop 掃描可用快取；heavy gates 永不快取且仍須完整執行。
  const dir = ws('fix6-cache-full', {
    'design/tokens.json': GOOD_TOKENS,
    'p1.html': '<h1>clean</h1>\n', 'p2.html': '<h1>clean</h1>\n', 'p3.html': '<h1>clean</h1>\n',
    'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'] }),
  });
  dk(dir, ['build']);
  const cold = summaryJson(dir, ['--full']);
  const hot = summaryJson(dir, ['--full']);
  check('27f strict＋--full 冷跑 cacheHits 0、熱跑 cacheHits>0',
    cold?.cacheHits === 0 && hot?.cacheHits > 0 && hot?.cacheHits === hot?.filesScanned, `cold=${cold?.cacheHits} hot=${hot?.cacheHits}/${hot?.filesScanned}`);
  const heavyIds = new Set((hot?.gates ?? []).map((g) => g.id));
  check('27f --full 下 heavy gates 狀態仍在帳本',
    heavyIds.has('css-strict') && heavyIds.has('a11y') && heavyIds.has('visual'), `gates=${[...heavyIds]}`);
  // golden：heavy gate 對「快取命中檔」仍真跑（re-read）——證明兩者並存、快取不吞 heavy 覆蓋。
  const golden = goldenDepsStatus();
  if (golden.ok) {
    const gdir = goldenWs('fix6-heavy-cache', {
      'design/tokens.json': GOOD_TOKENS,
      'page.html': '<style>\n.x { color: #ff0000; }\n</style>\n',
      '.stylelintrc.json': readFileSync(join(REPO, '.stylelintrc.json'), 'utf8'),
      'dk.config.mjs': config({ targets: ['*.html'], gates: { cssStrict: { enabled: true } } }),
    });
    dk(gdir, ['build']);
    const c = verifyJson(gdir, ['--full']); // 冷
    const h = verifyJson(gdir, ['--full']); // 熱（slop 命中快取）
    const cCss = countRule(c.data?.findings, 'css/strict-value');
    const hCss = countRule(h.data?.findings, 'css/strict-value');
    check('27f 熱跑 slop 命中快取，css-strict 仍掃描命中檔',
      cCss > 0 && hCss === cCss && (h.data?.cacheHits ?? 0) > 0, `coldCss=${cCss} hotCss=${hCss} hits=${h.data?.cacheHits}`);
  } else {
    check('27f heavy gate 快取覆蓋：skipped（缺 ' + golden.missing + '）', true);
  }
}
{
  // .dk/report.json 必須使用 compact JSON；dk report 仍須能解析與渲染。
  const dir = ws('fix7-compact', {
    'design/tokens.json': GOOD_TOKENS,
    'a.html': '<style>.a{ color:#123456; }\n.b{ background-color:#abcdef; }</style>\n',
    'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'] }),
  });
  dk(dir, ['build']);
  dk(dir, ['verify']);
  const raw = readFileSync(join(dir, '.dk', 'report.json'), 'utf8');
  // compact＝單行（末換行除外）、無 pretty 的兩空格縮排陣列/物件換行。
  const compact = !/\n {2,}"/.test(raw) && raw.trimEnd().split('\n').length === 1;
  check('27g report.json 為 compact JSON（無 pretty 縮排、單行）', compact, `lines=${raw.trimEnd().split('\n').length}`);
  const rep = dk(dir, ['report']);
  check('27g dk report 可渲染 compact 帳本', rep.code === 0 && /dk verify/.test(rep.out), `code=${rep.code}`);
  const repJson = dk(dir, ['report', '--json']);
  let parsed = null; try { parsed = JSON.parse(repJson.out); } catch { /* */ }
  check('27g dk report --json round-trip 可解析', !!parsed && Array.isArray(parsed.findings) && parsed.findings.length > 0, `findings=${parsed?.findings?.length}`);
}
{
  // EPIPE 發生時保留已計算的 exit code；用子行程提早關閉 stdout 模擬管線斷裂。
  const dir = ws('fix8-epipe', {
    'design/tokens.json': GOOD_TOKENS,
    'dk.config.mjs': config({ preset: 'strict', targets: ['*.html'] }),
  });
  // 製造大量違規 → terminal 輸出超過管線緩衝（>64KB），確保關 stdout 後仍有待寫入 → EPIPE。
  for (let i = 0; i < 200; i++) writeFileSync(join(dir, `f${i}.html`), '<style>.a{ color:#123456; }\n.b{ background-color:#abcdef; }</style>\n');
  dk(dir, ['build']);
  check('27h EPIPE 前置：正常 verify（有違規）exit 1', verifyJson(dir).code === 1);
  const probe = spawnSync(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const ch = spawn(process.execPath, [${JSON.stringify(DK)}, 'verify', '--all'], { cwd: ${JSON.stringify(dir)}, env: { ...process.env, NO_COLOR: '1', DK_LANG: 'zh-TW' } });
    let killed = false;
    ch.stdout.on('data', () => { if (!killed) { killed = true; ch.stdout.destroy(); } });
    ch.stdout.on('error', () => {});
    ch.on('close', (code) => { process.stdout.write(String(code)); });
  `], { encoding: 'utf8', timeout: 30000 });
  const epipeCode = parseInt((probe.stdout || '').trim(), 10);
  check('27h EPIPE（管線提早關 stdout）保留非零 exit code', epipeCode === 1, `code=${epipeCode}`);
}

/* 安全與結果完整性：tokens import 原型污染防護、a11y 單檔失敗、
   contract 對比 skip 與 slop evidence 邊界。 */
group('安全與結果完整性（原型污染／a11y 掃描失敗／contrast skip／evidence 邊界）');
{
  // 28a) 原型污染防護（Tokens Studio 匯入）。JSON.parse 把字面 "__proto__"/"constructor" 建成 own
  //      property，經動態 setDeep 寫入可污染 Object.prototype——匯入他人 token 檔即觸發。
  //      in-process 真證：污染不發生 ＋ 危險 key 可見拒絕列出（skipped type=(unsafe-key)）。
  const beforePoll = ({}).polluted;
  const evil = JSON.parse('{"core":{"__proto__":{"polluted":{"value":"#ff0000","type":"color"}},"constructor":{"hacked":{"value":"#00ff00","type":"color"}},"ok":{"value":"#0071e3","type":"color"}}}');
  const res28 = fromTokensStudio([{ name: 'core', data: evil.core }]);
  check('28a 匯入含 __proto__ 的惡意 set 後 ({}).polluted 仍 undefined（未污染 Object.prototype）', ({}).polluted === undefined && beforePoll === undefined, `polluted=${({}).polluted}`);
  check('28a constructor 路徑亦未污染（Object.prototype.hacked 為 undefined）', Object.prototype.hacked === undefined);
  const unsafeSkips = (res28.skipped ?? []).filter((s) => s.type === '(unsafe-key)');
  check('28a 危險 key 可見拒絕列出（skipped·(unsafe-key)·含 __proto__ 與 constructor）', unsafeSkips.length >= 2 && unsafeSkips.some((s) => /__proto__/.test(s.path)) && unsafeSkips.some((s) => /constructor/.test(s.path)), `skips=${JSON.stringify(unsafeSkips)}`);
  check('28a 合法 token 照常轉換、危險 key 未混進 tree（無 polluted/hacked 鍵）', res28.converted.some((p) => /(^|\.)ok$/.test(p)) && !JSON.stringify(res28.tree).includes('polluted') && !JSON.stringify(res28.tree).includes('hacked'), `converted=${JSON.stringify(res28.converted)}`);
  // CLI：dk tokens import 對惡意檔 → exit 0（不 crash）、輸出可見列出被拒 key、輸出檔無污染鍵。
  const evilTS = '{"core":{"__proto__":{"polluted":{"value":"#ff0000","type":"color"}},"good":{"value":"#0071e3","type":"color"}}}';
  const dir28a = ws('sec-import', { 'evil.json': evilTS });
  const imp28 = dk(dir28a, ['tokens', 'import', 'evil.json', '--out', 'design/tokens.imported.json']);
  const outFile28 = existsSync(join(dir28a, 'design', 'tokens.imported.json')) ? readFileSync(join(dir28a, 'design', 'tokens.imported.json'), 'utf8') : '';
  check('28a CLI dk tokens import 惡意檔 → exit 0（不 crash）', imp28.code === 0, `code=${imp28.code} ${imp28.err.trim().split('\n')[0]}`);
  check('28a CLI 輸出可見列出被拒危險 key（unsafe-key + __proto__）', /unsafe-key/.test(imp28.out) && /__proto__/.test(imp28.out), imp28.out.split('\n').filter((l) => /unsafe|proto/.test(l)).join(' | '));
  check('28a CLI 輸出檔含合法 good、不含 polluted 鍵（危險 key 未寫進 tree）', !!outFile28 && outFile28.includes('good') && !outFile28.includes('polluted'), `hasGood=${outFile28.includes('good')} hasPolluted=${outFile28.includes('polluted')}`);
}
{
  // a11y 單檔渲染失敗必須結構化回報 error，並由 gate 轉成可見 Finding。
  // (i) 純函式（heavy 的 a11yResultsToFindings，無需瀏覽器·永遠跑）：error 結果 → 可見 a11y/scan-failed。
  const errFindings = a11yResultsToFindings([{ file: '/repo/broken.html', error: 'page.goto: net::ERR_FILE_NOT_FOUND' }], '/repo', 2);
  check('28b(i) a11y 單檔 error 結果 → 恰 1 筆可見 Finding（非靜默消失）', errFindings.length === 1, `n=${errFindings.length}`);
  check('28b(i) 該 Finding ruleId=a11y/scan-failed 且明說「非通過」', errFindings[0]?.ruleId === 'a11y/scan-failed' && /非通過|not a pass/.test(errFindings[0]?.message ?? ''), errFindings[0]?.message?.slice(0, 44));
  check('28b(i) 正常渲染且無違規 → 0 Finding（不誤報·真通過仍是通過）', a11yResultsToFindings([{ file: '/repo/ok.html', violations: [] }], '/repo', 2).length === 0);
  // (ii) golden（需 chromium）：直接以不存在的 target 跑 a11y-runner → 該檔以 error 結構化回報，
  //      絕不從 results 消失；單檔失敗不使整程序崩（process 仍 exit 0，基礎設施問題才走非零）。
  const goldenB = goldenDepsStatus();
  if (!goldenB.ok) {
    check('28b(ii) a11y-runner goto 失敗 golden：skipped（缺 ' + goldenB.missing + '）—— (i) 純函式已證翻譯層', true);
  } else {
    const RUNNER = join(REPO, 'src', 'gates', 'a11y-runner.mjs');
    const bogus = join(tmpdir(), `dk-a11y-nonexistent-${Date.now()}.html`);
    const r = spawnSync(process.execPath, [RUNNER, bogus], { encoding: 'utf8', timeout: 60000 });
    let out = null; try { out = JSON.parse(r.stdout || '{}'); } catch { /* */ }
    const entry = (out?.results ?? []).find((x) => x.file === bogus);
    check('28b(ii) 不存在 target → runner 仍把該檔列入 results（不靜默丟棄）', !!entry, `results=${JSON.stringify(out?.results)}`);
    check('28b(ii) 該檔以 error 結構化回報、無 violations', !!entry && typeof entry.error === 'string' && entry.error.length > 0 && !('violations' in entry), JSON.stringify(entry));
    check('28b(ii) 單檔失敗不使整個 runner 崩（process exit 0；基礎設施問題才非零）', r.status === 0, `status=${r.status}`);
  }
}
{
  // 28c) contract 對比 pair 缺 token／非 hex 不再無聲蒸發——產可見 tokens/contrast-skipped（info）。
  // (i) config 宣告引用不存在 token 的 pair → 可見 skip（指出哪個 pair、缺什麼），且不進 verifiedPairs。
  const dirMiss = ws('sec-contract-miss', {
    'design/tokens.json': GOOD_TOKENS, 'index.html': '<h1>hi</h1>\n',
    'dk.config.mjs': config({ targets: ['index.html'], contrast: { pairs: [['color.text.primary', 'color.nope-missing', 4.5]] } }),
  });
  dk(dirMiss, ['build']);
  const vMiss = verifyJson(dirMiss);
  const missF = (vMiss.data?.findings ?? []).filter((f) => f.ruleId === 'tokens/contrast-skipped');
  check('28c(i) 引用不存在 token 的 pair → 可見 tokens/contrast-skipped（不靜默蒸發）', missF.length >= 1, `n=${missF.length}`);
  check('28c(i) skip finding 指出是哪個 pair 與缺什麼（color.nope-missing）', missF.some((f) => /color\.nope-missing/.test(f.message)), missF.map((f) => f.message.slice(0, 48)).join(' | '));
  check('28c(i) skip 為 info（可見但不擋關）＋ 缺 token 的 pair 不進 verifiedPairs', missF.every((f) => f.severity === 'info') && !((readReport(dirMiss)?.emits?.verifiedPairs) ?? []).some((p) => p.bg === 'color.nope-missing'), `sev=${[...new Set(missF.map((f) => f.severity))]}`);
  // (ii) config pair 引用「值非 hex（rgba）」的 token → 同樣可見 skip（值非 hex），不靜默。
  const dirNon = ws('sec-contract-nonhex', {
    'design/tokens.json': GOOD_TOKENS, 'index.html': '<h1>hi</h1>\n',
    'dk.config.mjs': config({ targets: ['index.html'], contrast: { pairs: [['color.text.primary', 'color.border.subtle', 4.5]] } }),
  });
  dk(dirNon, ['build']);
  const nonF = (verifyJson(dirNon).data?.findings ?? []).filter((f) => f.ruleId === 'tokens/contrast-skipped' && /border\.subtle/.test(f.message) && /非 hex|not hex/.test(f.message));
  check('28c(ii) config pair 引用非 hex（rgba）token → 可見 tokens/contrast-skipped（值非 hex，不靜默）', nonF.length >= 1, `n=${nonF.length}`);
  // 內建 pair 全齊備且為 hex 時應為零 skip。
  const dirClean = ws('sec-contract-clean', { 'design/tokens.json': GOOD_TOKENS, 'index.html': '<h1>hi</h1>\n', 'dk.config.mjs': config({ targets: ['index.html'] }) });
  dk(dirClean, ['build']);
  check('28c(iii) 內建 pair 全齊備且 hex → 零 tokens/contrast-skipped（不誤報）', countRule(verifyJson(dirClean).data?.findings, 'tokens/contrast-skipped') === 0, `n=${countRule(verifyJson(dirClean).data?.findings, 'tokens/contrast-skipped')}`);
}
{
  // slop evidence 與 RE_LEN 掃描必須在 style zone 邊界截斷，不得包含 zone 外 HTML。
  const dir28d = ws('sec-evidence', {
    'design/tokens.json': GOOD_TOKENS,
    // 無分號的 off-scale padding，後接屬性收尾引號與 zone 外 HTML 文字。
    'leak.html': '<div style="padding:13px">ZONE-OUTSIDE-LEAK text</div>\n',
    'dk.config.mjs': config({ targets: ['leak.html'], enforce: { spacing: 'warn' } }),
  });
  dk(dir28d, ['build']);
  const sp = (slopJson(dir28d, ['leak.html']).data?.findings ?? []).filter((f) => f.ruleId === 'slop/hardcoded-spacing');
  check('28d off-scale padding 仍被抓（前置：規則有啟動、非因截斷而漏報）', sp.length >= 1, `n=${sp.length}`);
  check('28d evidence 不含 zone 外 HTML 內容（不再衝出屬性引號 ">…）', sp.every((f) => !/ZONE-OUTSIDE-LEAK|>/.test(f.evidence ?? '')), `ev=${JSON.stringify(sp.map((f) => f.evidence))}`);
  check('28d evidence 收斂為 zone 內真值（padding: 13px、無殘留收尾引號）', sp.some((f) => (f.evidence ?? '').trim() === 'padding: 13px'), `ev=${JSON.stringify(sp.map((f) => f.evidence))}`);
}
/* 29) token correctness P0：alias 必須可解、CSS-var 壓平不得碰撞、
   source var() 必須真的存在於 manifest。三項都走真 CLI，證明不只「會報」還會擋。 */
group('token correctness P0（alias 解析／CSS-var 碰撞／unknown var 參照）');
{
  const tokens = JSON.parse(GOOD_TOKENS);
  tokens.probe = {
    missing: { $value: '{probe.does-not-exist}' },
    'dark-only': { $value: '#123456', $extensions: { modes: { dark: '{probe.dark-does-not-exist}' } } },
    'cycle-a': { $value: '{probe.cycle-b}' },
    'cycle-b': { $value: '{probe.cycle-a}' },
  };
  const dir = ws('token-alias-p0', {
    'design/tokens.json': JSON.stringify(tokens, null, 2),
    'index.html': '<h1>alias probe</h1>\n',
    'dk.config.mjs': config({ targets: ['index.html'] }),
  });
  dk(dir, ['build']);
  const v = verifyJson(dir);
  const unresolved = (v.data?.findings ?? []).filter((f) => f.ruleId === 'tokens/unresolved-alias');
  const cycles = (v.data?.findings ?? []).filter((f) => f.ruleId === 'tokens/alias-cycle');
  check('29a unresolved alias 與 cycle 都是 error，verify exit 1（不再 null 後靜默放行）',
    v.code === 1 && unresolved.length >= 3 && cycles.length >= 4
      && [...unresolved, ...cycles].every((f) => f.severity === 'error'),
    `code=${v.code} unresolved=${unresolved.length} cycles=${cycles.length}`);
  const missModes = new Set(unresolved.filter((f) => f.meta?.token === 'probe.missing').map((f) => f.meta?.mode));
  check('29a 同一 unresolved alias 實際驗過 light + dark 兩條 chain',
    missModes.has('light') && missModes.has('dark'), `modes=${[...missModes]}`);
  check('29a dark-only 斷鏈只標準確指出 dark（light 具體值不誤報）',
    unresolved.filter((f) => f.meta?.token === 'probe.dark-only').length === 1
      && unresolved.some((f) => f.meta?.token === 'probe.dark-only' && f.meta?.mode === 'dark'),
    JSON.stringify(unresolved.filter((f) => f.meta?.token === 'probe.dark-only').map((f) => f.meta)));
  check('29a cycle Finding 保留完整鏈證據（a → b → a）',
    cycles.some((f) => /probe\.cycle-a.*probe\.cycle-b.*probe\.cycle-a/.test(f.evidence ?? '')),
    cycles[0]?.evidence ?? '(none)');
}
{
  const tokens = JSON.parse(GOOD_TOKENS);
  // 兩條合法 dot-path 都會壓成 --foo-bar-baz。
  tokens.foo = { 'bar-baz': { $value: '1px' } };
  tokens['foo-bar'] = { baz: { $value: '2px' } };
  const dir = ws('token-collision-p0', {
    'design/tokens.json': JSON.stringify(tokens, null, 2),
    'index.html': '<h1>collision probe</h1>\n',
    'dk.config.mjs': config({ targets: ['index.html'] }),
  });
  const b = dk(dir, ['build']);
  const css = readFileSync(join(dir, 'styles', 'tokens.css'), 'utf8');
  const v = verifyJson(dir);
  const collisions = (v.data?.findings ?? []).filter((f) => f.ruleId === 'tokens/css-var-collision');
  check('29b dot-path 壓平碰撞產生單一 blocking Finding（verify exit 1）',
    b.code === 0 && v.code === 1 && collisions.length === 1 && collisions[0].severity === 'error',
    `build=${b.code} verify=${v.code} n=${collisions.length}`);
  check('29b Finding 明列兩條來源路徑與目標 CSS variable',
    collisions[0]?.meta?.cssVar === '--foo-bar-baz'
      && collisions[0]?.meta?.paths?.includes('foo.bar-baz')
      && collisions[0]?.meta?.paths?.includes('foo-bar.baz'),
    JSON.stringify(collisions[0]?.meta));
  check('29b 碰撞組不產出歧義 CSS（非 last-write-wins，宣告數為 0）',
    !/^\s*--foo-bar-baz\s*:/m.test(css),
    css.split('\n').filter((l) => /--foo-bar-baz/.test(l)).join(' | '));
}
{
  const html = `<style>
.a { color: var(--color-does-not-exist); }
.b { background: var(--space-missing-with-fallback, var(--color-surface-page)); }
.c { border-color: var(--color-border-default); }
.d { transform-origin: var(--radix-popover-transform-origin); gap: var(--component-gap); }
</style>
<p>documentation example var(--docs-only) is not a style reference</p>
`;
  const dir = ws('token-reference-p0', {
    'design/tokens.json': GOOD_TOKENS,
    'index.html': html,
    'dk.config.mjs': config({ targets: ['index.html'] }),
  });
  dk(dir, ['build']);
  const v = verifyJson(dir);
  const unknown = (v.data?.findings ?? []).filter((f) => f.ruleId === 'tokens/unknown-reference');
  check('29c manifest 不存在的 var() 逐筆擋下，已知 token 不誤報',
    v.code === 1 && unknown.length === 2
      && unknown.some((f) => f.meta?.token === '--color-does-not-exist')
      && unknown.some((f) => f.meta?.token === '--space-missing-with-fallback')
      && !unknown.some((f) => f.meta?.token === '--color-surface-page' || f.meta?.token === '--color-border-default'),
    `code=${v.code} refs=${JSON.stringify(unknown.map((f) => f.meta))}`);
  check('29c fallback 會被解析並標註，但不會把不存在的 token 洗成通過',
    unknown.some((f) => f.meta?.token === '--space-missing-with-fallback' && f.meta?.hasFallback === true)
      && unknown.some((f) => f.meta?.token === '--color-does-not-exist' && f.meta?.hasFallback === false),
    JSON.stringify(unknown.map((f) => f.meta)));
  check('29c unknown-reference 有精確 file:line:col，可見文字中的 docs 範例不誤報',
    unknown.every((f) => f.file === 'index.html' && Number.isInteger(f.line) && Number.isInteger(f.col))
      && !unknown.some((f) => ['--docs-only', '--radix-popover-transform-origin', '--component-gap'].includes(f.meta?.token)),
    JSON.stringify(unknown.map((f) => ({ file: f.file, line: f.line, col: f.col }))));
}

/* 30) AI UI Director：draft → contract → prompt → Taste Lock → drift block。 */
group('AI UI Director（方向契約／prompt compiler／Taste Lock）');
{
  const parent = mkdtempSync(join(tmpdir(), 'dk-direction-'));
  const created = dk(parent, ['new', 'app']);
  const dir = join(parent, 'app');
  const directionPath = join(dir, 'design', 'direction.json');
  const lockPath = join(dir, 'design', 'direction.lock.json');
  const approvalPath = join(dir, 'design', 'approval-history.json');
  const init = dk(dir, ['design', 'init']);
  const initAgain = dk(dir, ['design', 'init']);
  check('30a dk design init 建立 draft，且絕不覆寫既有方向',
    created.code === 0 && init.code === 0 && existsSync(directionPath)
      && initAgain.code === 2 && /拒絕覆寫/.test(initAgain.err),
    `new=${created.code} init=${init.code} again=${initAgain.code} err=${initAgain.err}`);

  const draftVerify = verifyJson(dir);
  const draftFindings = (draftVerify.data?.findings ?? []).filter((f) => f.ruleId.startsWith('direction/'));
  check('30b 未完成 draft 在全局 verify 只顯示一個警告，不用數十個 placeholder 阻塞新手',
    draftVerify.code === 0 && draftFindings.length === 1
      && draftFindings[0].ruleId === 'direction/draft' && draftFindings[0].severity === 'warn',
    `code=${draftVerify.code} findings=${JSON.stringify(draftFindings.map((f) => [f.ruleId, f.severity]))}`);
  const draftCheck = dk(dir, ['design', 'check', '--json']);
  let draftData = null;
  try { draftData = JSON.parse(draftCheck.out); } catch { /* asserted below */ }
  check('30b 專用 check 給出完整教學式待辦',
    draftCheck.code === 1 && draftData?.status === 'failed' && draftData.issues.length >= 10
      && draftData.issues.some((issue) => issue.path === 'identity.thesis')
      && draftData.issues.some((issue) => issue.path === 'context.task'),
    `code=${draftCheck.code} status=${draftData?.status} issues=${draftData?.issues?.length}`);
  const cfgPath = join(dir, 'dk.config.mjs');
  const cfgSource = readFileSync(cfgPath, 'utf8');
  writeFileSync(cfgPath, cfgSource.replace('required: false', 'required: true'));
  const requiredDraft = verifyJson(dir);
  check('30b direction.required=true 時 draft 成為 blocking（CI 可要求 approved + locked）',
    requiredDraft.code === 1 && requiredDraft.rules.has('direction/draft'),
    `code=${requiredDraft.code} rules=${[...requiredDraft.rules]}`);
  writeFileSync(cfgPath, cfgSource);

  const approved = goodDirection();
  writeFileSync(directionPath, JSON.stringify(approved, null, 2) + '\n');
  const checked = dk(dir, ['design', 'check', '--json']);
  let checkedData = null;
  try { checkedData = JSON.parse(checked.out); } catch { /* asserted below */ }
  check('30c 完整方向契約 + token bindings 通過，未鎖定時誠實標 incomplete',
    checked.code === 0 && checkedData?.status === 'incomplete'
      && checkedData?.lockStatus === 'missing' && checkedData?.issues?.length === 0,
    `code=${checked.code} data=${JSON.stringify(checkedData)}`);
  const prompt = dk(dir, ['design', 'prompt']);
  check('30d prompt compiler 把選定方向編譯成有邊界的 AI 建構指令',
    prompt.code === 0 && /Quiet Signal/.test(prompt.out)
      && /confidence rail/i.test(prompt.out) && /color\.brand\.accent/.test(prompt.out)
      && /Primary action/.test(prompt.out) && prompt.out.length < 4000
      && !/Control Room|Release Narrative|Axes \(0–100\)/.test(prompt.out),
    `code=${prompt.code} out=${prompt.out.slice(0, 240)}`);

  const preview = dk(dir, ['design', 'lock']);
  const previewWroteLock = existsSync(lockPath);
  const accepted = dk(dir, ['design', 'lock', '--accept']);
  const locked = verifyJson(dir);
  check('30e Taste Lock 必須顯式 --accept；preview 不偷寫檔',
    preview.code === 0 && !previewWroteLock && accepted.code === 0 && existsSync(lockPath)
      && JSON.parse(readFileSync(lockPath, 'utf8')).schema === 'dk-direction-lock/v2',
    `preview=${preview.code} previewWrote=${previewWroteLock} accept=${accepted.code} exists=${existsSync(lockPath)}`);
  const approvalHistory = JSON.parse(readFileSync(approvalPath, 'utf8'));
  const historyCli = dk(dir, ['design', 'history', '--json']);
  let historySurface = null;
  try { historySurface = JSON.parse(historyCli.out); } catch { /* asserted below */ }
  check('30e 明確接受會追加可版本化的 hash-chain 核准歷史',
    approvalHistory.schema === 'dk-approval-history/v1'
      && approvalHistory.entries.length === 1
      && /^apr_[a-f0-9]{16}$/.test(approvalHistory.entries[0].id)
      && /^[a-f0-9]{64}$/.test(approvalHistory.entries[0].entryHash),
    JSON.stringify(approvalHistory));
  check('30e dk design history 提供設計師／CI 可讀的核准時間線',
    historyCli.code === 0 && historySurface?.status === 'verified'
      && historySurface?.count === 1 && historySurface?.headHash === approvalHistory.entries[0].entryHash,
    `code=${historyCli.code} data=${JSON.stringify(historySurface)}`);
  check('30e 鎖定後 verify 通過，帳本同時攜帶 directionHash 與 locked 證據',
    locked.code === 0 && typeof locked.data?.direction?.hash === 'string'
      && locked.data.direction.hash.length === 16 && locked.data?.direction?.locked === true
      && locked.data?.direction?.approvalStatus === 'verified'
      && locked.data?.direction?.approvalCount === 1,
    `code=${locked.code} direction=${JSON.stringify(locked.data?.direction)}`);
  const tamperedHistory = JSON.parse(JSON.stringify(approvalHistory));
  tamperedHistory.entries[0].reason = 'silently rewritten';
  writeFileSync(approvalPath, JSON.stringify(tamperedHistory, null, 2) + '\n');
  const tamperedApproval = verifyJson(dir, ['--gate', 'direction']);
  check('30e 核准歷史遭改寫即 fail closed（不把竄改後的 lock 當通過）',
    tamperedApproval.code === 1 && tamperedApproval.rules.has('direction/approval-history'),
    `code=${tamperedApproval.code} rules=${[...tamperedApproval.rules]}`);
  writeFileSync(approvalPath, JSON.stringify(approvalHistory, null, 2) + '\n');
  rmSync(approvalPath);
  const deletedApproval = verifyJson(dir, ['--gate', 'direction']);
  check('30e 新式 Taste Lock 承諾 history head；整份核准歷史遭刪除也會 fail closed',
    deletedApproval.code === 1 && deletedApproval.rules.has('direction/approval-history'),
    `code=${deletedApproval.code} rules=${[...deletedApproval.rules]}`);
  writeFileSync(approvalPath, JSON.stringify(approvalHistory, null, 2) + '\n');
  dk(dir, ['slop', 'index.html', '--json']);
  const afterPartial = dk(dir, ['report', '--json']);
  let afterPartialData = null;
  try { afterPartialData = JSON.parse(afterPartial.out); } catch { /* asserted below */ }
  check('30e 單檔 slop partial run 保留帳本中的 Taste Lock 證據',
    afterPartial.code === 0 && afterPartialData?.direction?.status === 'approved'
      && afterPartialData?.direction?.locked === true
      && afterPartialData?.direction?.hash === locked.data?.direction?.hash,
    `code=${afterPartial.code} direction=${JSON.stringify(afterPartialData?.direction)}`);

  const tokenPath = join(dir, 'design', 'tokens.json');
  const tokenSource = readFileSync(tokenPath, 'utf8');
  const boundTokens = JSON.parse(tokenSource);
  boundTokens.space['4'].$value = '17px';
  writeFileSync(tokenPath, JSON.stringify(boundTokens, null, 2) + '\n');
  const boundTokenDrift = verifyJson(dir, ['--gate', 'direction']);
  check('30f 不改 contract、只偷改已綁定 token 的解析值，Taste Lock 仍會擋下',
    boundTokenDrift.code === 1 && boundTokenDrift.rules.has('direction/drift')
      && boundTokenDrift.data?.findings?.some((f) => f.meta?.bindingsChanged === true),
    `code=${boundTokenDrift.code} findings=${JSON.stringify(boundTokenDrift.data?.findings)}`);
  const unrelatedTokens = JSON.parse(tokenSource);
  unrelatedTokens.probe = { unrelated: { $value: '13px' } };
  writeFileSync(tokenPath, JSON.stringify(unrelatedTokens, null, 2) + '\n');
  const unrelatedToken = verifyJson(dir, ['--gate', 'direction']);
  check('30f 新增與方向無關的 token 不會誤觸 Taste Lock（鎖的是角色解析值，非全檔 hash）',
    unrelatedToken.code === 0 && !unrelatedToken.rules.has('direction/drift'),
    `code=${unrelatedToken.code} rules=${[...unrelatedToken.rules]}`);
  writeFileSync(tokenPath, tokenSource);

  const contextGrowth = JSON.parse(JSON.stringify(approved));
  contextGrowth.context.product = 'A release workspace that now covers scheduled launches and emergency patches.';
  contextGrowth.context.constraints.push('Show the accountable owner beside every blocking item');
  writeFileSync(directionPath, JSON.stringify(contextGrowth, null, 2) + '\n');
  const contextOnly = verifyJson(dir, ['--gate', 'direction']);
  check('30f 產品內容與 constraints 成長不會誤判成視覺身份 drift',
    contextOnly.code === 0 && !contextOnly.rules.has('direction/drift'),
    `code=${contextOnly.code} rules=${[...contextOnly.rules]}`);

  const normalizedIdentity = JSON.parse(JSON.stringify(approved));
  normalizedIdentity.identity.thesis = `  ${normalizedIdentity.identity.thesis.replace(/ /g, '  ')}  `;
  normalizedIdentity.identity.avoid.reverse();
  writeFileSync(directionPath, JSON.stringify(normalizedIdentity, null, 2) + '\n');
  const normalizedOnly = verifyJson(dir, ['--gate', 'direction']);
  check('30f whitespace 與 set-like anti-goal 排序不會製造假 drift',
    normalizedOnly.code === 0 && !normalizedOnly.rules.has('direction/drift'),
    `code=${normalizedOnly.code} rules=${[...normalizedOnly.rules]}`);
  writeFileSync(directionPath, JSON.stringify(approved, null, 2) + '\n');

  approved.identity.signature = 'A changed signature silently replaces the approved identity with a different visual rule.';
  writeFileSync(directionPath, JSON.stringify(approved, null, 2) + '\n');
  const drift = verifyJson(dir);
  check('30f 功能修改不能偷改產品身份：direction drift 立即 exit 1',
    drift.code === 1 && drift.rules.has('direction/drift'),
    `code=${drift.code} rules=${[...drift.rules]}`);
  const driftPrompt = dk(dir, ['design', 'prompt']);
  check('30f prompt compiler 也不會把已飄移方向編譯成新的 AI 指令',
    driftPrompt.code === 1 && /Taste Lock/.test(driftPrompt.err),
    `code=${driftPrompt.code} err=${driftPrompt.err}`);

  approved.bindings.accent = 'color.brand.does-not-exist';
  writeFileSync(directionPath, JSON.stringify(approved, null, 2) + '\n');
  const missingBinding = verifyJson(dir);
  check('30g 方向不是空泛 prose：不存在的 token binding 會被 deterministic gate 擋下',
    missingBinding.code === 1 && missingBinding.rules.has('direction/token-binding'),
    `code=${missingBinding.code} rules=${[...missingBinding.rules]}`);

  approved.bindings.accent = 'color.brand.accent';
  approved.identity.axes = { energy: 50 };
  writeFileSync(directionPath, JSON.stringify(approved, null, 2) + '\n');
  const unknownField = verifyJson(dir, ['--gate', 'direction']);
  check('30g v2 拒絕未知欄位，工作階段資料不會偷偷進 lock',
    unknownField.code === 1 && unknownField.rules.has('direction/contract'),
    `code=${unknownField.code} rules=${[...unknownField.rules]}`);
  delete approved.identity.axes;

  approved.bindings = {};
  writeFileSync(directionPath, JSON.stringify(approved, null, 2) + '\n');
  const hollowLock = verifyJson(dir, ['--gate', 'direction']);
  check('30g Taste Lock 不允許空殼 bindings：至少四個 semantic roles 才能鎖到實作決策',
    hollowLock.code === 1 && hollowLock.rules.has('direction/contract'),
    `code=${hollowLock.code} rules=${[...hollowLock.rules]}`);
}

/* 31) 安全寫入邊界：不跟隨 final/parent symlink，不寫出 cwd。 */
group('安全寫入邊界（symlink／cwd containment／合法寫入）');
{
  // final-target symlink：一般 verify 會持久化 .dk/report.json，但絕不能跟隨
  // 惡意 repo 中被強制追蹤的 symlink 去覆寫專案外檔案。
  const dir = ws('safe-final-link', {
    'design/tokens.json': GOOD_TOKENS,
    'index.html': '<h1>safe write probe</h1>\n',
    'dk.config.mjs': config({ targets: ['index.html'] }),
  });
  const built = dk(dir, ['build']);
  const outside = mkdtempSync(join(tmpdir(), 'dk-safe-final-out-'));
  const victim = join(outside, 'victim.txt');
  writeFileSync(victim, 'DO-NOT-TOUCH\n');
  mkdirSync(join(dir, '.dk'), { recursive: true });
  let linked = false;
  try { symlinkSync(victim, join(dir, '.dk', 'report.json')); linked = true; } catch { /* platform cannot create symlink */ }
  if (!linked) {
    check('31a final symlink 防護：skipped（平台不允許建立 symlink）', true);
  } else {
    const run = dk(dir, ['verify', '--no-cache']);
    check('31a verify 拒絕 .dk/report.json final symlink（exit 2）',
      built.code === 0 && run.code === 2 && /UnsafeWriteError|unsafe write|symbolic link/.test(run.err),
      `build=${built.code} verify=${run.code} err=${run.err.split('\n')[0]}`);
    check('31a final symlink 外部目標位元組不變',
      readFileSync(victim, 'utf8') === 'DO-NOT-TOUCH\n',
      readFileSync(victim, 'utf8'));
  }
}
{
  // parent symlink：build 不得經 styles/ symlink 把 tokens.css 寫到 repo 外。
  const dir = ws('safe-parent-link', {
    'design/tokens.json': GOOD_TOKENS,
    'index.html': '<h1>safe parent probe</h1>\n',
    'dk.config.mjs': config({ targets: ['index.html'] }),
  });
  const outside = mkdtempSync(join(tmpdir(), 'dk-safe-parent-out-'));
  let linked = false;
  try { symlinkSync(outside, join(dir, 'styles'), 'dir'); linked = true; } catch { /* platform cannot create symlink */ }
  if (!linked) {
    check('31b parent symlink 防護：skipped（平台不允許建立 symlink）', true);
  } else {
    const run = dk(dir, ['build']);
    check('31b build 拒絕 styles/ parent symlink（exit 2）',
      run.code === 2 && /UnsafeWriteError|unsafe write|symbolic link/.test(run.err),
      `code=${run.code} err=${run.err.split('\n')[0]}`);
    check('31b parent symlink 外部目錄沒有產生 tokens.css', !existsSync(join(outside, 'tokens.css')));
  }
}
{
  // 純路徑 escape：即使是 config 明文指定，預設也不能寫出 cwd。
  const outside = mkdtempSync(join(tmpdir(), 'dk-safe-outside-'));
  const victim = join(outside, 'tokens.css');
  writeFileSync(victim, 'UNCHANGED\n');
  const dir = ws('safe-outside-config', {
    'design/tokens.json': GOOD_TOKENS,
    'index.html': '<h1>containment probe</h1>\n',
    'dk.config.mjs': config({
      targets: ['index.html'],
      tokens: { source: 'design/tokens.json', output: { css: victim } },
    }),
  });
  const run = dk(dir, ['build']);
  check('31c build 拒絕 cwd 外的 config.tokens.output（exit 2）',
    run.code === 2 && /UnsafeWriteError|unsafe write|project root/.test(run.err),
    `code=${run.code} err=${run.err.split('\n')[0]}`);
  check('31c cwd 外既有檔案位元組不變', readFileSync(victim, 'utf8') === 'UNCHANGED\n');
}
{
  // 正常專案內的建置、ledger、cache 與 HTML report 仍全部可寫。
  const dir = ws('safe-legal-write', {
    'design/tokens.json': GOOD_TOKENS,
    'index.html': '<h1>ordinary project</h1>\n',
    'dk.config.mjs': config({ targets: ['index.html'] }),
  });
  const build = dk(dir, ['build']);
  const verify = dk(dir, ['verify']);
  const html = dk(dir, ['verify', '--html']);
  check('31d 合法 cwd 內寫入不回歸（build／cache／ledger／HTML）',
    build.code === 0 && verify.code === 0 && html.code === 0
      && existsSync(join(dir, 'styles', 'tokens.css'))
      && existsSync(join(dir, '.dk', 'cache.json'))
      && existsSync(join(dir, '.dk', 'report.json'))
      && existsSync(join(dir, 'dk-report.html')),
    `build=${build.code} verify=${verify.code} html=${html.code}`);
}

/* ---- 總結 ---- */
const failed = checks.filter((c) => !c.ok);
process.stdout.write(`\n${'─'.repeat(48)}\n`);
if (!failed.length) {
  process.stdout.write(`\x1b[32m全數通過\x1b[0m — ${checks.length} 項斷言，0 失敗。\n`);
  process.stdout.write('回歸驗證完成。\n');
  process.exit(0);
} else {
  process.stdout.write(`\x1b[31m${failed.length} 項失敗\x1b[0m / 共 ${checks.length} 項：\n`);
  for (const f of failed) process.stdout.write(`  ✗ ${f.name}\n      ${f.detail}\n`);
  process.exit(1);
}
