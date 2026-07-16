# Axion Designer 實際使用指南

> 對象：完全不懂設計的人、懂前端但不懂設計的人、專業設計師  
> 能力邊界：截至 2026-07 的 repository 實作

## 先講結論：它到底是什麼？

Axion Designer 不是一個只會「生一張漂亮畫面」的網站產生器。它把同一個 Web UI 工作拆成九件事：

1. 用自然語言釐清使用者、任務與內容。
2. 用離線 Design Intelligence 把白話需求轉成三個實質不同的方向配方。
3. 在需求真的需要視覺探索時，比較三個方向再選一個。
4. 必要時把授權參考圖依五階段證據鏈重建成可維護元件。
5. 直接在真正會交付的前端 repository 裡實作。
6. 用 Studio、Inspector 與 System Graph 查「畫面背後是哪個元件、token、檔案與關係」。
7. 用固定規則和真實瀏覽器證明來源、對比、無障礙、畫面與狀態沒有壞。
8. 用 Taste Lock、核准歷史與 CI，防止後續修改悄悄把已選定的設計改掉。
9. 用 Axion Bridge 把 Storybook、Figma、preview、GitHub、Chromatic 與既有 JSON evidence 綁到同一個 commit，不必丟掉團隊原本的工具。

所以它的價值不是「替你猜一個色碼」，而是讓「怎麼做、為什麼這樣做、是否真的完成、之後有沒有走樣」都留在同一個可檢查流程裡。

## 範圍在哪裡？只有網頁嗎？

目前完整能力邊界是**瀏覽器裡執行的 Web UI**，包括：

- HTML、CSS、JavaScript、TypeScript；
- React／JSX／TSX、Vue、Svelte、Astro；
- Landing page、產品網站、Dashboard、後台、表單流程、互動式 Web App；
- 元件庫、Storybook stories、設計 token 與多主題；
- 桌面、平板、手機寬度下的響應式介面。

它目前不等於：

- 原生 iOS／Android UI 的完整設計、建置與原生測試；
- 後端、資料庫、登入、付款或部署平台；
- Figma 的雙向同步或視覺畫布替代品；
- 自動證明「這個設計在主觀上一定好看」。

它可以製作在手機瀏覽器使用的 Web UI，也能檢查手機 viewport；這和產生可送 App Store／Play Store 的原生 App 是兩件事。

## 先把名詞翻成白話

| 名詞 | 白話意思 | 你實際會看到什麼 |
|---|---|---|
| UI | 人操作產品時看到、點到、輸入的介面 | 頁面、按鈕、表單、卡片、導覽列 |
| Repository／repo | 這個產品真正的程式碼資料夾 | `src/`、`package.json`、元件與樣式檔 |
| Token | 不直接到處寫 `#3B82F6`，而是給設計值一個有用途的名字 | `color.text.primary`、`space.4` |
| SSOT | 唯一可信來源；改一處，再編出其他檔 | `design/tokens.json` |
| Direction contract | 把選定的設計方向寫成可檢查資料 | `design/direction.json` |
| Taste Lock | 對「已核准方向」與「語意 token 對應」做指紋 | `design/direction.lock.json` |
| Gate | 一條會明確通過、失敗或標示未完成的檢查 | `contract`、`ssot-sync`、`slop`、`a11y`、`visual` |
| Design Intelligence | 離線把白話 brief 正規化，給 Codex 三個可區分的設計決策配方 | `dk intelligence recommend <brief> --json` |
| Reference evidence chain | 把有授權的參考圖連到拆解、元件、實作計畫與比較 | `.dk/reference/` 內五階段 artifacts |
| App Proof | 在真實瀏覽器逐一打開頁面、狀態、尺寸與主題，再做 axe 無障礙檢查 | `.dk/proof/app-proof.json` |
| Visual baseline | 人工接受過的「正確畫面」截圖；之後逐像素比較 | Playwright snapshots |
| Ledger | 每次驗證留下的完整結果帳本 | `.dk/report.json` |
| CI | 每次 push／PR 自動重跑檢查 | GitHub Actions 或既有 CI |
| Studio | 把方向、證據、系統關係、參考比較、外部連線與改動放在一個本機介面看 | Overview、Direction、Proof、Reference、Connections 等八頁 |
| Inspector | 在預覽裡點一個元素，查看 selector、box、元件與 token 線索 | Studio 的 Live preview |
| System Graph | 從 source 推得 route、component、story、token 與依賴關係 | 可點選的關係圖與 JSON |
| Axion Bridge | 把外部工具的結果轉成同一種、可驗證的 evidence envelope | `design/bridge.json`、`.dk/bridge/ledger.json`、Studio Connections |
| Evidence envelope | 一份帶來源、時間、信任、commit、payload 與 digest 的證據包 | `axion-bridge-envelope/v1` JSON |

