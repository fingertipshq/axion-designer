# 規則參考

目前的零依賴核心鏈順序是：

```text
contract → direction → ssot-sync → slop
```

可直接查詢當前設定下的規則與修正方式：

```bash
dk rules
dk explain slop/hardcoded-color
```

規則 id 使用 `category/name`。`error` 在預設 `failOn: 'error'` 下擋關；`warn` 只有在 `failOn: 'warn'` 下擋關；`off` 停用規則。`config.severity` 可覆寫個別規則。

## contract：token 契約

| id | 預設 | 驗證內容 | 修正 |
|---|---|---|---|
| `tokens/structure` | error | 每個 leaf token 有非空 `$value` | 補上具體值或 `{alias}` |
| `tokens/naming` | error | token key 為 kebab-case 或純數字階梯 | 重新命名 key |
| `tokens/required` | error | 內建與 `tokens_required` 指定的必要 token 存在 | 補齊語意 token |
| `tokens/unresolved-alias` | error | light／dark alias 都能解析到存在的 leaf | 修正 alias path 或補上目標 token |
| `tokens/alias-cycle` | error | alias 圖沒有循環 | 打斷循環，讓鏈末端落到具體值 |
| `tokens/css-var-collision` | error | 不同 dot path 不會壓平成同一個 CSS variable 名稱 | 重新命名其中一條 token path |
| `tokens/contrast` | error | 設定的前景／背景組合在指定 mode 達到門檻 | 調整 token，或修正 `config.contrast.pairs` |

內建必要 token 包含：`color.text.{primary,secondary,on-accent}`、`color.surface.page`、`color.brand.accent`、`color.state.{positive,negative}`、`space.4`、`radius.md`、`shadow.card`、`font.family.base`、`font.size.base`。

對比演算法由 `contrast.algorithm` 選擇：

- `wcag`：門檻使用對比比值；內建一般文字為 `4.5`，muted 為 `3.0`。
- `apca`：門檻使用 Lc；內建一般文字為 `60`，muted 為 `45`。

自訂 `contrast.pairs` 的 `[fg, bg, min]` 會依目前演算法解讀 `min`。缺少 token 或解析值不是可量測 hex 時，執行期會產生 info 級 `tokens/contrast-skipped`，該 pair 不會進入 `verifiedPairs`。

## direction：方向契約

方向檔預設可省略；`direction.required: true` 時必須存在、approved 且 lock 相符。

| id | 預設 | 觸發條件 | 修正 |
|---|---|---|---|
| `direction/missing` | error | required 但方向檔不存在 | `dk design init`，完成契約後檢查並鎖定 |
| `direction/contract` | error | JSON、schema 或必要欄位無效 | 依 Finding path 修正後執行 `dk design check` |
| `direction/token-binding` | error | binding 無法解析到現有 token | 改成存在的 dot path，或先建立語意 token |
| `direction/draft` | warn | 方向仍為 draft 或缺少具體取捨；required 時升為 error | 完成內容並把 status 設為 approved |
| `direction/unlocked` | warn | approved 方向沒有 lock；required 時升為 error | 審查後執行 `dk design lock --accept --actor <人> --reason <理由>` |
| `direction/drift` | error | direction hash 或已綁定 token 的 binding hash 與 lock 不符 | 還原非預期改動；刻意改版則重新審查並接受 lock |

操作入口：

```bash
dk design init
dk design check
dk design lock --accept --actor "Design Lead" --reason "已檢視方向、響應式畫面與驗證證據"
```

方向 hash 與 binding hash 的計算邊界見 [DESIGN.md](../DESIGN.md)。

## ssot-sync：編譯產物同步

| id | 預設 | 觸發條件 | 修正 |
|---|---|---|---|
| `tokens/ssot-sync` | error | `tokens.css` 不等於目前 `tokens.json` 的編譯結果 | 執行 `dk build`，一起提交來源與產物 |

`dk build --check` 只檢查，不寫入檔案。

