# App Proof：驗證真實 Web App

原本的 `a11y` gate 可以用 `file://` 掃描 HTML。加入 `proof` 後，同一道 gate 會改為連接**已經啟動的真實 dev／preview server**，逐一執行：

```text
route × state × viewport × theme
```

每個案例都建立獨立 browser context、載入真實 URL、完成宣告式互動，再執行 axe、收集實際載入 CSS 中引用的 token，並保存一張帶 SHA-256 的 full-page screenshot。只要有一個案例載入失敗、selector 找不到、互動超時、頁面發生未捕捉例外／crash、截圖無法落盤或無法掃描，就產生 `a11y/scan-failed` error；它不會因其他案例成功而被算成通過。

## 設定

先由專案自己的指令啟動 app，例如 `npm run dev`。Axion 不猜測也不接管 server lifecycle，CI 可以用既有的 `start-server-and-test`、Docker health check 或工作流 service。

```js
// dk.config.mjs
export default {
  // ...tokens / targets...
  proof: {
    baseUrl: 'http://127.0.0.1:3000',
    routes: [
      '/',
      { name: 'pricing', path: '/pricing', waitFor: 'main[data-ready]' },
      {
        name: 'checkout',
        path: '/checkout',
        // route states 會取代下方的全域 states，只掃這條 route 真正存在的狀態。
        states: [
          'default',
          {
            name: 'validation-error',
            actions: [
              { type: 'fill', selector: '#email', value: 'not-an-email' },
              { type: 'click', selector: 'button[type=submit]' },
            ],
            waitFor: '[role=alert]',
          },
        ],
      },
    ],
    states: [
      'default',
      {
        name: 'navigation-open',
        actions: [{ type: 'click', selector: '[aria-controls=site-menu]' }],
        waitFor: '#site-menu:not([hidden])',
      },
    ],
    viewports: [
      { name: 'mobile', width: 375, height: 812 },
      { name: 'desktop', width: 1440, height: 900 },
    ],
    themes: [
      'light',
      { name: 'night', colorScheme: 'dark', attributes: { 'data-theme': 'night' }, classes: ['dark'] },
    ],
    timeoutMs: 15000,
    maxRoutes: 50,
    maxCases: 200,
  },
  gates: {
    a11y: { enabled: true, tags: ['wcag2a', 'wcag2aa'] },
  },
};
```

執行：

```bash
dk verify --gate a11y --require-gates --json
```

完整逐案例 artifact 會寫入 `.dk/proof/app-proof.json`，截圖寫入 `.dk/proof/screenshots/`；每筆結果包含穩定 case ID、matrix、截圖路徑／byte 數／SHA-256 與 runtime token。Artifact 的 `tags` 會記錄實際 Axe 標準 profile（`[]` 明確代表 Axe default-all），並與 proof plan 一起進入 `configHash`；更改 WCAG 範圍後舊證據不會被當成 current。持久化 ledger `.dk/report.json` 的 `emits.appProofCoverage` 會保存實際 routes、states、viewports、themes、計畫案例數、完成數、失敗數與 screenshot 數，`appProofTags` 會記錄同一份標準 profile，`appProofDiscovery` 會說明 route 是明列或自動探索。

## Route 自動探索的誠實邊界

```js
proof: { baseUrl: 'http://127.0.0.1:3000', routes: 'auto' }
```

`auto` 會驗證入口 URL，以及入口頁當下可見 `<a href>` 中的同源 HTTP(S) URL。它會移除 hash、去重，拒絕跨來源連結；超過 `maxRoutes` 時整次失敗，不會偷偷截斷。

這不是 framework router 的完整靜態分析。藏在權限後、尚未顯示、只能經多步操作到達的 route 必須明列。正式 CI 要宣稱完整產品覆蓋時，應使用 explicit routes。

## 可宣告的狀態動作

支援的 action 是：

- `click`、`check`、`uncheck`
- `fill`（需要字串 `value`）
- `select`（需要字串或字串陣列 `value`）
- `press`（需要 `key`）
- `waitFor`（可指定 `attached`、`detached`、`visible`、`hidden`）

除 `default` 外，狀態不能只寫一個名字；必須提供 `actions` 或 `waitFor`，否則系統無法證明畫面真的進入該狀態。設定不接受任意 `evaluate` JavaScript，避免把可審查的 coverage contract 變成隱藏程式。

## Theme 的套用方式

字串 theme（如 `dark`）會同時設定 `colorScheme`、`data-theme="dark"` 與 `dark` class。物件 theme 可以精確指定 `colorScheme`、HTML attributes 和 classes。設定會在 navigation 前注入，並在載入後再套用一次，兼容 SSR 與 client-rendered app。

## Fail-closed 語意

- 缺 Playwright、axe 或 Chromium：gate 為 blocking `skipped`／整體 `incomplete`。
- server 不可達、HTTP 4xx/5xx、route/state action 失敗、未捕捉 `pageerror` 或 page crash：該案例產生 `a11y/scan-failed` error／整體 `failed`。
- runner 少回任何一個計畫案例、重複 case ID／matrix、coverage 數字自相矛盾、截圖不存在或 digest 不符：blocking `invalid-output`，不視為通過。
- 矩陣超過 `maxCases`、自動路由超過 `maxRoutes`、跨來源 route、URL 內含 credentials：設定失敗，瀏覽器不啟動。

App Proof screenshot 是「這次到底掃了什麼」的內容證據，不會自行宣稱跨 commit 像素一致。真正的 pixel regression 仍由 `visual` gate 將目前畫面和另一時間點、經人工接受的權威 baseline 比較；同一次 run 先拍再比不算回歸證明。
