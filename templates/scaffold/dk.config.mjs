// dk.config.mjs — 你的設計品質設定。
// 這份用 `export default { … }`，不 import 任何東西，所以零依賴就能被 dk 讀取。
// 安裝 dk 後想要型別提示，可改成：
//   import { defineConfig } from 'axion-designer';
//   export default defineConfig({ … });
//
// 合併順序：內建預設 < preset < 這份。找不到這個檔 = 退回 recommended。

export default {
  // Preset：recommended | strict（啟用 scale 與重關卡）| minimal。
  preset: 'recommended',

  tokens: {
    source: 'design/tokens.json',          // SSOT——你唯一該手改的設計來源。
    output: { css: 'styles/tokens.css' },   // `dk build` 由此編出；`dk verify` 驗同步。
    // token 可同時編譯為多種格式，例如供 JavaScript 使用：
    // output: { css: 'styles/tokens.css', js: 'styles/tokens.js' },
  },

  // AI 設計方向契約：`dk design init` 建立 draft，選定後以 Taste Lock 鎖住飄移。
  // required 預設 false：尚未啟用 UI Director 的既有專案不會被阻塞。
  direction: {
    source: 'design/direction.json',
    lock: 'design/direction.lock.json',
    required: false,
  },

  // 通用：掃 standalone styles、script 與常見 component source，不綁單一框架。
  targets: ['*.html', 'src/**/*.{css,scss,less,html,js,jsx,ts,tsx,vue,svelte,astro}'],
  ignore: ['**/node_modules/**', '**/.dk/**', '**/dist/**', '**/build/**'],

  failOn: 'error', // CI 門檻：error（只擋 error）| warn（warn 也擋）。

  // ── 擴充 TOKEN 覆蓋範圍 ────────────────────────────────
  // 加你自己的「必要語意 token」與「必過對比組合」，把無障礙底線寫進鏈裡。
  // tokens_required: ['color.brand.accent'],
  // contrast: {
  //   algorithm: 'wcag',                 // wcag（AA 比值）| apca（感知對比 Lc，更嚴）
  //   modes: ['light', 'dark'],
  //   pairs: [['color.text.primary', 'color.surface.raised', 4.5]],
  // },

  // ── 把 TOKEN 治理從顏色延伸到節奏 / 圓角 / 字級 ──────────
  // 打開後，off-scale 的裸值（如 padding:15px）會被擋；用 var(--space-*) 則通過。
  // strict preset 已預設把這三個開成 warn。
  // enforce: { spacing: 'warn', radius: 'warn', type: 'error' },

  // ── 自訂 SLOP 規則：把「品味」寫成會 exit 1 的機檢閘門 ──
  slop: {
    // allow 是明確核准，優先於內建與自訂 deny（例如品牌刻意使用 Inter）。
    fonts: { deny: ['Inter', 'Roboto', 'DM Sans'], allow: [] },
    rules: [
      // 宣告式範例：啟用後檢查 glow 陰影，hint 會出現在報告中。
      // {
      //   id: 'brand/no-glow-shadow', zone: 'style',
      //   pattern: 'filter:\\s*drop-shadow', severity: 'warn',
      //   message: '禁止 glow 陰影', hint: '用 var(--shadow-card)；glow 讀起來像 AI slop',
      // },
    ],
  },

  // ── 調校任何內建/自訂規則 ──────────────────────────────
  // severity: { 'slop/vanity-number': 'error', 'slop/emoji-heading': 'off' },
  // allowlist: { 'slop/hardcoded-color': ['src/embed/**'] }, // 逐規則 + glob 的明確例外

  // ── 真實 WEB APP PROOF（選用）──────────────────────────
  // 先用專案自己的命令啟動 dev server；啟用後 a11y 會掃真實 URL 的完整矩陣，
  // 不再以 file:// HTML 代替。詳細 state actions：docs/app-proof.md。
  // proof: {
  //   baseUrl: 'http://127.0.0.1:3000',
  //   routes: ['/', '/pricing'], // 或 'auto'（只探索入口頁的同源可見連結）
  //   states: ['default'],
  //   viewports: [{ name: 'mobile', width: 375, height: 812 }, { name: 'desktop', width: 1440, height: 900 }],
  //   themes: ['light', 'dark'],
  // },

  // 視覺 gate 會讓 scaffold 的 visual.spec 實際跑完每個 viewport × theme；
  // 改這裡會改變快照矩陣，新增/刪除的 baseline 都必須明確審查。
  gates: {
    a11y: { enabled: false, tags: ['wcag2a', 'wcag2aa'] },
    visual: { enabled: false, viewports: [375, 1024], themes: ['light', 'dark'] },
  },

  baseline: '.dk/baseline.json', // 棘輪：`dk baseline --accept` 後只擋「新增」違規。
};
