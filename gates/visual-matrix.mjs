import { createHash } from 'node:crypto';

const DEFAULT = { viewports: [375, 1024], themes: ['light', 'dark'] };

export function readVisualMatrix(env = process.env) {
  let value;
  try { value = JSON.parse(env.DK_VISUAL_MATRIX ?? 'null'); } catch { value = null; }
  const widths = Array.isArray(value?.viewports) ? value.viewports : DEFAULT.viewports;
  const themes = Array.isArray(value?.themes) ? value.themes : DEFAULT.themes;
  const viewports = [...new Set(widths.filter((width) => Number.isInteger(width) && width > 0 && width <= 10000))];
  const normalizedThemes = [...new Set(themes.filter((theme) => typeof theme === 'string').map((theme) => theme.trim()).filter(Boolean))];
  return {
    viewports: viewports.length ? viewports : [...DEFAULT.viewports],
    themes: normalizedThemes.length ? normalizedThemes : [...DEFAULT.themes],
  };
}

export function visualCases(matrix) {
  return matrix.viewports.flatMap((width) => matrix.themes.map((theme) => ({
    width,
    height: width <= 480 ? 844 : width <= 768 ? 1024 : 768,
    theme,
    colorScheme: theme.toLowerCase() === 'dark' ? 'dark' : 'light',
    snapshotKey: `${width}-${snapshotPart(theme)}`,
  })));
}

function snapshotPart(theme) {
  const readable = theme.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'theme';
  return `${readable}-${createHash('sha256').update(theme).digest('hex').slice(0, 8)}`;
}