你不需要背這些名詞。日常只要記住：「說清楚任務 → 看方向 → 看真實畫面 → 跑驗證 → 明確核准」。

## 四個操作表面分別做什麼

### 1. Codex + `$dk-design`：負責思考與改程式

你用一般中文說明產品、使用者和任務。Codex 依 `$dk-design` 的流程探索方向、實作、看渲染結果、修正，再呼叫 `dk` 做確定性檢查。

它是「會改真實 source 的工作者」，不是只交付一張圖片。

### 2. `dk` CLI：負責可重現的紅綠燈

`dk` 不負責主觀創作。它負責同一份程式今天、本機、CI 都用相同規則判斷：

- token 有沒有缺、編譯產物有沒有漂移；
- 顏色、間距、圓角、字型是否繞過系統；
- 對比、文案、常見 AI slop 是否違規；
- axe 無障礙與視覺回歸是否通過；
- direction 與 Taste Lock 是否一致；
- 指定 gate 缺依賴或沒跑時，是否應該阻擋。

### 3. Axion Studio：負責看懂目前狀態

從目標專案根目錄啟動：

```bash
dk studio --port 4177 --open
```

若不加 `--open`，再自行開啟 `http://127.0.0.1:4177`。Studio 目前是**本機、唯讀控制面**：

- **Overview**：方向是否鎖定、gate 結果、proof 與主要 findings。
- **Direction**：方向身份、語意 token 綁定、現在與核准指紋是否一致。
- **Proof**：發現了哪些 routes／states，哪些真的跑過，以及每條 finding 的檔案與行號。
- **System Graph**：搜尋並點選 route、component、story、token，追它們的關係與 source 證據。
- **Live preview**：選由 Studio 提供的本機 HTML，或輸入自己的 dev server URL；切換 mobile／tablet／fluid。
- **Changes**：目前 Git branch、改動檔案與設計核准歷史。
- **Connections**：Bridge connections 的 required／optional、trust、commit、freshness、最新 envelope 與 ledger 狀態。
- **Reference**：第八個 view；看授權、scope、五階段 artifact 狀態、參考與 render 並排／overlay、top deltas 與受限 repair request。

Studio 不會替你重跑驗證，也不會修改檔案。先在終端執行 `dk verify`，再按 Studio 右上角 Refresh 讀取新帳本。

Studio 預設只綁定 `127.0.0.1`。`--allow-remote` 會將 snapshot、source 線索、graph 與 proof 等 repository evidence API 開放給網路上的來訪者，目前沒有登入或權限層；只能在你確定每個來訪者都可信的隔離網路使用，不得暴露到公開 Internet。

本機 HTML 會在 sandbox iframe 中執行；目前只開放 scripts 與 forms，不開放 `allow-same-origin`、彈窗、下載或頂層導覽。Studio 會在這個受限預覽中注入帶 nonce 的唯讀 Inspector，因此可以點元素看 selector、尺寸、可辨識的 React／Vue／custom-element 線索和 CSS token 線索。外部 dev server 若允許被 iframe 顯示，仍可用來看畫面與互動；但瀏覽器跨來源邊界代表 Studio 不能直接讀取它的 DOM，這時 source 與關係要回到 repository 的 System Graph 看。

### 4. Axion Bridge：負責接上既有工具，但不越權核准

先建立 repository-owned manifest：

```bash
dk bridge init
```

在 `design/bridge.json` 選擇真正需要的 connections。例如本機 Storybook 與 production preview：

```json
{
  "schema": "axion-bridge-config/v1",
  "connections": [
    {
      "id": "storybook-main",
      "adapter": "storybook",
      "source": "storybook-static/index.json",
      "permissions": ["fs:read", "network:storybook"]
    },
    {
      "id": "preview-production",
      "adapter": "preview",
      "required": true,
      "trust": "verified",
      "permissions": ["network:preview"],
      "options": {
        "url": "https://app.example.com",
        "healthPath": "/api/health",
        "expectedOrigin": "https://app.example.com"
      }
    }
  ]
}
```

實際操作：

```bash
dk bridge doctor
dk bridge sync
dk bridge status
dk bridge inspect preview-production
```

**看見什麼：** provider 結果被轉成帶 timestamp、trust、repository／commit binding 與 SHA-256 digest 的 envelope，依序寫進 `.dk/bridge/ledger.json` 的 hash chain；Studio Connections 顯示最新狀態。

**怎麼判斷完成：** required source connections 都 healthy；ledger、freshness、trust、commit 與 artifacts 通過 `dk bridge status`。若有 required sink，發布後再跑 `dk bridge status --require-sinks` 驗 receipt。`bridge.enabled: true` 或 `gates.bridge.enabled: true` 任一設定啟用時，`dk verify --full --require-gates` 也必須通過 Bridge gate。

