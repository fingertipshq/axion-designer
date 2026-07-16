import { defineConfig } from '@playwright/test';

// ── playwright 設定（dk 的 visual / a11y 重關卡共用）──────────────────────────
// dk 的 visual 關卡封裝 `npx playwright test gates/visual.spec.mjs`，讀這份設定。
// 需要：npm i -D @playwright/test（視覺）＋ @axe-core/playwright（無障礙）
//        npx playwright install chromium
export default defineConfig({
  testDir: 'gates',                    // 規格檔放這（dk 的 visual 關卡找 gates/visual.spec.mjs）
  testMatch: /.*\.spec\.mjs$/,         // 只跑 *.spec.mjs
  expect: {
    // 視覺回歸容差與去抖（兩道獨立門檻，都要越過才算「畫面有差」）：
    //   maxDiffPixelRatio — 被判為「不同」的像素占整頁的比例上限；越小越嚴。
    //     例：整頁 1% 以內的差異視為抖動放行。小面積的 token 改動（如一顆小按鈕換色）可能低於此比例。
    //   threshold — 單一像素要差多少（0–1，YIQ 感知距離）才算「不同」；playwright 預設 0.2。
    //     要抓更細微的換色（如把 #ffffff 換成 #f8f8f8）就調小，例如 0.05；但太小易受抗鋸齒 flake。
    //   animations: 'disabled' — 截圖時凍結 CSS 動畫/transition，消除時間相關的 flake。
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, threshold: 0.2, animations: 'disabled' },
  },
  // project 提供可重現的 browser 基線；scaffold visual.spec 會依
  // gates.visual.themes 在每個 case 覆寫 colorScheme + data-theme。
  projects: [{ name: 'chromium', use: { browserName: 'chromium', colorScheme: 'light' } }],
});
