[English](README.md) · 繁體中文

# Axion Designer

> 大膽創造。機械驗證。守住風格。

`Axion Designer` 是一套為 AI agent 原生特化、僅作用於目前專案的 UI 系統；它讓 agent 建造高品質、具辨識度的介面，而且程式持續演進後，仍能守住原先選定的視覺方向。`dk-design` skill 只能明確呼叫，並同時支援兩種 host：Codex CLI 或桌面版只會在 prompt 點名 `$dk-design` 時使用它；Claude Code（CLI 或桌面版）只會在使用者明確輸入 `/dk-design` 時使用它。

它的核心由四個能力層組成：

- **`$dk-design`** 提供 Codex 一套美術指導流程：理解產品、必要時探索、沿用既有技術棧實作、查看真實畫面，再修正影響最大的落差。
- **`dk` CLI + `dk codex` / `dk claude`** 把核准方向變成可攜契約、驗證實作，只在單一 repository 安裝或檢查 skill，並產生專案綁定的 context 與 MCP 啟動規格，不修改 Codex 或 Claude 使用者設定。`dk claude init` 會把由 canonical bundle 確定性生成的 Claude 版 skill 安裝到 `.claude/skills/dk-design`，詳見 [Claude Code 整合](docs/claude-code.md)。
- **Design Intelligence** 把白話需求離線轉成三個實質不同的方向配方，具體涵蓋產品、布局、字體、色彩、動態、圖表、圖示與 UX，不呼叫模型或網路服務。
- **Reference → Code** 把一至五張有授權範圍的截圖，轉成 digest 相連的視覺拆解、元件對映、重建計畫、source-fresh 比較、App Proof capture attestation 與有界修復，而不是把「照圖做」塞進一條黑盒 prompt。

**Axion Bridge** 把相同的證據模型延伸到真實團隊已在使用的工具。它正規化 Storybook、Figma、preview、GitHub Actions、Chromatic 與任意 JSON artifact evidence；當目前 Git 或 CI identity 可解析時套用 repository／commit 政策，並保存進 hash-chain ledger。只有明確要求時，才會把已去敏結果發布到 GitHub Checks 或 allowlist webhook。外部 evidence 可以支援審查，但永遠不能核准 Taste Lock 或 visual baseline。

創作層決定介面應該呈現什麼感受；驗證層證明最後的實作仍屬於這個決定。

## 為什麼使用它

多數 AI UI 工作流在產生程式碼後就結束。`Axion Designer` 會繼續走完檢視與維護：

1. **先定方向，再做裝飾** — Codex 先理解產品、受眾、任務、限制、資訊層級與響應式優先順序，不會隨機套用流行顏色。
2. **實際產品程式，不是分離的 mockup** — 它在現有前端技術棧中工作、重用既有元件，並查看真正渲染出的桌面與手機畫面。
3. **後續修改仍守得住品味** — Taste Lock 記錄核准的視覺身份及語意 token 綁定。內容可以正常成長；悄悄改變產品風格的修改會成為可審查的 finding。
4. **提供證據，不是假裝客觀的美感分數** — token 結構、對比、原始碼漂移、無障礙與截圖由程式檢查；主觀評論維持建議性質。
5. **參考圖能落成可維護程式** — 來源、授權範圍、畫面區域、真實元件、預定修改檔、瀏覽器認證 pixels 與最大剩餘落差會保持相連並可機械審查。複製進來的圖片可以 review，但不能成為 complete。

## 直接看證明

執行 `npm run demo` 可以重現 CLI 證明：它會在暫存工作區注入一個精確的 token 違規，保存失敗報告，套用唯一可確定的 SSOT 修正，最後證明原始碼逐 byte 回到通過狀態。證據包會寫入 `output/market-demo/`。