Bridge 可以把 source envelopes 發布到 GitHub Checks 或 exact-allowlist webhook，但只有明確執行 `dk bridge sync --publish` 才會對外寫入。Figma、Chromatic、GitHub、preview、artifact 或 webhook 的 `approved` 都只是外部 context，不能建立 Taste Lock、接受 visual baseline 或寫入設計核准歷史。完整七個 adapters、MCP、CI 與 custom module 操作見 [Axion Bridge 實戰手冊](axion-bridge.md)。

### P3 Design Intelligence：先把白話需求變成可比較決策

```bash
dk intelligence catalog
dk intelligence recommend \
  "台灣小型餐飲店的每日營運儀表板，店長要快速發現異常並處理" \
  --stack react --density compact --motion subtle --contrast high --variance 70 --json
```

**看見什麼：** 引擎不連網、不呼叫模型，會產生三個在結構、字體角色、色彩分配、密度、形狀、動態與辨識特徵上實質不同的配方。

**怎麼判斷完成：** 資訊足夠時狀態是 ready 且有三案；資訊不足時狀態是 `needs-clarification` 且沒有假造的通用方向。配方是給 Codex 的決策證據，不是客觀美感分數或可盲目複製的 preset。

### P3 Reference → Code：授權參考圖到可維護 source

先要明確呼叫 Reconstruct lane，再登錄來源、license、可修改 scope 與 viewport：

```bash
dk codex prompt reconstruct
dk reference add dashboard references/dashboard.png \
  --source "內部設計評審 2026-07-16" \
  --license owned --scope "src/dashboard/**,/dashboard" --viewport 1440x900@1
```

驗證器強制五階段順序：

```text
reference-manifest/v1
  → visual-decomposition/v1
  → component-mapping/v1
  → reconstruction-plan/v1
  → reference-comparison/v1
```

Codex 完成拆解、元件對映與計畫草稿後，依序交給公開 validator：

```bash
dk reference decompose .dk/drafts/dashboard.decomposition.json
dk reference map .dk/drafts/dashboard.mapping.json
dk reference plan .dk/drafts/dashboard.plan.json
dk reference status --json
```

`--license unknown` 只能登錄與 decompose；在授權釐清前，map、plan、reconstruct 與 compare 都會 fail closed。v1 的每張 reference 只有一個登錄 viewport 與一次 required comparison。這不是聲稱已覆蓋所有 responsive 畫面；其他 viewport 與互動狀態仍要由 App Proof 覆蓋。

實作完成後，先把 App Proof 設成相同 route、state、theme 與 plan viewport 並執行；確認 proof 與 ledger 完整後，從成功 case 取得原始 `screenshot.path`。將它當作 candidate，並把 plan 的 `verification.implementationFiles` 中 **完全相同的一組檔案** 全數列在指令尾端：

```bash
dk proof --app http://127.0.0.1:3000 --routes /dashboard
dk reference compare dashboard .dk/proof/screenshots/case_<實際-id>.png \
  src/dashboard/Dashboard.tsx src/dashboard/dashboard.css --json
```

少列、多列或換路徑都會被拒絕。Comparison 也會綁定 reconstruction plan、App Proof、ledger、case、screenshot、viewport、config/source freshness 與 implementation digests，在可解碼時比對 position-aware PNG pixels，並擋下把參考圖當成全頁 background、overlay 或其他繞過真實元件的 anti-cheat 風險。

**看見什麼：** Studio 第八個 **Reference** view 顯示 provenance、license、scope、stage status、browser capture attestation、side-by-side、overlay slider、top deltas 和受限 repair request。

**怎麼判斷完成：** 五階段 digest chain 都通過，capture 為 `attested`，source freshness 沒有過期，且只修 top 一至三個高影響差異後重跑 App Proof 與比較。只有目前成功 case 的原始 screenshot path 能到 `match`／`complete`；任意圖片或同 bytes 複本只能是 `review`。App Proof v2 目前只證明 DPR 1。像素與美感判讀仍是 advisory，也不取代 visual baseline、accessibility、其他 responsive/state coverage 或 `dk verify`。

### Skill、Plugin 與 MCP 如何不影響其他 Codex 工作

- `$dk-design` 的 `allow_implicit_invocation` 是 `false`；沒有明確呼叫就不套用。
- Repository 內已有可驗證的 plugin artifact，但未安裝、未發布、未寫 plugin cache 或個人 marketplace。
- 未來從 plugin 明確呼叫 bundled skill 時，preflight 可將它綁定到使用者明確指定的 target repository；檔案系統根目錄、home、`CODEX_HOME` 與全域設定範圍仍被拒絕。
- Plugin MCP 只提供無狀態、離線 Design Intelligence，不取得專案權限。
- `dk codex mcp --json` 產生的 Project MCP 才可讀 Codex context、Reference 與驗證 evidence，而且 command 明確綁定單一 project root。

