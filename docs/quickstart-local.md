# 本機快速開始

本頁說明如何在公開安裝來源建立前，直接從 repository 使用 `Axion Designer`。

依賴分成三層：

1. **專案層 Codex skill**：`dk codex init` 只把 `$dk-design` 複製到目前 repository 的 `.agents/skills/dk-design`，與相符版本的 `dk` runtime 一起使用；不會寫入 Codex 使用者設定。執行環境需 Node.js `>=18.14.1`。
2. **核心 CLI**：contract、direction、SSOT 與 source gates 需要 Node.js `>=18.14.1`，沒有 runtime npm 依賴。
3. **完整 gates**：在目標前端 repository 安裝五個選用套件與 Chromium：

```bash
npm i -D stylelint stylelint-declaration-strict-value@1.10.6 postcss-html @playwright/test @axe-core/playwright
npx playwright install chromium
```

## 1. 使用 repository-local CLI

在 axion-designer repository 內確認執行體：

```bash
node bin/dk.mjs --version
node bin/dk.mjs doctor
```

若要在另一個目標 repository 使用，先將這份 source checkout 安裝為該專案的 local development dependency：

```bash
npm i -D /absolute/path/to/axion-designer
npx --no-install dk --version
```

這樣複製到 `.agents/skills/dk-design` 的 skill preflight 才能在目標 repository 找到同版本 `node_modules/axion-designer/bin/dk.mjs`。不要只用 source repo 的絕對 CLI 對另一個 repo 執行 `codex init`，因為之後的 skill 必須有 target-local runtime。

本流程不需要、也不建議 `npm link`、`npm install -g`、全域 MCP 註冊或全域 Codex plugin 安裝。以下 cross-repo 範例統一使用 `npx --no-install dk`；只有在 Axion source repository 自身才使用 `node bin/dk.mjs`。

## 2. 只在目前專案啟用 `$dk-design`

在目標 repository 內先檢查狀態。尚未接入時，`status` 顯示 `missing` 並以 exit code `2` 結束，這是預期的 setup-required 訊號：

```bash
npx --no-install dk codex status
npx --no-install dk codex init
npx --no-install dk codex status
```

`init` 只寫入 `.agents/skills/dk-design`。目錄不存在時才建立；同一 bundle 已存在時可安全重複執行；若檢查到 stale、invalid 或自訂內容，會拒絕覆寫。新安裝會在該目錄建立 `.axion-install.json` receipt，記錄 package 版本、repository scope、explicit activation，以及 skill／runtime 的 SHA-256 digest。後續 `status` 會驗證複製後的 skill bytes、project-local runtime 與 receipt 相符；receipt 缺漏或 digest 不符時不會回報 `ready`。

完成後開一個新 Codex task，或讓目前 client 重新載入 skills。無論 Codex CLI 或桌面版，都必須在 prompt 明確點名 `$dk-design`：

```text
使用 $dk-design 建立或精修這個介面，檢查真實渲染畫面，
修正影響最大的落差，再執行確定性驗證。
```

兩個 Codex 介面使用相同的 skill、方向契約與 CLI：

- Codex CLI 適合終端指令、批次修改與自動化。
- Codex 桌面版適合對話、檔案檢視、真實 screenshots 與並排方向比較。

能力與輸出格式不會因介面不同而分叉。skill 的 `agents/openai.yaml` 設定 `allow_implicit_invocation: false`，所以單純要 Codex 修正程式或設計 UI，不會自動套用 Axion。

### `dk codex` 五個入口

| 指令 | 是否寫檔 | 具體用途 |
|---|---:|---|
| `dk codex status [--json]` | 否 | 檢查 ready／missing／stale／invalid、runtime／skill digest、install receipt、explicit-only、CLI／Desktop 與隔離狀態。 |
| `dk codex init [--json]` | 是 | 只於目前 repo 建立 `.agents/skills/dk-design` 與 digest receipt；絕不覆寫。 |
| `dk codex context [--json] [--trust-project-config]` | 否 | 生成 12KB budget 內、source-backed 的 routes、components、direction、report、App Proof、Bridge、Design Intelligence、Reference evidence、authority 與建議 lane；預設不執行專案 JavaScript。 |
| `dk codex prompt [lane]` | 否 | 產生 `auto`、`explore`、`refine`、`reconstruct`、`reimagine` 或 `verify` 起手 prompt，且一定包含 `$dk-design`。 |
| `dk codex mcp [--json]` | 否 | 只列出綁定目前 repo 的 `dk-mcp --root <repo>` 啟動規格；不改 config、不啟動 daemon。 |

實際建議順序：

