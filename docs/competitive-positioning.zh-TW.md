# Axion Designer 競爭定位與能力比較

> 比較日期：2026-07-15  
> 比較原則：只比較能力，不把「開源」、價格、品牌聲量或融資當優勢。競品事實以官方文件為準；無法由官方文件證明的負面結論一律標為推論。

## 一句話判斷

如果你要的是「一句 prompt 很快上線一個含後端的 App」，v0、Lovable、Bolt 更完整；如果你要的是「在 Figma／畫布上直接拉改並發布」，Figma Make、Framer 或 Builder Fusion 更順；如果你只要最成熟的雲端視覺回歸與多人 UI review，Chromatic 明顯更強。

Axion Designer 值得用的情境不同：**你已有或準備建立真實 Web codebase，AI 與多人會持續修改 UI，而你需要把方向、實作關係、瀏覽器證據、語意身份、核准理由與 CI 綁成同一條可重現契約。**

這不是「每個單項都第一」的說法；它的競爭力來自六種能力同時存在：

1. 先探索、再選定的 art direction；
2. 真實 repository 內的 code-native build；
3. Studio／Inspector／System Graph 的 source-backed inspection；
4. token、contrast、a11y、visual、App Proof 的 fail-closed proof；
5. 不凍結正常內容的 semantic Taste Lock；
6. hash-chained approval history、CI 與可重跑 drift benchmark。

## 比較符號與判讀限制

- `●`：官方資料或本 repository 有直接、完整的原生能力。
- `◐`：有相近能力，但邊界、用途或完整度不同；必須讀儲存格文字。
- `—`：截至比較日，在所列官方資料中未建立此等價能力。

`—` 不是宣稱產品在所有方案、測試功能或未公開 roadmap 中「絕對沒有」。它表示：本文件不能用官方證據把該能力當成採購理由。

## 多維度能力矩陣

| 能力 | Axion Designer | v0 | Lovable | Bolt | Builder Fusion | Figma Make | Framer | Chromatic |
|---|---|---|---|---|---|---|---|---|
| 自然語言到可執行 UI | ● Codex + `$dk-design` 在真實 repo 實作 | ● UI／full-stack app | ● UI／cloud app | ● Web／full-stack，亦可走 Expo | ● prompt／Figma 到 production code | ● prototype／Web app | ● 可編輯、可發布 site | — 測試與 review，不是 UI builder |
| 接入任意既有 code repo | ● 就地 `dk init`，不搬平台 | ● GitHub repo／monorepo、branch／PR | — 官方 FAQ：不能匯入既有 GitHub repo | ● 匯入既有 GitHub repo | ● GitHub／GitLab／Azure DevOps／Bitbucket／local | — Make 只推到它新建的 repo，單向 | — Framer canvas／hosted site，不輸出自架 HTML | ● 以現有 Storybook／Playwright／Cypress tests 為輸入 |
| 點選元素做視覺修改並回寫 | ◐ sandbox preview 的 Inspector 唯讀定位；修改由 Codex／source 完成 | ● Design mode 即時調 style 並寫回 code | ● preview 選元素、行內改字、標註與 prompt 修改 | ◐ preview／prompt／code flow，非本表所引證的完整 element style panel | ● Visual Editor 產生 PR | ● Point and edit + code editor | ● canvas 選取、手改或 Agent 修改 | — Diff／review，不是 source editor |
| 既有 design system grounding | ● token SSOT、direction bindings、repo component/story/token 關係 | ● repo／package／consumer app／Figma／docs 形成 skill | ● Enterprise React design system、版本與 adherence scan | ● GitHub／npm／Storybook／docs，revision 可同步 | ● component／icon／token indexing + strict style mode | ● Make kits：npm、Figma variables/styles、guidelines | ◐ Framer components／styles／CMS，非任意 app repo DS | ◐ Storybook states 與 MCP 可提供元件脈絡，核心用途是 proof |
| 可查的 source／system 關係 | ● route／component／story／token graph，附 file／line evidence | ◐ Agent 可讀 code／terminal；官方資料未建立等價可查關係圖 | — | — | ◐ 有 design-system component／icon／token index，並非 Axion 的 route/state 全圖 | — | — | ◐ TurboSnap 會分析 Git／bundler dependency graph，但不是完整可探索 UI 系統圖 |
| 固定、可重跑的 UI proof contract | ● source gates + App Proof matrix + axe + Playwright visual gate | ◐ Agent 可操作 browser／terminal 測試；未建立固定身份／proof ledger 等價物 | ◐ 真實 browser 可操作與截圖，但官方明說不適合細微視覺／色差判斷 | — 官方資料未建立等價 a11y + visual CI contract | — 官方資料未建立等價固定 proof chain | — 互動 preview／version history 不等於 CI regression contract | — 發布前 review／optimization 不等於 repo test contract | ● 跨 browser／viewport visual、interaction、axe regression，成熟度最高 |
| 任意 commit 的 token／source 漂移防線 | ● 所有符合 targets 的 source 都可在本機／CI 掃描 | ◐ design-system grounding 會引導生成；未建立同等任意 commit scanner | ◐ connected DS 對每次生成做 adherence scan；不是既有任意 repo | — 官方資料未建立等價 scanner | ◐ Strict Mode 限制 Visual Editor 可選樣式；未證明掃外部 commit | — | — | ◐ visual／a11y regression 擋渲染結果，不檢查 Axion 類語意 token 規則 |
| 核准「設計身份 + 語意 binding」並偵測 drift | ● direction hash 與 binding hash 分離，內容可正常演進 | —* | —* | —* | ◐* token strict mode 有局部 guardrail，不等於 identity lock | —* | —* | —* |
| 設計核准與 PR／CI | ● hash-chain actor／reason／evidence + exit code／JSON／HTML／SARIF | ◐ versions、branch、PR | ◐ project/Git history；非語意核准鏈 | ◐ Git history／branch；非語意核准鏈 | ◐ PR／peer review；非 hash-chained Taste Lock | ◐ file version history；GitHub 單向推送 | ◐ branches、changes review、publish | ● snapshot discussions、reviewers、UI checklist、required PR check |
| 後端、資料庫與一鍵 hosting | — 刻意不做 | ● | ● | ● | ◐ 可連 integrations／Publish，但不是本比較的完整通用 app backend | ● 可加 backend、發布 Web app | ● hosted site／CMS／staging | — |
| 原生 mobile app 路徑 | — Web viewport，不是 native | — 本比較官方能力以 Web／Next.js 為主 | — Web／PWA；無內建商店提交流程 | ● Expo 路徑 | — 本比較能力以 Web 為主 | — Web app／prototype | — website | — Web UI testing |

