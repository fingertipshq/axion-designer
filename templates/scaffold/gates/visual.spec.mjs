import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readVisualMatrix, visualCases } from './visual-matrix.mjs';

// ── 視覺回歸關卡的規格檔（dk new 已幫你附上，裝了 playwright 就能直接跑）──────────
//
// 這份檔對你的頁面截圖，和「baseline 快照」逐像素比對。dk 的 visual 關卡會呼叫它；
// tokenHash 只作稽核脈絡，不作因果豁免，因此任何超出容差的 pixel diff 都會擋關。
//
// 第一次使用（建立 baseline）：
//   1. 裝依賴：   npm i -D @playwright/test @axe-core/playwright
//   2. 裝瀏覽器： npx playwright install chromium
//   3. 建 baseline： DK_UPDATE_VISUAL=1 dk verify --gate visual
//      （會在 gates/visual.spec.mjs-snapshots/ 寫下截圖，並把當下 tokenHash 記進 .dk/visual-baseline.json）
//   4. 之後照常跑：  dk verify --gate visual      或   dk verify --full
//
// 之後畫面若跑掉：不論 tokenHash 是否改變都維持 error。DK_UPDATE_VISUAL=1 會拒絕更新
// 已有差異的 baseline（fail-closed）；人工確認新畫面正確後，才用 DK_UPDATE_VISUAL=force 接受。
// 完整流程見 docs/visual-regression.md。
//
// 範本預設忽略 *-snapshots/，避免不同 OS 的字型/抗鋸齒互相污染。若要跨 PR 真正回歸比對，
// 請在固定 OS/瀏覽器下把權威 baseline 存進受控 artifact/cache（或刻意納入版控）。

// 截圖目標：scaffold 的首頁。用 pathToFileURL + resolve 轉成 file:// URL（相對 dk 執行時的 cwd）。
const target = pathToFileURL(resolve('index.html')).href;

// dk visual gate 會把 dk.config.mjs 的 gates.visual.viewports/themes 以 JSON
// 傳進來；直接跑 `npx playwright test` 時仍使用相同文件化預設。
const matrix = readVisualMatrix();

for (const visualCase of visualCases(matrix)) {
  const { width, height, theme, colorScheme: scheme, snapshotKey } = visualCase;
  test(`index.html：${width}px · ${theme}`, async ({ page }) => {
    // config 只宣告覆蓋寬度；高度使用 deterministic device-like 值。
    // fullPage 會截整頁，高度主要影響 vh/sticky 等 viewport-dependent 排版。
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(({ selectedTheme, selectedScheme }) => {
      try { localStorage.setItem('theme', selectedTheme); } catch { /* file:// may deny storage */ }
      const apply = () => {
        const root = document.documentElement;
        if (!root) return false;
        root.dataset.theme = selectedTheme;
        root.style.colorScheme = selectedScheme;
        return true;
      };
      if (!apply()) {
        const observer = new MutationObserver(() => {
          if (apply()) observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
      }
    }, { selectedTheme: theme, selectedScheme: scheme });
    await page.goto(target);
    // Re-apply after app bootstrap so a framework/theme initializer cannot
    // silently erase the matrix case selected by the gate.
    await page.evaluate(({ selectedTheme, selectedScheme }) => {
      document.documentElement.dataset.theme = selectedTheme;
      document.documentElement.style.colorScheme = selectedScheme;
    }, { selectedTheme: theme, selectedScheme: scheme });
    // fullPage 截整頁；animations 由 playwright.config.mjs 的 toHaveScreenshot 統一關閉。
    await expect(page).toHaveScreenshot(`index-${snapshotKey}.png`, { fullPage: true });
  });
}

// ── 想擴充？把下面解開、照樣加自己的頁面與視口 ──────────────────────────
// 每個 test 產生一張獨立 baseline（檔名 = toHaveScreenshot 的第一個參數）。
//
// test('pricing.html：視覺回歸', async ({ page }) => {
//   await page.setViewportSize({ width: 1024, height: 768 });
//   await page.goto(pathToFileURL(resolve('pricing.html')).href);
//   // 有會變動的區塊（時間戳、隨機圖）就 mask 掉，避免非產品 diff：
//   await expect(page).toHaveScreenshot('pricing.png', {
//     fullPage: true,
//     mask: [page.locator('[data-dynamic]')],
//   });
// });