完整 P3 指令與隔離契約見 [P3 Codex 設計引擎實戰手冊](p3-codex-design-engine.zh-TW.md)。

---

## 身分一：我完全不懂程式，也不懂設計

### 你可以得到什麼

你不用先決定 `#F97316`、`16px`、`Inter` 或「Glassmorphism」。你要提供的是產品事實：誰使用、要完成什麼、內容是什麼、不能做錯什麼。系統會把模糊的「幫我做漂亮」轉成可比較方向、可執行頁面與可檢查結果。

### 實際操作步驟 1：先建立一個安全起點

請懂終端的人或 Codex 在空資料夾旁執行：

```bash
dk new my-interface
cd my-interface
dk design init
```

如果目前還沒有正式安裝 `dk`，開發期可使用：

```bash
node /path/to/axion-designer/bin/dk.mjs new my-interface
```

**看見什麼：** 一個可以直接開啟的中性 Web 起點，以及 `design/tokens.json`、`styles/tokens.css`、`dk.config.mjs` 等檔案。它不是成品，也不會冒充你的品牌。

**怎麼判斷完成：** 終端顯示 workspace 已建立；進入資料夾執行 `dk verify` 時，基準線為綠色、exit code 為 `0`。

### 實際操作步驟 2：不用設計術語，寫產品事實

在 Codex 對話裡直接貼：

```text
使用 $dk-design 設計這個 Web 介面。
使用者：第一次使用記帳工具的人。
最重要任務：30 秒內記下一筆支出。
必須有：金額、類別、日期、儲存後的成功回饋。
不能有：假的統計數字、沒有作用的按鈕、看不懂的專業術語。
請先讓我比較真正不同的視覺方向，再實作我選的方向；
請看桌面與手機真實畫面，修正後再驗證。
```

**看見什麼：** Codex 先釐清內容與主要行動；若需求確實需要 art direction，會以相同內容提出三個結構與氣質真正不同的方向，而不是只換三個顏色。

**怎麼判斷完成：** 三個方向都保留同一個核心任務；你能說出每個方向「最先看到什麼、最容易按什麼、氣質有何不同」。若只是把藍色改成綠色，不算完成探索。

### 實際操作步驟 3：用選擇題核准方向

你不必評論 CSS。用這種方式回答：

```text
選方向 B。保留它的單一主操作與大字金額；
不要方向 A 的卡片堆疊；把錯誤提示做得像一般人能看懂的句子。
```

**看見什麼：** 選定方向會被整理進 `design/direction.json`，其中包含產品語境、身份特徵、密度、排版、形狀、動態、禁止事項和語意 token 綁定。

**怎麼判斷完成：** `dk design check` 不再回報契約結構或 token binding 錯誤；direction 狀態是 `approved`。此時只是「方向確認」，還沒有代表成品已驗證。

### 實際操作步驟 4：只看真實畫面，不看示意圖

啟動專案自己的 preview／dev server，再開 Axion Studio 的 **Live preview**。選 Mobile、Tablet、Fluid 並點開主要操作。若選的是 Studio 清單內的本機 HTML，可再開啟 **Inspect DOM** 點選元素；外部 dev server 只用來看畫面與互動，不會暴露 DOM 給 Studio。

**看見什麼：** 真正由程式渲染的頁面，而不是一張不可操作的 mockup。Inspector 會顯示你點到的元素尺寸、selector、可能的元件與 token 線索。

**怎麼判斷完成：** 在手機寬度不需左右捲動；最重要的按鈕可見；表單錯誤與成功回饋確實出現；沒有只有裝飾、不能操作的假控制項。

### 實際操作步驟 5：讓系統說明「哪裡不合格」

執行：

```bash
dk verify
DK_UPDATE_VISUAL=1 dk verify --gate visual
dk verify --full --require-gates
```

第二行只在你已人工看過第一版畫面、準備建立第一份 visual baseline 時執行一次；後續不要帶 `DK_UPDATE_VISUAL=1`。

**看見什麼：** 每一筆問題都有 `ruleId`、嚴重程度、檔案、行號、證據與修正提示。若 Stylelint、Playwright、axe 或 Chromium 沒裝，要求完整 gate 時會顯示 incomplete，而不是假裝通過。

**怎麼判斷完成：** exit code 為 `0`；要求的 gate 都實際執行且沒有 blocking skipped；`.dk/report.json` 的狀態為 passed。只看到「沒有紅字」但 gate 根本沒跑，不算完成。