`*` 推論：檢閱下列官方資料後，未找到與「標準化核准身份 hash + 解析後 light/dark semantic binding hash + 任意後續 commit fail」等價的公開能力。這不是宣稱競品內部完全沒有相關機制。

## 逐家能力比較

### v0

v0 是 Axion 在「AI 直接改真實 codebase」上最接近的廣義對手，而且在 builder breadth 上更強：

- 可匯入任何有權限的 GitHub repo，支援 private repo、monorepo、branch 與 PR；preview 是完整 Node runtime，而非模擬環境。[官方：Git Import](https://v0.app/docs/git-import)
- Design mode 可在 live app 上選元素，調 typography、顏色、間距、border、radius、shadow、文字，再寫回 source；也可把選取元素與截圖交給 prompt。[官方：Design mode](https://v0.app/docs/design-mode)
- Design Systems 2.0 可讀 package、source repo、consumer app、Storybook／docs、Figma，建立可重用 skill。[官方：Design Systems 2.0](https://v0.app/docs/design-systems-2)
- 能建立 API routes、server actions、資料庫整合與 full-stack app。[官方：Full-stack apps](https://v0.app/docs/full-stack-apps)

**v0 勝出的工作：** 一個環境內快速從需求做到 full-stack、預覽、visual edit、PR 與 Vercel deploy。

**Axion 勝出的工作：** 核准後仍要由本機與 CI 證明方向／binding 未 drift，並要一份可攜的 source finding ledger、App Proof coverage、核准 hash chain 與可重跑 mutation benchmark。

**推論：** 上述 v0 官方資料建立了設計系統 grounding、版本與 PR，但未建立 Axion Taste Lock、approval history 與固定 `route × state × viewport × theme` fail-closed ledger 的等價能力。

### Lovable

Lovable 對完全不懂設計的人很強：

- 視覺需求開放時可先產生三個輕量 HTML／Tailwind 方向；也會提供字體、色盤與 layout 選擇。它會在 dashboard、admin、既有 design system 等情境跳過此流程。[官方：Design guidance](https://docs.lovable.dev/features/design-guidance)
- Preview toolbar 可選一個或多個元素後用自然語言要求修改、直接行內改字、畫標註或留下 element-pinned comment。[官方：Edit from the preview](https://docs.lovable.dev/features/preview-toolbar)
- Browser testing 可用真實瀏覽器點擊、填表、導覽、讀 console／network、截圖與切換尺寸；官方也明確說它不適合判讀細微視覺細節或色差。[官方：Browser testing](https://docs.lovable.dev/features/browser-testing)
- Enterprise design systems 支援 React component library、token、版本更新與 generation adherence checks；其他框架目前不是原生支援。[官方：Design systems](https://docs.lovable.dev/features/design-systems)
- 可發布至 live URL，並整合 cloud、access control 與安全掃描。[官方：Publish](https://docs.lovable.dev/features/publish)

重要 codebase 邊界是：GitHub 可以和 Lovable project 雙向同步，但官方 FAQ 仍寫明「不能把既有 GitHub repo 匯入 Lovable」。[官方：GitHub sync FAQ](https://docs.lovable.dev/integrations/github)

**Lovable 勝出的工作：** 非工程使用者從想法、方向引導、cloud app、browser interaction 到發布。

**Axion 勝出的工作：** 不搬離既有 repo／framework，以任意本機或 CI commit 為掃描輸入，並把 source、semantic identity、proof coverage 與核准理由留在 repo。

**推論：** Lovable 的 DS adherence 主要描述「每次 Lovable generation」的檢查；它不等價於 Axion 對任意既有 repo commit 的 direction／binding hash 驗證。

### Bolt

Bolt 的 breadth 很廣：

- 可從既有 GitHub repo 匯入，支援 branch，並持續 fetch 外部更新。[官方：GitHub integration](https://support.bolt.new/integrations/git)
- 可匯入 Figma frame，亦可結合 design system 以真實元件重建；官方提醒 screenshot 路徑與 code 路徑對 design system 的認知不同。[官方：Figma integration](https://support.bolt.new/integrations/figma)
- 可從 GitHub、npm、Storybook 與文件加入 design system，並同步 revision。[官方：Add design system](https://support.bolt.new/building/design-system/add-design-system)、[Sync design system](https://support.bolt.new/building/design-system/sync-design-system)
- 除 Web／full-stack 之外，有 Expo mobile app 路徑。[官方：Expo integration](https://support.bolt.new/integrations/expo)

**Bolt 勝出的工作：** 希望同一 AI builder 涵蓋 Web、backend、GitHub、Figma、design system，甚至 Expo mobile。

**Axion 勝出的工作：** 不需要 builder cloud breadth，但需要精確規則、App Proof coverage、語意身份 drift、可驗核准歷史和 offline/local CI surface。

**推論：** 所列 Bolt 官方資料未建立 Axion 類固定 a11y + visual + Taste Lock + append-only approval chain 的等價 contract。

### Builder Fusion

Builder Fusion 是 Axion 在「既有 production repo + designer/developer 協作」上最強的直接對手：

- 可連 GitHub、GitLab、Azure DevOps、Bitbucket，讓設計師、PM、工程師在 Visual Editor 改 production code，再以 PR 交付。[官方：Projects overview](https://www.builder.io/c/docs/fusion-projects-overview)
- Design System Intelligence 會索引 components、icons、tokens，讓生成使用真實系統。[官方：Design System Intelligence](https://www.builder.io/c/docs/fusion-design-system-intelligence)
- Strict Mode 可把 Visual Editor 限制在已有 token；有 token 的 property 不能輸入任意值，開啟 strict 後沒有 token 對應的 style 甚至不顯示。[官方：Project settings / Strict mode](https://www.builder.io/c/docs/fusion-project-settings#strict-mode)
- Figma CLI 可重用既有 component／library／style，更新 layout 而保留 validation 與 conditional rendering。[官方：Figma to code CLI](https://www.builder.io/c/docs/figma-to-code-builder-cli)

**Builder 勝出的工作：** 非工程角色要在 production repo 上直接做可視修改、重用成熟 design system 並送 PR。

**Axion 勝出的工作：** 要求所有修改來源，包括 Builder／人／其他 agent／手改，都必須經同一個 deterministic scanner；並要對「產品身份」而不只 style property 做 lock，再將 proof 與核准 hash chain 一起保留。

**推論：** Builder Strict Mode 是 Visual Editor guardrail。所列官方資料沒有證明它會對 Visual Editor 外的任意 commit 做 Axion 類 semantic identity hash 與 approval-chain 驗證。

### Figma Make

Figma Make 在設計師已經活在 Figma 時摩擦最低：

- 可從 prompt、Figma frame／library context 建立 functional prototype、Web app 與 interactive UI，也能加 backend。[官方：Create and edit a Figma Make file](https://help.figma.com/hc/en-us/articles/31304485164695-Create-and-edit-a-Figma-Make-file)
- Point and edit 可直接修改選中元素的顏色、間距、文字、radius 等，也可進 code editor。[同上：Point and edit](https://help.figma.com/hc/en-us/articles/31304485164695-Create-and-edit-a-Figma-Make-file)
- Make kits 可包含 npm package、Figma variables／styles 與 guidelines。[官方：Make kits](https://help.figma.com/hc/en-us/articles/39241689698839-Get-started-with-Make-kits)
- 可直接編輯與下載 code。[官方：Code editor](https://help.figma.com/hc/en-us/articles/33649966245783-Edit-the-code-of-a-functional-prototype-or-web-app)

GitHub 邊界很明確：Make 只推到它自己新建的 repo，是 Make → GitHub 單向；GitHub 外部修改不會回來，下一次 push 還會覆寫。[官方：Push to GitHub FAQ](https://help.figma.com/hc/en-us/articles/35463818346647-Push-from-Figma-Make-to-GitHub)

**Figma Make 勝出的工作：** 設計師用現有 Figma context 很快建立、點改、互動與分享一個 prototype／Web app。

**Axion 勝出的工作：** 產品 source 已由工程團隊長期維護，必須保留既有架構與 Git workflow，並以 CI 驗證每個 agent／人的後續變更。

### Framer

Framer 的強項是可視 website canvas、Agent、CMS 與 hosting 一體化：

- Agent 讀取目前 canvas，以 prompt 產生或修改內容、layout、interaction 與 code，也能鎖定選中 section。[官方：How to use Agents](https://www.framer.com/help/articles/how-to-use-agents/)
- 產物保持 canvas 可編輯，可用 branch 安全探索後套回 main，再直接發布。[官方：Build a website with Agents](https://www.framer.com/help/articles/how-to-build-a-website-from-scratch-with-framer-agents/)
- 可直接發布到 `framer.app`／custom domain，支援 staging 與 production。[官方：Publishing](https://www.framer.com/help/articles/publishing-your-framer-website/)
- 官方明確說不提供 HTML export 或 self-host；Framer 的最佳化依賴平台 hosting。[官方：HTML export boundary](https://www.framer.com/help/articles/can-i-export-my-website-to-html-and-self-host-it/)

**Framer 勝出的工作：** Marketing site、portfolio、CMS 內容站，要由設計師直接在 canvas 完成並託管。

**Axion 勝出的工作：** UI 是任意 React／Vue／Svelte／Astro app repo 的一部分，需沿用工程架構、自架部署、跑 source/a11y/visual CI，且要 semantic Taste Lock。

### Chromatic

Chromatic 不是 builder，而是 proof 與 review 標竿：

- 以 Storybook、Playwright、Cypress 的現有 tests 為輸入，平行測試 browser／viewport，涵蓋 visual、interaction 與 axe accessibility。[官方：Why Chromatic](https://www.chromatic.com/docs/)
- 由 cloud browser snapshot 建 baseline，再逐像素 diff；支援 Storybook、Playwright 與 Cypress。[官方：Visual tests](https://www.chromatic.com/docs/visual/)
- accessibility 會以 story baseline 追蹤新舊 axe violations，適合大型設計系統處理既有債務。[官方：Accessibility tests](https://www.chromatic.com/docs/accessibility/)
- UI Review 可指定 reviewers、逐 snapshot 討論、清 checklist，並把 required status check 放進 PR。[官方：UI Review](https://www.chromatic.com/docs/review/)

**Chromatic 勝出的工作：** 大型團隊需要穩定雲端 capture、跨瀏覽器／大量 stories、視覺與 a11y regression、成熟多人 review。

**Axion 勝出的工作：** 在 proof 之前還要做方向探索、source/token 規範、system inspection、semantic identity lock 與核准 hash chain，且希望核心檢查可在本機直接執行。

最誠實的組合不是「Axion 取代 Chromatic」：要求高的團隊可以讓 Axion 管 direction／tokens／source／Taste Lock／App Proof contract，再讓 Chromatic 承擔雲端跨瀏覽器視覺規模與多人 snapshot review。

## 為什麼要用 Axion，而不是只用一般 AI builder？

以下理由完全不依賴開源：

### 1. 它保存的是「選定後的身份」，不只是一次 prompt 記憶

方向先被正規化成 contract；identity 與 semantic bindings 分別 hash。一般文案與產品 context 可以演進，但 typography、shape、motion、surface character 或 light／dark 綁定悄悄改變時會被偵測。

具體操作：`dk design check` 查看 drift，`dk design lock --accept --actor ... --reason ...` 核准，`dk design history` 查決策鏈。

### 2. 它能把「畫面怪」追到真正 source

Studio 的本機 sandbox preview 可注入唯讀 Inspector，提供 DOM／box／component／token 線索；外部 URL 受跨來源限制，不能讓 Inspector 讀 DOM。System Graph 由 source 建 route、component、story、token 與依賴邊，每個節點保留檔案與行號。這讓修正能落到共用 component 或 token，而不是在單頁疊一層補丁。

### 3. Proof 是宣告式 contract，不是 agent 說「我測過」

App Proof 展開 `route × state × viewport × theme`；每案例使用獨立 browser context，執行有界 actions 後跑 axe。server 錯誤、selector 不存在、action 超時、action 後跨 origin／偏離宣告 route、少回案例、依賴缺失或 coverage 自相矛盾都 fail closed。System Graph 也不會把「找到 test 或 screenshot」冒充已執行：只有 schema v2／config hash／完整 matrix 相符、quality clean、零違規、每案 screenshot 的 bytes／尺寸／SHA-256 可驗證、runtime token union 與認證 ledger 一致，且比 source 新的 App Proof artifact 才能把 route 標為 `proven`。

具體操作：開 dev server，執行 `dk proof --app http://127.0.0.1:3000 --routes /,/checkout --json`；完整 artifact 在 `.dk/proof/app-proof.json`。

### 4. 它同時檢查 source、語意與 pixels

只做 screenshot diff 會看不到「硬編碼色雖然目前像素相同，但已繞過設計系統」；只做 lint 又看不到 overflow、遮擋與字型載入差異。Axion 把 token/source、contrast、axe、visual baseline 與 direction drift 放進同一 ledger。

### 5. 核准理由本身也可驗證

`design/approval-history.json` 是 append-only hash chain，entry 包含 actor、reason、時間、action、direction／binding hashes，並可記錄當時 ledger evidence。刪除、改寫或重排會被偵測，不會只剩聊天室裡一句「設計師看過了」。

### 6. 防線本身有可重跑 benchmark

`dk benchmark` 在隔離的 shipped scaffold 依序注入十種 drift，要求 `10/10 detected`、byte restore 後 `10/10 recovered` 與零非預期 findings，並輸出 latency 與 proof hash。它不證明美感，但能證明「宣稱會擋的 drift 是否真的會擋」。

## 市場競爭力評估

### 所在市場不是「另一個 prompt-to-app」

Prompt-to-app、Figma-to-code、visual website builder 與 cloud visual testing 都已各有強者。若 Axion 把自己定位成「比 v0／Lovable／Bolt 更快生成 App」，能力上沒有說服力；它缺後端、hosting、整合式 visual write-back 與 native mobile breadth。

可成立的市場切口是：

> **AI-heavy frontend teams 的 code-first design governance 與 evidence layer。**

也就是：任何模型、工程師、設計師或外部工具都可改 code，但所有改動最後必須通過同一組 repo-owned direction、token、proof、approval 與 CI 契約。

### 分項競爭力

| 市場能力 | 評估 | 原因 |
|---|---|---|
| 一鍵生成與發布 breadth | 弱 | 無內建 backend、database、hosting；v0／Lovable／Bolt／Figma Make／Framer 更完整 |
| 完全小白的上手速度 | 中低 | 能用自然語言，但仍需 repository、Node、preview server 與必要 gates；不是純瀏覽器託管 builder |
| 既有 Web repo 的適配 | 強 | 就地使用既有框架與 Git；source scanner 不要求搬入封閉 project format |
| 設計系統與任意 commit 防線 | 強 | token SSOT、compiled drift、source rules、direction bindings 可由本機與 CI 重跑 |
| 設計到 source 的可解釋性 | 中強 | Studio／Inspector／Graph 提供 evidence；但 Graph 是 heuristic，Studio 目前唯讀 |
| 真實 App proof | 中強 | 宣告式矩陣與 fail-closed coverage 很清楚；但需自行管理 server，且不是雲端多瀏覽器規模 |
| 視覺回歸與多人 review | 中 | 有 Playwright baseline、HTML/SARIF/CI；Chromatic 在 capture 穩定、跨瀏覽器、規模與 review UX 明顯領先 |
| semantic identity governance | 很強、差異化 | identity/binding 分離 hash、content 可演進、append-only approval chain 是少見組合 |
| 主觀設計品質保證 | 中 | 三方向、真實渲染與 anti-slop gates 能提高品質；仍依賴模型、輸入與專業人工選擇 |

### 理想客戶

Axion 最適合：

- 已有 React／Vue／Svelte／Astro 等前端 repo 的產品團隊；
- 多個 AI agents、工程師與外包會同時修改 UI；
- 已有或正在建立 design tokens／component library；
- 設計師希望核准的 identity 不因下一輪 prompt 被重抽；
- PR 必須提出 route/state、a11y、visual 與核准證據；
- 金融、醫療、B2B、enterprise design system 等變更可追溯性成本高的團隊；
- Design Engineering／DesignOps／Frontend Platform 團隊。

它不適合當第一選擇的客戶：

- 只想用一句話做 MVP、資料庫、登入、付款並立刻上線；
- 只在 Figma canvas 工作、不準備維護 production code；
- 只做 Framer 類 marketing site，重點是 CMS 與託管；
- 唯一需求是成熟 cloud visual regression；
- 要原生 iOS／Android 產物與商店發布。

### 目前最大的能力缺口

1. **Studio 是 inspection surface，不是 visual editor。** v0、Builder、Figma Make、Framer 可點選後直接改樣式；Axion 要再交給 Codex 或 source 修改。
2. **沒有 backend／hosting／domain。** 它應和既有 application／deployment stack 組合，而不是假裝是全棧平台。
3. **沒有 Figma 雙向鏈。** 可把參考交給 creation layer，但沒有 library round-trip 或 design-to-code mapping UI。
4. **System Graph 是保守 heuristic。** 它能提供證據，不是完整 AST／runtime topology；高度動態 code 需人工確認。
5. **App Proof 目前不是 cloud cross-browser service。** 核心價值是可審查 matrix 與 fail-closed coverage；規模與 capture 穩定性仍不及 Chromatic。
6. **自動規則不能證明原創性與使用者成功。** benchmark 評的是 drift detection，不是美學排名或 usability study。

### 可防守的獨特組合

單獨看每一項，都已有相近能力：三方向有 Lovable、真實 repo 有 v0／Bolt／Builder、design-system index 有 Builder、visual proof 有 Chromatic、畫布有 Figma／Framer。

Axion 的可防守性在「跨階段契約」：

```text
方向探索
  → 真實 repo 實作
    → source/system inspection
      → deterministic app proof
        → semantic Taste Lock
          → approval hash chain + CI + benchmark
```

競品通常在其中一至三段非常強；Axion 嘗試讓六段使用相同 repo artifacts 與 hashes。這才是它能被稱為「六邊形戰士」的合理版本：不是六個角都贏，而是六個角**互相接得起來**。

## 最終市場判斷

**市場競爭力：在通用 AI builder 市場偏弱，在 code-first design governance 這個窄而高價值的切口偏強。**

最有說服力的銷售主張不是「我也能生成漂亮 UI」，而是：

> 你可以讓任何 AI 或人快速改 UI；Axion 負責證明它仍屬於核准的產品、知道哪個 source 造成結果、跑過哪些真實狀態，並讓下一個 PR 無法把這些證據悄悄抹掉。

若未來補上 Studio visual write-back、Figma／component mapping、更完整 framework graph、雲端或分散式 cross-browser proof，它會從差異化 governance layer 進一步靠近 Builder + Chromatic 的交集；在此之前，應堅守「和 builder／visual testing 工具組合，而非宣稱全取代」的定位。