```bash
npx --no-install dk codex status
npx --no-install dk codex context
npx --no-install dk codex prompt auto
```

安全預設下，`context` 不執行 repository 內的 `dk.config.mjs` 或 `dk.config.js`。若輸出顯示 `configuration.status: "requires-trust"`，先檢視並信任該 repository；只有確實需要載入可執行專案政策時，才執行：

```bash
npx --no-install dk codex context --json --trust-project-config
```

這個旗標可能執行 repository 內的 JavaScript，所以不能只為了消除提示而加入。它仍只作用於目前 repository，不會建立任何全域信任設定。

`context` 會另外回報 `evidence.report.freshness.status`：

- `current`：report 的 runtime、已解析政策、source fingerprint、token、direction／binding 與 approval head 都符合目前 repository；report 原本的 passed／failed 狀態才可視為目前證據。
- `stale`：上述可比較狀態已改變，例如 source、config、token、direction 或 runtime 已更新；舊的綠燈不能證明現在通過。
- `historical`：報告仍保留供追溯，但因 config 未受信、partial／legacy report、缺少 matching runtime 或 current hash，不能權威地與目前狀態比較。

遇到 `stale` 或 `historical` 時，先處理列出的 `freshness.reasons`，再用目前 project-local runtime 重跑 `dk verify`；不要把舊報告當成 current proof。

不確定要用哪個 lane 時使用 `auto`；已知新產品、局部精修、授權參考圖重建、明確改版或只驗證時，改用對應 lane。將 `prompt` 輸出貼到 Codex CLI 或桌面版即可。

MCP 是選用面。需要宿主讀取 Axion evidence 或執行有界驗證時，才執行：

```bash
npx --no-install dk codex mcp --json
```

這個指令只輸出 `command` 與 `args`。它不會寫 `~/.codex`、不會註冊全域 MCP，也不會啟動常駐程序。產生的 Project MCP 只能讀寫指定的 repository root，不能跨專案漫遊。

### Plugin artifact 與兩種 MCP 的邊界

Repository 內已包含 `.codex-plugin/plugin.json`、`.mcp.json` 與 bundled `$dk-design`，但本機快速流程不安裝、不發布、不改 plugin cache 或個人 marketplace。未來從 plugin 明確呼叫 bundled skill 時，它可在 preflight 通過後對使用者明確指定的 target repository 工作；檔案系統根目錄、home、`CODEX_HOME` 與全域設定範圍仍會被拒絕。

Plugin MCP 只暴露無狀態、離線的 Design Intelligence，沒有任何專案檔案權限。要讀 Codex context、Reference artifacts 或驗證證據，使用上方由 `dk codex mcp` 產生、綁定明確 root 的 Project MCP。

### 隔離保證

- 安裝範圍只是目前 repository。
- 啟用方式只是明確 `$dk-design`。
- 不寫 `~/.codex`、`~/.agents`、`/etc/codex`、plugin cache 或個人 marketplace。
- 不執行 `npm link`、`npm install -g`、`codex plugin add` 或 `codex mcp add`。
- 不影響其他 repository，也不影響沒有明確呼叫 `$dk-design` 的既有 Codex task 或全機預設行為。

## 3. 建立新專案

```bash
node /absolute/path/to/axion-designer/bin/dk.mjs new my-interface
cd my-interface
npm i -D /absolute/path/to/axion-designer
npx --no-install dk codex init
npx --no-install dk design init
npx --no-install dk codex context
```

`dk new` 會放入：

- `design/tokens.json`：設計 token 的單一來源
- `styles/tokens.css`：由 token 編譯出的 CSS
- `dk.config.mjs`：品質與方向設定
- `stylelint.config.mjs`：選用 CSS strict gate 的設定
- `index.html`：品牌中性、能通過核心檢查的起點
- `gates/visual.spec.mjs` 與 `playwright.config.mjs`：選用視覺 gate 範本

接著把真實產品需求交給 Codex：

```text
使用 $dk-design 設計這個產品頁。
使用者是＿＿，最重要的任務是＿＿，主要操作是＿＿。
請保留＿＿限制，查看桌面與手機畫面後再完成驗證。
```

你不需要先提供色碼、字體名稱或設計術語。若已有品牌或參考資料，直接補上即可。

## 4. 接入既有前端專案

在目標 repository 執行：

```bash
npm i -D /absolute/path/to/axion-designer
npx --no-install dk codex init
npx --no-install dk init
npx --no-install dk design init
npx --no-install dk build
npx --no-install dk verify
npx --no-install dk codex context
```

然後要求 Codex 沿用現有技術棧：

```text
使用 $dk-design 精修這個現有頁面。保留框架、路由、資料流與可用元件，
先判斷目前身份是否相符；只在確實需要時探索新方向。
```