### 實際操作步驟 6：核准並留下理由

第一次核准可執行：

```bash
dk design lock --accept --actor "產品負責人" --reason "核心記帳流程、手機版與完整 gates 已審查"
dk design history
```

**看見什麼：** `design/direction.lock.json` 與 `design/approval-history.json`。歷史會記錄誰、何時、為什麼核准，以及當時方向與 binding 指紋；有可用 ledger 時也會連結驗證證據。

**怎麼判斷完成：** `dk design history` 顯示 `verified`；Studio Direction 顯示 lock matches；之後有人改變已核准身份或語意色彩，`dk design check`／`dk verify` 會失敗，直到重新審查並提供新的 `--reason`。

### 小白最容易踩的三個坑

1. **只說「做漂亮一點」**：系統仍會做，但你無法判斷漂亮是否服務任務。至少提供使用者、任務、內容和禁忌。
2. **把第一張圖當成完成**：完成條件是可操作、手機與桌面看過、錯誤狀態看過、gates 真跑過。
3. **看到綠燈就等於一定好看**：規則能擋錯誤、漂移與常見粗糙模式，不能代替你的偏好與使用者測試。

---

## 身分二：我懂一點前端，但不懂設計、色碼與視覺系統

### 它能幫你做出好看的頁面嗎？

能顯著提高「有方向、成套、一致、可用」的機率，但不承諾一鍵產生永遠正確的美感。具體原因是：

- 先用同內容比較方向，避免直接把第一個 AI 結果當答案；
- 用用途名稱操作顏色，不要求你憑空選 hex；
- 讓 Codex 在你的真實框架、路由、資料流與既有元件上實作；
- 看真實渲染，逐輪修最大的視覺落差；
- 用 token、對比、source、a11y、visual gates 防止低級錯誤；
- 核准後把身份與語意 binding 鎖住，避免下一次修改風格重抽。

### 實際操作步驟 1：就地接進既有 repo

在前端專案根目錄執行：

```bash
dk init
```

然後檢查 `dk.config.mjs` 的 `targets` 是否涵蓋你的 `src/**/*.{css,scss,html,js,jsx,ts,tsx,vue,svelte,astro}`，並把 `tokens.source` 指到你現有 token 檔；若沒有 token，可先從 `dk new _seed` 的 `design/tokens.json` 取一份中性起點，再依產品調整。

**看見什麼：** `dk init` 會偵測 source glob、建立設定並把 `.dk/` 放進 `.gitignore`；它不覆寫現有程式。

**怎麼判斷完成：** `dk doctor` 能說明環境；`dk build` 能從 token SSOT 產生 CSS；`dk verify` 確實掃到你的 source files，而不是 `filesScanned: 0`。

若舊專案已有大量已知違規，先檢視後再建立棘輪：

```bash
dk baseline --accept
```

這只讓舊債保持可見、但不阻擋；新違規仍會失敗。不要把 baseline 當成修好了。

### 實際操作步驟 2：叫 Codex 保留工程邊界

```text
使用 $dk-design 精修這個現有頁面。
保留目前 React/Vue/Svelte 架構、router、資料流、API contract 與既有元件；
不要為了視覺重寫功能。先盤點現有 design system 與 tokens，
用真實內容提出需要的方向，選定後看 390px 與 1440px 實際渲染，
最後跑完整 gates，逐項修到通過。
```

**看見什麼：** 修改應落在既有 component／style／token source，不是另建一套平行 demo；System Graph 會把常見 imports、component uses、storyFor、route renders 與 tokenUses 顯示出來。

**怎麼判斷完成：** Git diff 沒有無關框架遷移；既有測試仍通過；主要頁面使用既有元件與 token；System Graph 點選重要 route 時能追到實際 component 或 source 證據。

### 實際操作步驟 3：不懂色碼，就只處理「用途」

不要在元件裡選 `#2563EB`。你和 Codex 討論的是：

```text
主按鈕用 accent；一般文字用 text.primary；次要說明用 text.muted；
危險操作用 state.negative；卡片用 surface.raised。
```

對應值只在 `design/tokens.json` 的 light／dark mode 定義，再執行：

```bash
dk build
dk tokens contrast
dk verify --gate contract
dk verify --gate ssot-sync
dk verify --gate slop
```

**看見什麼：** `styles/tokens.css` 由 SSOT 編譯；`contract` 會驗 token 結構、必要 token、未知引用與設定的 contrast pairs；`ssot-sync` 會找出編譯產物漂移；`slop` 會指出 source 裡的 hardcoded color 與其他規則問題。

**怎麼判斷完成：** 元件主要顏色以 `var(--color-...)` 等 token 使用；light／dark 的必要組合都過門檻；手改 generated CSS 而未改 SSOT 時，驗證會確實失敗。

