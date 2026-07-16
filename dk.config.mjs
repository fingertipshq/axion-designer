// Axion Designer repository configuration and config schema example.
// Merge order: built-in defaults < preset < this file.
import { defineConfig } from './src/core/config.mjs';

export default defineConfig({
  preset: 'strict', // recommended | strict | minimal

  tokens: {
    source: 'design/tokens.json', // SSOT
    output: { css: 'styles/tokens.css' }, // dk build 由此編出產物；dk verify 驗同步
  },

  // Portable design direction contract；未採用時保持 optional。
  direction: {
    source: 'design/direction.json',
    lock: 'design/direction.lock.json',
    required: true,
  },

  // 通用：掃任何框架的 source。Studio 的 shipped CSS 也必須 dogfood
  // source gate；不能因為它是內部工具就躲在 templates target 之外。
  targets: ['templates/*.html', 'src/studio/client/app.css', 'src/studio/client/*.js'],
  // fixtures 不在預設 targets 內，但可由明確路徑單獨掃描。
  ignore: ['**/node_modules/**', '**/.dk/**'],

  failOn: 'error', // CI 門檻：error | warn

  // ── 擴充 token 覆蓋範圍 ───────────────────────────────
  // 加你自己的必要語意 token 與必過對比組合（此處與內建重疊，示範用法）。
  tokens_required: ['color.brand.accent'],
  contrast: {
    algorithm: 'wcag', // wcag | apca
    modes: ['light', 'dark'],
    pairs: [
      ['color.text.on-accent', 'color.brand.accent', 4.5],
      // 驗證 starter.html 使用的 state 色與 raised surface 配對。
      ['color.state.positive', 'color.surface.raised', 4.5],
      ['color.state.negative', 'color.surface.raised', 4.5],
      ['color.state.warning', 'color.surface.raised', 4.5],
    ],
  },

  // ── 自訂 slop 規則（把品味變機檢閘門）─────────────────
  slop: {
    fonts: { deny: ['Inter', 'Roboto', 'DM Sans'], allow: [] },
    rules: [
      // 宣告式規則：regex + severity + report hint。
      {
        id: 'brand/no-glow-shadow', zone: 'style',
        pattern: 'filter:\\s*drop-shadow', severity: 'warn',
        message: '禁止 glow 陰影', hint: '用 var(--shadow-card)；glow 讀起來像 AI slop',
      },
    ],
  },

  // ── 調校任何內建/自訂規則 ─────────────────────────────
  severity: {
    // 'slop/vanity-number': 'error',  // 升級
    // 'slop/emoji-heading': 'off',    // 關掉
  },
  allowlist: {
    // 'slop/hardcoded-color': ['src/embed/**'],
    // Studio is a dense inspection tool with deliberately bespoke micro-layout
    // measurements. Color remains fully gated through its local :root palette;
    // spacing/type/radius scale warnings are scoped only to this one stylesheet.
    'slop/hardcoded-spacing': ['src/studio/client/app.css', 'src/studio/client/*.js'],
    'slop/hardcoded-type': ['src/studio/client/app.css', 'src/studio/client/*.js'],
    'slop/hardcoded-radius': ['src/studio/client/app.css', 'src/studio/client/*.js'],
  },

  baseline: '.dk/baseline.json',

  // The repository's default verify remains dependency-light and reproducible
  // in a clean checkout. CI invokes css-strict and a11y explicitly after npm
  // install. Visual regression is deliberately not enabled here because this
  // repository does not version a platform-specific authoritative baseline;
  // CI captures review candidates but never compares a commit to itself.
  gates: {
    cssStrict: { enabled: false },
    a11y: { enabled: false, tags: ['wcag2a', 'wcag2aa'] },
    visual: { enabled: false, viewports: [375, 1024], themes: ['light', 'dark'] },
  },
});
