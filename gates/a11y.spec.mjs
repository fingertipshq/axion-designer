import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// 無障礙關卡：用 axe-core 掃範本，任一 WCAG A/AA 違規 → 測試失敗（CI 擋關）。
const target = pathToFileURL(resolve('templates/starter.html')).href;

test('starter：無 WCAG 2.1 A/AA 違規', async ({ page }) => {
  await page.goto(target);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(violations, violations.map((v) => `${v.id} (${v.nodes.length})`).join(', ')).toEqual([]);
});