想直接看影片？31 秒看 Axion [設計自己的官網並抓到自己的對比違規](https://youtu.be/DqWigIbwAy8)，或看 [悄悄走樣的 UI 變成建置失敗](https://youtu.be/gcnKh50jRuk)。

## 快速開始

依賴分成三層：

1. **專案層 Codex skill** — `dk codex init` 只把同版本 `$dk-design` bundle 複製到目前 repository 的 `.agents/skills/dk-design`，不會寫入 Codex 使用者設定、個人 marketplace 或 plugin cache。
2. **核心 CLI** — `dk verify` 的 contract、direction、SSOT 與 source gates 需要 Node.js `>=18.14.1`，沒有 runtime npm 依賴。
3. **完整 gates** — 在目標前端 repository 安裝五個選用套件與 Chromium：

```bash
npm i -D stylelint stylelint-declaration-strict-value@1.10.6 postcss-html @playwright/test @axe-core/playwright
npx playwright install chromium
```

從 npm 安裝，一切都走專案層 runtime：

```bash
# 在既有前端 repository 內
npm i -D axion-designer
npx --no-install dk verify

# 或直接建立受治理的新 UI 工作區
npx --package=axion-designer dk new my-interface
cd my-interface
npm i -D axion-designer
npx --no-install dk codex init    # Codex CLI／桌面版
npx --no-install dk claude init   # Claude Code
npx --no-install dk design init
```

既有專案請先在目標 repository 以 `npm i -D axion-designer` 建立專案層開發依賴，再執行 `npx --no-install dk codex init`（或 `dk claude init`），並確認 `npx --no-install dk codex status` 顯示 `ready`。把 runtime 留在目標 repository 內，複製後的 skill preflight 才能解析同版本 package。（要從原始碼 checkout 開發？改用 `node bin/dk.mjs …` 與 `npm i -D /absolute/path/to/axion-designer`。）接著用 Codex CLI 或 Codex 桌面版開啟該 repository，並明確呼叫：

```text
使用 $dk-design 設計這個產品介面，查看實際渲染的桌面與手機畫面，
修正影響最大的視覺落差，並證明它仍符合選定方向。
```

`dk codex prompt auto|explore|refine|reconstruct|reimagine|verify` 會輸出可直接貼上的 prompt，且一定點名 `$dk-design`。`dk codex context [--json] [--trust-project-config]` 返回有大小上限、有 source 來源的 routes、components、direction、report、App Proof、Reference evidence、authority 與最窄下一步指令。有效但未完成的 Reference chain 會路由到 `reconstruct`；無效 evidence 會先路由到 `verify`。安全預設不會執行 `dk.config.mjs` 或 `dk.config.js`；只有檢視並信任該 repository、且確實需要可執行的專案政策時，才明確加上 `--trust-project-config`。`dk codex mcp --json` 只列出綁定目前 repository 的啟動規格，不會寫設定或啟動常駐程序。

`dk codex init` 會在 `.agents/skills/dk-design/.axion-install.json` 記錄 package 版本、skill 與 runtime 的 SHA-256 digest。`dk codex status` 會驗證複製後的 skill、project-local runtime 與 install receipt 仍彼此一致；receipt 缺漏或不相符時絕不顯示 `ready`。Context 也把最新驗證 report 標為 `current`、`stale` 或 `historical`：current 代表證據符合目前 repository 狀態；stale 代表偵測到 runtime／config／source／token／direction 變更；historical 代表報告仍可追溯，但因 config 未受信、只驗證部分範圍、舊版 report 或缺少可比較 hash，而不能當成目前權威證據。先前通過但 stale／historical 的 report 不等於現在通過，應重跑 `dk verify`。

隔離契約採 fail-closed：

- `agents/openai.yaml` 設定 `allow_implicit_invocation: false`；
- `dk codex init` 只寫 `.agents/skills/dk-design`，不覆寫過期或已自訂的安裝，同版本已存在時可安全重複執行；
- 任何 `dk codex` 指令都不寫 `~/.codex`、`~/.agents`、Codex plugin cache 或個人 marketplace；
- 不需要 `npm link`、全域 package、全域 MCP 或全域 plugin 安裝；
- 其他 repository，以及沒有明確呼叫 `$dk-design` 的既有 Codex 工作不會受影響。

下文為了簡潔仍以 `dk` 代表指令。在 Axion source repository 自身使用 `node bin/dk.mjs`；在另一個目標 repository 使用它的 project-local binary，例如 `npx --no-install dk`。

檢視完成後驗證並鎖定：

```bash
dk design check
dk verify
dk verify --full --require-gates
dk design lock --accept --actor "Design Lead" --reason "已檢視響應式 UI 與 proof 證據"
```

本 repository 也已包含可在本機驗證的 Plugin artifact。Bundled skill 仍只能明確呼叫，而且只作用於該次明確指定的 target repository；Plugin 內建 MCP 刻意維持無狀態，只提供離線 Intelligence。專案 evidence 與寫入仍須經固定 root 的 Project MCP 或 project-local CLI。目前沒有安裝或發布；公開 repository URL 仍是佔位值時，`check:release-identity` 會刻意阻止發布。

既有專案的本機接入方式見[快速開始](docs/quickstart-local.md)；Intelligence 與 Reference → Code 見 [P3 Codex 設計引擎實戰手冊](docs/p3-codex-design-engine.zh-TW.md)。

## 工作流程

```text
路由 → 必要時定形 → 實作 → 看真實畫面 → 證明 → 保存
```

- **路由** — 精修相符的設計、探索新產品、重建有授權的參考圖、執行明確要求的改版，或只驗證現有實作。
- **必要時定形** — 只有在視覺不確定性夠高時，才用相同真實內容比較三個完整概念；小修改不會被擴張成未經要求的重設計。
- **實作** — 用語意 token、真實狀態、響應式優先順序與一個可辨識的招牌特徵完成選定方向。
- **看真實畫面** — 檢查渲染結果，只修正最傷害層級、身份或可用性的 1–3 個問題。
- **證明** — 對方向契約、token SSOT、原始碼、無障礙與截圖執行確定性檢查。
- **保存** — 審查後接受 Taste Lock；後續修改預設守住身份，除非團隊刻意改版。

## 不同程度的人怎麼用

| 你的角色 | 你的操作 | Axion Designer 提供的能力 |
|---|---|---|
| 完全不懂設計 | 說明產品、使用者與最重要的操作，再請 `$dk-design` 建造。 | 把白話需求轉成視覺方向、實作選定版本、展示真實響應式畫面，並具體說明怎麼修。不需要知道色碼或設計術語。 |
| 前端工程師 | 執行 `dk init`，指定頁面或流程，要求建立或精修。 | 在保留框架與元件的前提下補上美術方向、資訊層級、token、響應式狀態、像素檢視與驗證。 |
| 設計師／設計系統團隊 | 匯入或對映 token、要求方向契約、定義品牌規則，並在 CI 使用 strict gates。 | 讓已核准方向能跨 agent 與程式修改攜帶、比較、執行，不把品味壓縮成單一分數。 |

Codex CLI 與 Codex App 讀取的是同一套 `$dk-design` 指示與專案檔案。CLI 適合終端迭代與自動化；App 更適合視覺檢視與對話。產品契約與能力不會因此分叉。

## 核心命令

| 命令 | 用途 |
|---|---|
| `dk codex status [--json]` | 唯讀檢查 repo skill 是否 ready、是否只能明確啟用、runtime／skill digest、install receipt、CLI／桌面版可用性與隔離狀態。 |
| `dk codex init [--json]` | 只把 bundled skill 與 digest receipt 安裝到 `.agents/skills/dk-design`；永不覆寫現有過期或自訂內容。 |
| `dk codex context [--json] [--trust-project-config]` | 建立有大小上限、source-backed 的設計 context；預設不執行專案 JavaScript，信任 repository 後才明確載入可執行 config。 |
| `dk codex prompt [auto\|explore\|refine\|reconstruct\|reimagine\|verify]` | 為選定 lane 輸出明確點名 `$dk-design` 的起手 prompt。 |
| `dk codex mcp [--json]` | 列出目前 repository 的 MCP 啟動規格；不寫 config、不啟動 daemon。 |
| `dk intelligence recommend <brief> [options]` | 離線產生三個可重現且實質不同的方向配方；brief 太薄時明確要求補資訊。 |
| `dk reference add/decompose/map/plan/compare/status/validate` | 建立有授權範圍的 Reference → Code 證據鏈；只有目前且由 ledger 認證的 App Proof case 截圖能達到 `match`／`complete`。 |
| `dk new <dir>` | 複製一個會通過核心檢查、品牌中性的起點。 |
| `dk init` | 在既有 repository 加入設定，不覆蓋專案檔。 |
| `dk design init` | 建立精簡的方向草稿。 |
| `dk design check` | 驗證完整度、核准狀態、token 綁定與 lock 完整性。 |
| `dk design prompt` | 把已核准且未飄移的方向編譯成 model-neutral 實作指示。 |
| `dk design lock --accept --actor <人> --reason <理由>` | 記錄已檢視的身份、語意綁定、負責人與決策理由。 |
| `dk design history` | 驗證並顯示不可靜默改寫的核准 hash chain。 |
| `dk verify` | 執行零依賴核心鏈：contract → direction → SSOT sync → source rules。 |
| `dk verify --full` | 依賴齊備時加入 Stylelint、無障礙與視覺回歸。 |
| `dk proof --app <url> --routes auto` | 對真實 App 跑 route × state × viewport × theme，保存 axe、截圖與 runtime token 證據。 |
| `dk studio [dir] --open` | 開啟唯讀、本機限定的八視圖工作台，包含 Reference 比較、Bridge Connections 與 sandbox preview inspector。 |
| `dk system graph --json` | 建立元件、route、story、token、stylesheet 與證據關係圖。 |
| `dk benchmark --html` | 在隔離 scaffold 實跑十種漂移注入、偵測與逐 byte 復原。 |
| `dk watch` | 增量重查變更檔案，將結果合併到專案 ledger。 |
| `dk build --check` | 驗證 token 產物與 SSOT 一致。 |
| `dk fix --slop --dry-run` | 預覽精確且有 token 依據的機械修正；不代替設計決策。 |
| `dk baseline --accept` | 收納既有技術債，之後只阻擋新增違規。 |
| `dk tokens import <path>` | 把支援的 Tokens Studio 資料搬入 dk 的 DTCG 子集，不補造數值。 |
| `dk report --html` | 不重跑檢查，將最新 ledger 轉成可分享報告。 |
| `dk doctor` | 顯示完整 gates 缺少的依賴與安裝命令。 |
| `dk bridge init` | 建立 repository-owned 整合 manifest，不覆寫既有檔案。 |
| `dk bridge doctor` | 預檢角色所需的 adapter lifecycle、明示 permission grants 與 `*Env` 變數引用。 |
| `dk bridge sync [id ...] [--publish]` | 收集並驗證外部 evidence；只有明確要求才發布到 sinks。 |
| `dk bridge status [--require-sinks]` | 驗證 provider status、ledger 完整性、freshness、trust、repository／commit binding 與 required connections；可明確要求 required sink receipts fail closed。 |

終端、JSON、精簡 summary、HTML 與 SARIF 共用同一份結果。Exit code 固定為：`0` 通過、`1` 觸發政策 finding、`2` 用法或設定錯誤。

## 系統檢查什麼

預設核心只需要 Node.js `>=18.14.1`：

```text
tokens.json
   ├─ contract    結構 · alias · 命名 · 必要角色 · 對比
   ├─ direction   核准身份 · 語意綁定 · Taste Lock
   ├─ ssot-sync   token 產物與來源一致
   └─ slop        寫死值 · 泛用預設 · 自訂品牌規則
```

選用的完整 gates 再加入：

- **css-strict** — Stylelint 政策
- **a11y** — Playwright 與 axe 的渲染後無障礙檢查
- **visual** — 需要明確接受 baseline 的截圖回歸

若設定 [`proof`](docs/app-proof.md)，`a11y` 不再只掃 `file://` HTML，而會對已啟動的真實 Web App 執行 route × state × viewport × theme 矩陣。每個未完成案例都會阻擋，實際 coverage 也會寫入 JSON ledger。

要求執行的 gate 不會靜默消失。缺少前置條件時會標為 incomplete；加上 `--require-gates` 後，未完成的檢查會讓 CI 失敗。

## 既有專案與 CI

```bash
dk init
dk design init
dk build
dk verify --full --require-gates
dk design lock --accept --actor "Design Lead" --reason "已檢視響應式 UI 與 proof 證據"
```

成熟專案若已有技術債，先用 `dk baseline --accept` 建立棘輪。接著在 `dk.config.mjs` 加入宣告式品牌規則，再把 `--sarif`、`--json` 或 `--summary` 接到 CI。repo 也附帶 composite [GitHub Action](action.yml)，引用座標為 `fingertipshq/axion-designer`。

SARIF、code scanning、review comment、machine summary 與 CI 順序見[整合說明](docs/integrations.md)。七個 adapter、MCP、信任政策、custom adapter 與 CI 範本的實際設定見 [Axion Bridge 實戰手冊](docs/axion-bridge.md)。

## 能力邊界

- CLI 不會呼叫模型。Codex 負責創作；CLI 保存契約並驗證可重現的事實。
- Codex 整合只作用於目前 repository，且只能明確啟用。Axion 不安裝到使用者層 Codex 或 agent 目錄；`dk codex mcp` 只會輸出規格。
- Taste Lock 保護核准的身份與綁定語意角色，不宣稱能客觀認證「漂亮」。
- Bridge permission 是應用層 invocation gate，不是作業系統 sandbox；repository-local custom adapter 必須視為可執行程式碼審查。
- Figma、Chromatic、GitHub、preview、artifact 與 webhook evidence 都不能建立設計核准、接受 baseline 或修改 Taste Lock。
- token reader 支援實用的 DTCG 子集，包括 alias、mode、sRGB object-form color 與 dimension；不支援的複合值會明確回報，不會猜測。
- 完整無障礙與截圖 gate 需要文件列出的選用依賴與瀏覽器 runtime。

## 文件

- [AI UI Director](docs/ai-ui-director.md)
- [本機快速開始](docs/quickstart-local.md)
- [架構與設計](DESIGN.md)
- [規則](docs/rules.md)
- [驗收契約](docs/acceptance.md)
- [視覺回歸](docs/visual-regression.md)
- [整合](docs/integrations.md)
- [Axion Bridge：adapters、MCP、信任模型與 CI](docs/axion-bridge.md)
- [P3 實戰產品指南](docs/p3-product-guide.zh-TW.md)
- [競爭能力比較與市場評估](docs/competitive-positioning.zh-TW.md)
- [貢獻指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)

Axion Designer 是 FingerTips 專案，開發過程由 OpenAI Codex 與 Anthropic Claude 兩個 agent 協作完成。

MIT 授權，見 [LICENSE](LICENSE)。