### 實際操作步驟 4：用 Inspector 與 System Graph 找原因

在 Studio Live preview 開啟本機 HTML 或專案 URL。若是 Studio 提供的本機 sandbox preview，按 **Inspect DOM** 後點選「看起來不對」的元素；再到 **System Graph** 搜 component 或 token。外部 URL 可以看，但不能使用 DOM Inspector。

也可輸出 JSON：

```bash
dk system graph --out .dk/system-graph.json
```

**看見什麼：** Inspector 提供 selector、bounding box、attribute、元件線索與 CSS token clues；Graph 提供 route／component／story／token 節點和 imports／uses／renders／tokenUses 等邊，並保留 file／line evidence。

**怎麼判斷完成：** 你能從畫面上的問題定位到負責的 source 或 token，而不是在 DevTools 裡隨機加 CSS；修改後 Graph 關係仍指向既有元件，且 `dk verify` 沒新增繞過 token 的 finding。

System Graph 是無 runtime dependency 的保守索引器，不是完整 AST compiler。動態 import、複雜 metaprogramming 或框架私有慣例可能只顯示部分關係；所有推測都應回到它附的 source 證據確認。

### 實際操作步驟 5：驗證真實 route、互動狀態、尺寸與主題

先啟動你自己的 dev／preview server。快速驗入口與可見同源連結：

```bash
dk proof --app http://127.0.0.1:3000 --routes auto --json
```

正式 CI 應在 `dk.config.mjs` 明列關鍵 routes 與狀態，例如：

```js
export default {
  // tokens / targets / gates...
  proof: {
    baseUrl: 'http://127.0.0.1:3000',
    routes: [
      '/',
      {
        name: 'checkout',
        path: '/checkout',
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
    viewports: [
      { name: 'mobile', width: 375, height: 812 },
      { name: 'desktop', width: 1440, height: 900 },
    ],
    themes: ['light', 'dark'],
    maxCases: 200,
  },
  gates: { a11y: { enabled: true, tags: ['wcag2a', 'wcag2aa'] } },
};
```

執行：

```bash
dk proof --json
```

**看見什麼：** route × state × viewport × theme 每個案例都用獨立 browser context 載入，依宣告執行 click／fill／check／select／press／waitFor，再跑 axe。逐案例 artifact 在 `.dk/proof/app-proof.json`，coverage 也會進 `.dk/report.json`。

**怎麼判斷完成：** 計畫案例數等於完成數、失敗數與 axe 違規數都為 0、quality 為 `clean`；每個案例的 screenshot 實體檔案、尺寸、bytes 與 SHA-256 一致，runtime token union 完整，且認證它的 `.dk/report.json` 也是 passed／exit 0／error 0。server 4xx／5xx、selector 不存在、action 超時、跨 origin／偏離宣告 route、少回案例或缺瀏覽器依賴都必須阻擋。

`routes: 'auto'` 只包含入口與入口當下可見的同源連結。登入後頁面、隱藏 route、多步流程必須明列。App Proof 的此部分證明 axe 與 runtime matrix；逐像素畫面仍由 `visual` gate 負責。

Studio 的 `proven` 不是看到 test 檔或 screenshot 就算數。只有目前 schema v2 artifact 與宣告 matrix／config hash 精確對上、每個 planned case 都有唯一成功紀錄與可驗證 screenshot，coverage 完整、quality clean、違規與失敗為 0、runtime token union 一致、認證 ledger 通過，且證據沒有早於被索引的 source，route 才會升級為 `proven`；否則只會顯示 `discovered`、`evidence-linked` 或 stale／invalid 線索。

### 實際操作步驟 6：建立 visual baseline，再保護它

第一次確認畫面：

```bash
DK_UPDATE_VISUAL=1 dk verify --gate visual
```

之後每次：

```bash
dk verify --full --require-gates
```

只有人工確認差異是有意變更時才更新：

```bash
DK_UPDATE_VISUAL=force dk verify --gate visual
```

**看見什麼：** 第一次產生 baseline；後續 pixel diff 不同會失敗，不會因 AI 說「看起來差不多」而自動接受。

**怎麼判斷完成：** diff 是預期變更、沒有遮擋／溢位／錯字型／錯主題；更新 baseline 前有人工審查與對應變更理由。

### 實際操作步驟 7：放進 CI

在既有 CI 中，安裝完整 gate 依賴與 Chromium後，至少執行：

```bash
dk verify --full --require-gates --summary
```

若啟用 App Proof，CI 必須先用專案自己的方式啟動 server、等 health check 通過，再執行 `dk proof --json`。Axion 不猜測也不管理你的 server lifecycle。