## slop：來源掃描

| id | 預設 | 觸發條件 | 修正 |
|---|---|---|---|
| `slop/hardcoded-color` | error | 顏色屬性使用 `#hex` | 抬進 token，改用 `var(--token)` |
| `slop/ai-font` | error | 首位字體命中內建或自訂 deny；明確 `allow` 優先於兩者 | 選擇字體，或在 `config.slop.fonts.allow` 核准品牌刻意使用的字體 |
| `slop/lorem` | error | 出現 lorem ipsum | 換成實際文案 |
| `slop/gradient-hero` | warn | hero 使用規則涵蓋的紫／靛漸層 | 改用 token 化的背景或調整規則 |
| `slop/emoji-heading` | warn | heading 以 emoji 開頭 | 移除 emoji，改用排版層級 |
| `slop/vanity-number` | warn | 出現規則涵蓋的 `24/7`、`N+` 或保證百分比 | 改成可查證數字或移除 |
| `tokens/unknown-reference` | error | 受治理 namespace 內的 `var(--token)` 不存在於 manifest | 改用已宣告 token，或先在 SSOT 定義 |

Finding 包含 `file`、`line`、`col` 與 `fix`。`hardcoded-color` 會在有精確對應時指出可替換的 semantic token。

`dk fix --slop` 只自動改寫與某個 token 解析值完全相同、且能唯一決定的 hardcoded hex。歧義、只對到 primitive 或找不到對應值時保留原文並列為需人工處理；`--dry-run` 只顯示變更。詳細邊界見 [DESIGN.md](../DESIGN.md)。

### 尺度規則

| id | 設定鍵 | 驗證內容 |
|---|---|---|
| `slop/hardcoded-spacing` | `enforce.spacing` | padding、margin、gap 是否落在 spacing scale |
| `slop/hardcoded-radius` | `enforce.radius` | border-radius 是否落在 radius scale |
| `slop/hardcoded-type` | `enforce.type` | font-size 是否落在 type scale |

三項 enforcement 預設為 `off`；可設為 `off | warn | error`。數值比較會正規化等值寫法，例如 `.5rem` 與 `0.5rem`。

## 執行期訊號

| id | 等級 | 條件 |
|---|---|---|
| `config/no-targets` | warn | 已要求執行掃檔關卡，但 targets 沒有收集到任何檔案 |
| `a11y/scan-failed` | error | 某個 HTML target 或真實 App 矩陣案例無法載入、進入狀態或掃描；該案例不視為已驗證 |
| `tokens/contrast-skipped` | info | 對比 pair 因缺 token 或不可量測值而未驗證 |

## 選配關卡規則

| id | 預設 | 驗證內容 | 前置 |
|---|---|---|---|
| `css/strict-value` | error | Stylelint strict-value Finding | `stylelint` |
| `a11y/axe` | error | axe 對 HTML target 的 A／AA Finding | `@playwright/test`、`@axe-core/playwright`、Chromium |
| `visual/regression` | error | screenshot 與 baseline 的差異超過 Playwright 容差 | `@playwright/test`、Chromium、spec、baseline |

選配關卡判定前置不足時，該 gate 記為 `status: 'skipped'`；整體報告為 `incomplete`。`--full` 會讓阻斷性前置錯誤非零退出；`--require-gates` 或 `failOnSkipped: true` 會要求每個 attempted gate 都實際執行。visual 的 baseline 流程見 [visual-regression.md](visual-regression.md)。

## 自訂規則

在 `dk.config.mjs` 的 `slop.rules[]` 加入規則：

- 宣告式：`{ id, zone, pattern, severity, message, hint }`
- 程式式：`{ id, zone, severity, test: (ctx) => Finding[] }`

自訂規則與內建 slop 規則走相同的 severity、allowlist、`dk-ignore`、baseline 與報告流程。設定結構見 repository 的 `dk.config.mjs` 與 [DESIGN.md](../DESIGN.md)。
