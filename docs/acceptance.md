# 驗收契約

本文件只描述可由目前 CLI 重跑與判定的行為。退出碼如下：

| exit | 意義 |
|---|---|
| `0` | 沒有 Finding 達到 `failOn` 門檻；仍應檢查報告的 `status` 是否為 `incomplete` |
| `1` | Finding 達到 `failOn` 門檻，或要求執行的關卡因阻斷性前置問題未完成 |
| `2` | 命令、參數或必要輸入錯誤 |

`failOn: 'error'` 只以 error 擋關；`failOn: 'warn'` 也會以 warn 擋關。

## 核心鏈

`dk verify` 依固定順序執行：

```text
contract → direction → ssot-sync → slop
```

| 關卡 | 通過條件 | 主要輸出 |
|---|---|---|
| `contract` | token 結構、命名、alias、必要 token、CSS variable 唯一性與設定的對比組合有效 | `manifest`、`tokenHash`、`verifiedPairs` |
| `direction` | 方向檔依設定可省略；若存在則須符合 schema 並可解析 token bindings；若設為 required，還須 approved 且 lock 相符 | `directionStatus`、`directionHash`、`directionBindingHash`、`directionLocked` |
| `ssot-sync` | 輸出的 `tokens.css` 與目前 `tokens.json` 編譯結果一致 | 同步 Finding；修正命令為 `dk build` |
| `slop` | 掃描目標沒有達門檻的來源 Finding，包含 `slop/*` 與受治理 namespace 的未知 token reference | 逐筆 `file`、`line`、`col`、`fix` |

常用驗證指令：

```bash
node bin/dk.mjs verify
node bin/dk.mjs verify --json
node bin/dk.mjs verify --gate direction
node bin/dk.mjs build --check
```

`--gate <id>` 會同時執行該關卡需要的上游關卡；上游結果標為 auxiliary，不計入這次指定關卡的退出門檻。

## 執行狀態與機器輸出

報告的整體 `status` 有三種：

| status | 判定 |
|---|---|
| `passed` | 所有要求的關卡都已執行，且沒有 Finding 達到門檻 |
| `failed` | Finding 達到門檻 |
| `incomplete` | 至少一個要求的關卡為 `skipped`；是否非零退出取決於 skip 類型與 `--require-gates`／`failOnSkipped` |

`--json` 與 `--summary` 都包含 `status`、`exitCode`、`counts`、`gates`、`tokenHash` 與 direction 摘要。每個 gate 會保留 `status`、`reason`、`attempted`、`blocking` 與 `kind` 等可用欄位。

## 掃描、快取與 watch

| 能力 | 操作契約 |
|---|---|
| per-file 快取 | 預設寫入 `.dk/cache.json`；未變更檔案可還原 raw Finding。token、會改變 raw 掃描結果的設定或快取 schema 改變時會失效。`--no-cache` 停用讀寫 |
| 過濾層 | severity、allowlist、baseline 與 `dk-ignore` 在每次執行重新套用，不以舊的過濾結果取代目前設定 |
| terminal 折疊 | 每個規則預設顯示前 10 筆，其餘保留計數；`--all` 展開。JSON、summary、SARIF 與 HTML 不受 terminal 折疊影響 |
| watch | 單檔變更重掃該檔並合併帳本；token 或 config 變更觸發全量重跑；`SIGINT` 結束 |

可從 `--json`／`--summary` 的 `filesScanned` 與 `cacheHits` 檢查本次掃描範圍與快取命中數。

## 選配關卡

以下關卡在 `--full`、`--gate <id>` 或對應 config 啟用時才會嘗試執行：

| 關卡 | 通過條件 | 前置 |
|---|---|---|
| `css-strict` | Stylelint 沒有產生達門檻的 `css/strict-value` Finding | `stylelint` 與可掃描的樣式檔 |
| `a11y` | 每個 HTML target，或 `proof` 宣告的每個 route × state × viewport × theme 案例都完成掃描，且 axe 沒有產生達門檻的 Finding | `@playwright/test`、`@axe-core/playwright`、Chromium，以及 HTML target 或已啟動的 `proof.baseUrl` |
| `visual` | Playwright screenshot 與 baseline 的差異未超過設定容差 | `@playwright/test`、Chromium、`gates/visual.spec.mjs` 與 baseline |

選配關卡無法執行時，gate 記錄為 `status: 'skipped'` 並附 reason；整體報告為 `incomplete`。已辨識的缺依賴、runner 錯誤或無效輸出屬 blocking skip，明確執行 `--full` 或指定重關卡時會非零退出；其他工具執行錯誤也會以 Finding 或非零退出阻止通過。無適用 target 或尚未建立 visual baseline 屬非阻斷 skip；加上 `--require-gates` 或設定 `failOnSkipped: true` 後也會非零退出。

```bash
node bin/dk.mjs doctor
node bin/dk.mjs verify --full --require-gates
```

visual baseline 的建立與替換流程見 [visual-regression.md](visual-regression.md)。

## 回歸驗證

repository 內可重跑的測試入口：

```bash
node tests/self-test.mjs
node tests/p0-gates.mjs
```

`self-test.mjs` 驗證 scaffold、核心關卡、命令、抑制／baseline、修正、快取、watch 與選配關卡；選配依賴存在時會執行對應檢查。`p0-gates.mjs` 驗證重關卡錯誤映射、`passed | incomplete | failed`、skip blocking 與 visual fail-closed 行為。

## CI 最小契約

只要求零依賴核心鏈：

```yaml
- run: node bin/dk.mjs verify --json
```

要求完整關卡：

```yaml
- run: npm ci
- run: npx playwright install --with-deps chromium
- run: node bin/dk.mjs verify --full --require-gates
```

若 CI 啟用 visual，必須在驗證前還原同一套 screenshot baseline，並固定 runner OS、Playwright 與瀏覽器版本。SARIF、HTML 與 summary 的串接方式見 [integrations.md](integrations.md)。
