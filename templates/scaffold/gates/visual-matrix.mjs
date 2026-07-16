import { createHash } from 'node:crypto';

export const DEFAULT_VISUAL_MATRIX = Object.freeze({
  viewports: Object.freeze([375, 1024]),
  themes: Object.freeze(['light', 'dark']),
});

/**
 * Read the matrix injected by `dk verify --gate visual`. The optional env
 * argument makes the contract directly testable without starting a browser.
 */
export function readVisualMatrix(env = process.env) {
  let raw;
  try { raw = JSON.parse(env.DK_VISUAL_MATRIX ?? 'null'); } catch { raw = null; }
  const rawViewports = Array.isArray(raw?.viewports)
    ? raw.viewports
    : readList(env.DK_VISUAL_VIEWPORTS, DEFAULT_VISUAL_MATRIX.viewports);
  const rawThemes = Array.isArray(raw?.themes)
    ? raw.themes
    : readList(env.DK_VISUAL_THEMES, DEFAULT_VISUAL_MATRIX.themes);
  const viewports = [...new Set(rawViewports.filter((v) => Number.isInteger(v) && v > 0 && v <= 10000))];
  const themes = [...new Set(rawThemes
    .filter((v) => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean))];
  return {
    viewports: viewports.length ? viewports : [...DEFAULT_VISUAL_MATRIX.viewports],
    themes: themes.length ? themes : [...DEFAULT_VISUAL_MATRIX.themes],
  };
}

/** Expand a resolved matrix into stable Playwright cases. */
export function visualCases(matrix) {
  const cases = [];
  for (const width of matrix.viewports) {
    for (const theme of matrix.themes) {
      cases.push({
        width,
        height: viewportHeight(width),
        theme,
        colorScheme: theme.toLowerCase() === 'dark' ? 'dark' : 'light',
        snapshotKey: `${width}-${snapshotPart(theme)}`,
      });
    }
  }
  return cases;
}

function readList(value, fallback) {
  try { const parsed = JSON.parse(value ?? 'null'); return Array.isArray(parsed) ? parsed : fallback; }
  catch { return fallback; }
}

export function viewportHeight(width) {
  if (width <= 480) return 844;
  if (width <= 768) return 1024;
  return 768;
}

// Theme names are user config and become filenames. Keep them portable and
// collision-resistant without losing the readable part of the selected theme.
export function snapshotPart(theme) {
  const readable = theme.normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'theme';
  const digest = createHash('sha256').update(theme).digest('hex').slice(0, 8);
  return `${readable}-${digest}`;
}