若專案已有大量舊違規，可先建立棘輪：

```bash
npx --no-install dk baseline --accept
```

這會保留既有債務的可見性，但之後只讓新增違規阻擋工作。

## 5. 使用 Design Intelligence 或授權參考圖

沒有設計術語時，先用離線引擎把 brief 轉成三個可比較方向：

```bash
npx --no-install dk intelligence catalog
npx --no-install dk intelligence recommend \
  "餐飲店每日營運儀表板，店長要快速發現異常並處理" \
  --stack react --density compact --motion subtle --variance 70 --json
```

引擎完全離線；資訊足夠時給三個結構、字體角色、色彩分配、密度與動態都可區分的配方，不足時回傳 `needs-clarification`。

要將一至五張授權 PNG、JPEG 或 WebP 重建成真實元件，先產生 Reconstruct 起手 prompt，再按五階段建立 evidence chain：

```bash
npx --no-install dk codex prompt reconstruct
npx --no-install dk reference add dashboard references/dashboard.png \
  --source "內部設計評審" --license owned \
  --scope "src/dashboard/**,/dashboard" --viewport 1440x900@1
npx --no-install dk reference decompose .dk/drafts/dashboard.decomposition.json
npx --no-install dk reference map .dk/drafts/dashboard.mapping.json
npx --no-install dk reference plan .dk/drafts/dashboard.plan.json
```

五階段依序是 `reference-manifest/v1` → `visual-decomposition/v1` → `component-mapping/v1` → `reconstruction-plan/v1` → `reference-comparison/v1`。`--license unknown` 只能登錄與 decompose；未釐清授權前，map、plan、reconstruct 和 compare 都會失敗。v1 每張 reference 只允許一個登錄 viewport 與一次 required comparison。

完成實作後，先把 App Proof 設定成相同 route、state、theme 與 plan viewport，執行擷圖；再從 `.dk/proof/app-proof.json` 取成功 case 的原始 `screenshot.path`。compare 必須列出 reconstruction plan 的 `verification.implementationFiles` 中 **完全相同的一組檔案**：

```bash
npx --no-install dk proof --app http://127.0.0.1:3000 --routes /dashboard
npx --no-install dk reference compare dashboard .dk/proof/screenshots/case_<實際-id>.png \
  src/dashboard/Dashboard.tsx src/dashboard/dashboard.css --json
```

比較 artifact 綁定 plan、App Proof、ledger、case、screenshot、viewport、config/source freshness 與 implementation digests，對可解碼 PNG 進行 position-aware pixel 比對，並掃描整頁重用參考圖的 anti-cheat 風險。在 Studio 第八個 **Reference** view 可看 browser capture attestation、並排、overlay 與 top deltas。只有目前成功 case 的原始 screenshot path 能到 `match`／`complete`；任意圖片或同 bytes 複本只能是 `review`。修改 source 後必須重跑 App Proof 再比較。App Proof v2 目前只證明 DPR 1；像素與美感仍是 advisory，也不取代 visual gate、accessibility、其他 responsive/state coverage 或 `dk verify`。

完整契約見 [P3 Codex 設計引擎實戰手冊](p3-codex-design-engine.zh-TW.md)。

## 6. 檢視與鎖定

完成實作後：

```bash
npx --no-install dk design check
npx --no-install dk verify
npx --no-install dk verify --full --require-gates
npx --no-install dk design lock --accept --actor "Design Lead" --reason "已檢視方向、響應式畫面與驗證證據"
```

`--full` 的 Stylelint、無障礙與視覺 gate 需要上面列出的選用依賴與 Chromium。可先執行 `npx --no-install dk doctor` 檢查目前環境；缺少的 gate 會明列為 incomplete，不會假裝通過。

第一次建立視覺 baseline：

```bash
DK_UPDATE_VISUAL=1 npx --no-install dk verify --gate visual
```

之後像素差異會維持失敗，直到人工確認並明確接受：

```bash
DK_UPDATE_VISUAL=force npx --no-install dk verify --gate visual
```

## 7. 確認本機狀態

```bash
npx --no-install dk codex status
npx --no-install dk codex context --json
npx --no-install dk rules
npx --no-install dk design check
npx --no-install dk verify --json
npx --no-install dk report --html --out dk-report.html
```

通過條件：

- exit code `0`
- direction、token 與 SSOT 狀態符合設定
- 明確要求的 gate 沒有 incomplete
- Taste Lock 與已核准方向一致

更完整的方向流程見 [AI UI Director](ai-ui-director.md)，視覺 baseline 策略見[視覺回歸](visual-regression.md)。
