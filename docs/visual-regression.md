# 視覺回歸關卡

`visual` 關卡執行 `gates/visual.spec.mjs`，以 Playwright screenshot 和既有 baseline 比對。任何超出 Playwright 容差的 pixel diff 都產生 error 級 `visual/regression`。

## 前置與執行

visual 需要：

- `@playwright/test`
- Chromium
- `gates/visual.spec.mjs`
- 已建立的 screenshot baseline

```bash
npm i -D @playwright/test
npx playwright install chromium
dk doctor
dk verify --gate visual
```

`--gate visual` 會先執行其上游 `contract` 與 `direction` 關卡，供 visual 取得稽核 metadata；上游 Finding 不計入這次指定關卡的退出門檻。

前置不足時，visual gate 記為 `status: 'skipped'` 並附 reason，整體報告為 `incomplete`：

- 缺 Playwright package、spec，或 Playwright process 無法啟動時，會記為 blocking skip。第一次建立 baseline 時若 Playwright 非零退出，也會記為 blocking skip；已有 baseline 的一般比對若非零退出，會產生 `visual/regression`。
- 尚未建立 baseline 是 `uninitialized` skip；預設可維持 exit 0，加 `--require-gates` 後非零退出。

## Baseline 生命週期

### 第一次建立

確認目前畫面是可接受的起點後執行：

```bash
DK_UPDATE_VISUAL=1 dk verify --gate visual
```

這會讓 Playwright 建立 `gates/visual.spec.mjs-snapshots/`，並寫入 `.dk/visual-baseline.json`。

### 一般驗證

```bash
dk verify --gate visual
dk verify --full --require-gates
```

若 screenshot 相同，visual 通過；若差異超過容差，產生 `visual/regression`、exit 1。

### 接受既有差異

已有 baseline 且畫面不同時，普通更新會拒絕覆蓋：

```bash
DK_UPDATE_VISUAL=1 dk verify --gate visual
# exit 1，baseline 不變
```

人工檢查 diff 並確認新畫面是預期結果後，才明確替換：

```bash
DK_UPDATE_VISUAL=force dk verify --gate visual
```

`DK_UPDATE_VISUAL=accept` 與 `force` 相同。若畫面其實沒有差異，`DK_UPDATE_VISUAL=1` 只會把 sidecar metadata 同步到目前值，不重拍 screenshot。

## Sidecar metadata

`.dk/visual-baseline.json` 記錄建立或更新 baseline 時的：

- `tokenHash`
- `directionHash`
- `directionBindingHash`

這三個 hash 只提供 review 時的變更脈絡，不改變 pixel diff 的 severity。無論 hash 是否變更，只要 screenshot 超出容差，結果都是 error。計算邊界見 [DESIGN.md](../DESIGN.md)。

## 設定容差

`playwright.config.mjs` 的 `expect.toHaveScreenshot` 控制比對：

```js
export default defineConfig({
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
      animations: 'disabled',
    },
  },
});
```

| 欄位 | 作用 |
|---|---|
| `maxDiffPixelRatio` | 允許的不同像素占比 |
| `threshold` | 單一像素被判為不同的 YIQ 感知距離 |
| `animations` | 設為 `disabled` 時停用 CSS 動畫與 transition |

降低前兩個值會抓到更小的差異，也更容易受字型、抗鋸齒與渲染環境影響。應在固定 OS、Playwright 與瀏覽器版本下調整。

## Viewport 與 theme 矩陣

`dk new` 的 scaffold 會直接使用 `dk.config.mjs` 的視覺矩陣：

```js
gates: {
  visual: {
    viewports: [375, 768, 1440],
    themes: ['light', 'dark'],
  },
},
```

visual runner 會把這些值傳給 `gates/visual.spec.mjs`，scaffold 為每個
`viewport × theme` 產生獨立 test 與 screenshot；上例共六組。`light`/`dark`
會同時設定 `prefers-color-scheme` 與 `<html data-theme="…">`；自訂 theme 名稱
會以 light color scheme 為底、並將名稱寫入 `data-theme`。

直接以裸 Playwright 執行 scaffold spec 時，矩陣預設為 `[375, 1024] ×
['light', 'dark']`。透過 `dk verify --gate visual` 時，config 為唯一權威來源。

自訂 visual spec 可讀取 runner 提供的 `DK_VISUAL_MATRIX` JSON，或分開的
`DK_VISUAL_VIEWPORTS` / `DK_VISUAL_THEMES` JSON arrays。

## 增加頁面與自訂狀態

新 viewport/theme 優先改上述矩陣。新頁面、互動狀態、mask 或 browser
仍在 spec 內使用獨立 test 與 screenshot 名稱：

```js
test('pricing mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(pathToFileURL(resolve('pricing.html')).href);
  await expect(page).toHaveScreenshot('pricing-mobile.png', {
    fullPage: true,
    mask: [page.locator('[data-dynamic]')],
  });
});
```

時間、亂數、動畫與外部資料應固定，或用 `mask` 排除不需要比較的動態區塊。

## CI Baseline

跨 commit 的視覺驗證必須在執行前還原同一份 baseline。可選擇：

- 將 screenshot 納入版本控制。
- 從固定 key 的 CI cache 還原。
- 從受控 artifact 儲存位置下載。

scaffold 預設忽略 `*-snapshots/`；若要提交 screenshot，需要調整該專案的 `.gitignore`。無論使用哪種方式，都應固定 runner OS、Playwright 與瀏覽器版本。

```yaml
- run: npm ci
- run: npx playwright install --with-deps chromium
- run: node bin/dk.mjs verify --full --require-gates
```

若同一次 CI run 先以 `DK_UPDATE_VISUAL=1` 建立 baseline，再立即比較，只能確認視覺關卡可以執行，不能比較上一個 commit 的畫面。

## 相關命令

```bash
dk explain visual/regression
dk doctor
```

整體 gate 與退出碼契約見 [acceptance.md](acceptance.md)。