**看見什麼：** terminal／JSON／summary／HTML／SARIF 皆由同一 ledger 產生；PR 可用 exit code `0`／`1`／`2` 決定通過、finding 失敗或用法／設定錯誤。

**怎麼判斷完成：** PR 在新增硬編碼色、方向 drift、token drift、對比或 a11y regression 時確實紅燈；拿掉依賴或沒啟 server 時也不能綠燈。

---

## 身分三：我是專業設計師

### 它不是替代你的判斷，而是把判斷送到 production

專業設計師通常不是缺少畫布，而是缺少一條能回答下列問題的鏈：

- 工程師實作的是否仍是核准方向？
- 某個畫面背後到底用了哪個 component 與 token？
- light／dark、mobile／desktop、error／success 是否都被看過？
- 後續 PR 改動是否悄悄破壞產品身份？
- 誰核准了哪一版、理由和當時證據是什麼？

Axion 把這些問題變成 repository 內的可查資料與 CI 契約。

### 實際操作步驟 1：把設計意圖寫成可驗收的方向

你可以把品牌規範、截圖、內容架構和互動說明交給 Codex，再要求 `$dk-design` 將結果整理為 direction contract。你要審的是：

- `context`：使用者、任務、內容與限制；
- `identity`：構圖、密度、排版、形狀、動態、影像與禁止事項；
- `bindings`：例如 accent、text、surface、positive、negative 對應哪個語意 token。

執行：

```bash
dk design check --json
dk design prompt
```

**看見什麼：** JSON 會分開顯示 direction hash 與 binding hash；`dk design prompt` 會把已 approved 且無 drift 的方向編成實作提示，而不是讓每位工程師自行翻譯形容詞。

**怎麼判斷完成：** 禁止事項具體到可審查，例如「不可用無意義漸層、不可所有內容都放卡片、動態只表達狀態變化」；binding 都指向存在且可解析的 token；不同人讀完能做出同一個設計家族，而不是同一張像素圖。

### 實際操作步驟 2：用同內容做 art-direction review

要求三個方向共用相同內容、資料層級與主要任務。比較下列實際差異：

1. 第一眼焦點與 CTA 順序；
2. 資訊密度與閱讀節奏；
3. 字級／字重角色；
4. surface、邊界與形狀語言；
5. 手機重排方式；
6. loading、empty、error、success 的表達。

**看見什麼：** 可運作的方向候選及其真實渲染，而不是 moodboard 形容詞清單。

**怎麼判斷完成：** 你能以產品任務淘汰方向；選定方案在 390px 與 1440px 都保留同一身份；內容換成真實長度後層級仍成立。

### 實際操作步驟 3：在 Studio 追設計到 source

在 **Direction** 看身份與 bindings；用 **Live preview** 看真實渲染，並在 Studio 提供的本機 sandbox preview 點元素；在 **System Graph** 追 component、story、route 與 token；在 **Proof** 看哪個狀態真的有證據；有授權參考圖時，在第八個 **Reference** view 看五階段鏈、並排、overlay 與 top deltas。

**看見什麼：** 每個 graph node 都帶 file／line；每個 finding 帶證據與修正提示；discovered、evidence-linked 與 proven surface 分開呈現。test source 或普通 screenshot 只能建立線索；只有新鮮、matrix 完整、quality clean、零違規、逐案 screenshot digest 可驗證，runtime token union 與認證 ledger 都一致的 App Proof artifact 才能把 route 標成 proven。

**怎麼判斷完成：** 對每個關鍵畫面，你能回答「哪個元件負責、用哪個語意 token、有哪些 story／state、哪些尺寸與主題已跑」；找不到證據的項目列為待補，不靠口頭保證。

### 實際操作步驟 4：核准的是身份與語意，不是把內容凍死

審查完成後：

```bash
dk design lock --accept --actor "Design Lead" --reason "核准方向、語意 bindings 與 mobile/desktop proof"
dk design history --json
```

**看見什麼：** Taste Lock 對標準化 identity 與已解析的 light／dark bindings 產生指紋；產品文案與一般 context 不會因正常演進就造成 identity drift。核准歷史以 hash chain 串接，刪除、改寫、重新排序會被視為損壞。

**怎麼判斷完成：** history 最新 entry 與 lock head 一致；變更產品文案可以正常通過，但改變核准的 typography／shape／motion identity 或把 accent 重新綁到另一組值會被擋下，要求重新審查。

### 實際操作步驟 5：把設計驗收變成 PR 條件

請工程團隊把完整 verify、App Proof、visual baseline 與 SARIF／HTML 報告接進 CI。設計師審查時看：

- 是否有 requested gate 被 skipped；
- route／state／viewport／theme 是否完整；
- pixel diff 是否有意；
- direction／binding hash 是否 drift；
- approval entry 的 actor、reason 與 evidence 是否正確。

