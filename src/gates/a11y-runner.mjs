/* ============================================================
   a11y-runner —— 由 heavy.mjs 的 a11yGate 以子行程呼叫。
   用 playwright(chromium) + axe-core 掃描傳入的 .html 檔（file:// 渲染），
   把每檔的 WCAG A/AA 違規以 JSON 印到 stdout：
     { results: [ { file, violations:[axe violation…] } ], usedTokens:[] }
   基礎設施問題（缺 chromium / 匯入失敗）→ 非零 exit + stderr，
   由上游 a11yGate 標示為 infrastructure skip。
   之所以獨立成子行程：核心 runner 是同步的，playwright 是非同步的；
   spawnSync 阻塞等它跑完，核心 ledger 不必變 async。
   ============================================================ */
import { pathToFileURL } from 'node:url';
import { normalizeA11yTags, validateA11yTags } from '../core/a11y-tags.mjs';

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) { process.stdout.write(JSON.stringify({ results: [], usedTokens: [] })); return; }

  let chromium, AxeBuilder;
  try {
    ({ chromium } = await import('@playwright/test'));
    ({ default: AxeBuilder } = await import('@axe-core/playwright'));
  } catch (err) {
    process.stderr.write(`a11y deps 匯入失敗：${err.message}\n`);
    process.exit(3);
  }

  const serializedTags = process.env.DK_A11Y_TAGS;
  const inputTags = (serializedTags === undefined ? 'wcag2a,wcag2aa,wcag21a,wcag21aa' : serializedTags)
    .split(',').map((tag) => tag.trim()).filter(Boolean);
  const tagIssues = validateA11yTags(inputTags, 'DK_A11Y_TAGS');
  if (tagIssues.length) {
    process.stderr.write(`a11y tags 設定無效：${tagIssues.map((issue) => issue.message).join('; ')}\n`);
    process.exit(2);
  }
  const tags = normalizeA11yTags(inputTags, 'DK_A11Y_TAGS');

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    process.stderr.write(`chromium 啟動失敗（可能未安裝）：${err.message}\n`);
    process.exit(4);
  }

  const results = [];
  try {
    const context = await browser.newContext();
    for (const file of files) {
      const page = await context.newPage();
      try {
        await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
        let axe = new AxeBuilder({ page });
        if (tags.length) axe = axe.withTags(tags);
        const { violations } = await axe.analyze();
        results.push({
          file,
          violations: violations.map((v) => ({
            id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
            nodes: (v.nodes ?? []).slice(0, 5).map((n) => ({ target: n.target, html: n.html })),
          })),
        });
      } catch (err) {
        // 單檔掃描失敗以 error+reason 寫入結果，由上游轉成 error Finding；
        // 程序層級的基礎設施問題仍使用非零 exit。
        process.stderr.write(`掃描 ${file} 失敗：${err.message}\n`);
        results.push({ file, error: String(err.message ?? err).split('\n')[0] });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  process.stdout.write(JSON.stringify({ results, usedTokens: [] }));
}

main().catch((err) => { process.stderr.write(`a11y-runner 未預期錯誤：${err.stack ?? err}\n`); process.exit(5); });
