import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readVisualMatrix, visualCases } from './visual-matrix.mjs';

// Repository dogfood surface. CI captures this matrix as review candidates;
// the dk visual gate only compares it when an independently approved baseline
// is present, never against screenshots created by the same verification run.
const target = pathToFileURL(resolve('templates/starter.html')).href;
const matrix = readVisualMatrix();

for (const visualCase of visualCases(matrix)) {
  const { width, height, theme, colorScheme, snapshotKey } = visualCase;
  test(`starter: ${width}px · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme });
    await page.addInitScript(({ selectedTheme, selectedScheme }) => {
      const apply = () => {
        if (!document.documentElement) return false;
        document.documentElement.dataset.theme = selectedTheme;
        document.documentElement.style.colorScheme = selectedScheme;
        return true;
      };
      if (!apply()) {
        const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); });
        observer.observe(document, { childList: true, subtree: true });
      }
    }, { selectedTheme: theme, selectedScheme: colorScheme });
    await page.goto(target);
    await page.evaluate(({ selectedTheme, selectedScheme }) => {
      document.documentElement.dataset.theme = selectedTheme;
      document.documentElement.style.colorScheme = selectedScheme;
    }, { selectedTheme: theme, selectedScheme: colorScheme });
    await expect(page).toHaveScreenshot(`starter-${snapshotKey}.png`, { fullPage: true });
  });
}