**看見什麼：** 每個 PR 都有可重跑的機器結果，而不是只有一張 Slack 截圖。

**怎麼判斷完成：** 未核准的視覺差異不能合併；核准後 baseline、Taste Lock 與 history 同步更新；同一份 PR 在本機和 CI 得到相同結論。

### 專業設計師仍要自己負責什麼

- 品牌與產品策略是否正確；
- 使用者研究、任務模型與內容策略；
- 三個方向中哪個值得核准；
- 自動 axe 無法涵蓋的完整無障礙人工測試；
- 動畫節奏、文化語境、情緒和原創性等主觀品質；
- Figma library 的治理與設計資產源頭。Axion 目前不提供 Figma 雙向同步。

---

## App Proof、Visual Gate 與人工驗收不是同一件事

| 證據 | 能回答 | 不能單獨回答 |
|---|---|---|
| Source／token gates | 是否繞過 SSOT、寫死值、用了禁用模式 | 畫面是否真的沒遮擋 |
| Contrast gate | 指定前景／背景配對是否達門檻 | 所有實際疊色與透明度情境 |
| App Proof + axe | 真實 route/state/viewport/theme 是否載入並通過自動無障礙規則 | 主觀美感與所有 WCAG 人工項目 |
| Visual gate | pixels 是否相對人工 baseline 改變 | 改變是否符合產品策略 |
| Reference comparison | 授權、plan、source freshness、尺寸、可解碼 PNG 的位置像素與 anti-cheat 風險 | candidate 是否為真實瀏覽器 capture、無障礙、所有 responsive 狀態或主觀觀感 |
| Studio／Inspector／Graph | 問題與 source、component、token 的關聯 | 自動修改或保證 graph 推論完整 |
| Axion Bridge | 外部 evidence 是否新鮮、完整、綁定目前 commit，ledger 是否未被竄改 | 外部 provider 是否代表人已核准設計 |
| 人工 review + Taste Lock | 哪個方向被誰以何理由核准 | 未執行的瀏覽器案例 |

高品質 UI 需要這些證據疊加，而不是選一個取代其他全部。

## 用 benchmark 驗證「會不會真的擋」

產品維護者可執行：

```bash
dk benchmark
dk benchmark --html .dk/reports/p3-benchmark.html
```

它會在作業系統暫存目錄複製內建 scaffold，依序注入十種真實 drift，再用公開 `dk verify --json --no-cache` 檢查是否抓到預期 rule、還原原始 bytes 並重新驗證為綠色。案例包括：硬編碼色、scale 外間距、常見 AI 預設字型、lorem、虛榮數字、compiled CSS drift、identity drift、binding drift、unknown token 與對比 regression。

**看見什麼：** detected／recovered、unexpected clean findings、median／p95 latency 與 proof hash。

**怎麼判斷完成：** `10/10 detected`、`10/10 recovered`、`0 unexpected findings` 且 status 為 passed。

這個 benchmark 證明 drift detector 的可重現性，不評比 AI 生成畫面的主觀美感、終端使用者任務成功率，也不等於 Chromatic 等雲端多瀏覽器平台的規模。

## 最後的完成定義

不論你是哪一種角色，一個 UI 工作至少同時滿足以下條件才算完成：

1. 真實內容與核心任務明確，不靠 lorem、假數字或無作用控制項撐畫面。
2. 方向已核准，direction contract 與語意 token bindings 有效。
3. 桌面與手機真實渲染已看過，主要流程、錯誤與成功狀態可操作。
4. `dk verify --full --require-gates` 的必要 gate 真的執行並通過。
5. 關鍵 App Proof matrix 完整，visual diff 經人工判讀。
6. Taste Lock 與 approval history 一致，理由可追溯。
7. CI 能重現相同結果，下一個 PR 無法靜默把它改壞；若採用 Bridge，required external evidence 也必須綁定同一 commit 並通過 ledger audit。
8. 若使用參考圖，五階段 digest chain、授權 scope、單一 v1 viewport/comparison、plan 實作檔案、source freshness 與 App Proof capture attestation 都必須有效；只有目前成功 case 的原始 screenshot path 能完成，任意圖片或複本只能供 review。像素與美感 comparison 仍是 advisory，不得取代 accessibility、其他 responsive/state coverage、visual gate 或 `dk verify`。

更細的設定見 [P3 Codex 設計引擎](p3-codex-design-engine.zh-TW.md)、[App Proof](app-proof.md)、[AI UI Director](ai-ui-director.md)、[驗收契約](acceptance.md)、[視覺回歸](visual-regression.md) 與 [Axion Bridge](axion-bridge.md)。
