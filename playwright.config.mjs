import { defineConfig } from '@playwright/test';

// 視覺回歸 + 無障礙關卡的共用設定。
// 需要：npm install（會裝 @playwright/test、@axe-core/playwright）+ npx playwright install chromium
export default defineConfig({
  testDir: 'gates',
  testMatch: /.*\.spec\.mjs$/,
  expect: {
    // 視覺回歸容差：像素差異比例上限（動畫/字型渲染的正常抖動）
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' }
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', colorScheme: 'light' } }]
});
