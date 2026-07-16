# Axion Designer：Codex 裡的 UI 創作＋穩定閉環

`$dk-design` 不是一組風格模板，也不是只會檢查的 linter。它讓 Codex 先判斷任務屬於局部精修、新產品、明確改版、授權參考圖重建或驗證，再用最短流程完成：

```text
Route → Shape when needed → Build → See → Prove → Preserve
```

想先看可重現的證明，可在 repository 根目錄執行 `npm run demo`：它會在暫存工作區注入一個 token 違規、保存紅燈證據、套用 SSOT 修正並驗證回到綠燈。

## 它實際增加 Codex 什麼能力

在目前 repository 完成 `dk codex init` 後，Codex 得到同版本的單一 skill、CLI、schemas 與 templates，而不是只得到一段提示詞：

- 先讀真實 repo、內容、元件、tokens 與既有方向；
- 用離線 Design Intelligence 把白話 brief 正規化，在資訊足夠時提供三個結構、字體角色、色彩分配與動態都不同的方向配方；
- 新設計必要時比較三個 complete-surface concepts；
- 將有授權範圍的參考圖依序轉成 manifest、視覺拆解、元件對映、重建計畫與 render comparison；
- 把勝出 identity 壓成短 `direction.json`，不把落選方案塞進後續上下文；
- 依 semantic tokens 實作，而不是臨場發明每個色碼與尺度；
- 檢查真實 mobile／desktop pixels，修一至三個最大 fidelity gaps；
- 用 token、source、a11y、visual 與 Taste Lock 證明結果；
- 後續功能修改保留 identity，除非你明確要求 redesign。

## 最短使用方式

先在目標 repository 確認 `dk codex status` 為 `ready`，再於 Codex CLI 或桌面版直接說：

```text
使用 $dk-design，替這個產品建立首頁與主要操作畫面。
先讀現有內容；需要時比較三個完整方向，實作勝出方案，
展示 mobile/desktop 真實 render，最後跑證據並預覽 Taste Lock；
等我明確確認 actor 與 reason 後才能 accept。
```

局部修改要把範圍講清楚：

```text
使用 $dk-design 的 Refine lane，只改善 pricing section 的層級與 mobile 排版。
保留現有 direction 與元件，不要把整頁重做；完成後重跑相關 gate。
```

明確改版：

```text
使用 $dk-design 的 Reimagine lane。保留功能與真內容，
提出三個結構差異明顯的完整畫面概念；我確認後再實作並審查新的 Taste Lock。
```

授權參考圖重建：

```text
使用 $dk-design 的 Reconstruct lane。先登錄參考圖的來源、授權、scope 與 viewport，
完成視覺拆解、現有元件對映與受限重建計畫後才改 source；
最後比較真實 render，只修影響最大的一至三個差異，再跑 App Proof 與 dk verify。
```

只驗證：

```text
使用 $dk-design 的 Verify lane。不要改 policy；先跑 summary，
只修可由證據定位的 findings，最後回報 passed / incomplete / failed。
```

## Codex CLI／桌面版專用入口

Axion 的 Codex 整合是 **project-scoped + explicit-only**，需要 Node.js `>=18.14.1`。從 source checkout 接到另一個目標 repository 時，先用 `npm i -D /absolute/path/to/axion-designer` 建立 project-local runtime，再以 `npx --no-install dk` 執行。五個入口都使用目前 repository 當邊界：

```bash
npx --no-install dk codex status
npx --no-install dk codex init
npx --no-install dk codex context
npx --no-install dk codex prompt auto
npx --no-install dk codex mcp
```

| 入口 | 實際行為 |
|---|---|
| `status [--json]` | 唯讀檢查 `.agents/skills/dk-design`、runtime／skill digest、install receipt、`allow_implicit_invocation: false`、CLI／Desktop 與隔離狀態。 |
| `init [--json]` | 只在目前 repo 建立 `.agents/skills/dk-design` 與 digest receipt；既有內容不同時拒絕覆寫。 |
| `context [--json] [--trust-project-config]` | 產生 12KB budget 內的 source-backed context，包含 Design Intelligence 與 Reference evidence 狀態；預設不執行 `dk.config.mjs`／`.js`，信任 repository 後才明確載入可執行 config。 |
| `prompt [auto\|explore\|refine\|reconstruct\|reimagine\|verify]` | 輸出對應 lane 的起手 prompt，且一定明確包含 `$dk-design`。 |
| `mcp [--json]` | 只輸出綁定目前 repo 的 `dk-mcp` command／args；不寫 Codex config、不註冊 MCP、不啟動 daemon。 |

一個實用起手式是：

```bash
npx --no-install dk codex status
npx --no-install dk codex context
npx --no-install dk codex prompt auto
```

`init` 寫入的 `.agents/skills/dk-design/.axion-install.json` 會綁定 package 版本，以及 skill／runtime 的 SHA-256 digest；`status` 只有在 copied skill、project-local runtime 與 receipt 一致時才回報 `ready`。

上面的 `context` 是安全預設：它不執行專案的 `dk.config.mjs` 或 `dk.config.js`。若輸出為 `requires-trust`，先 review 並信任該 repository；只有需要可執行專案政策時，才明確執行 `npx --no-install dk codex context --json --trust-project-config`。這個旗標可能執行 repository JavaScript，但不會建立跨專案或全域信任。

Report freshness 不是裝飾資訊：`current` 表示 report 與目前 runtime、可信政策、source、tokens、direction／bindings 和 approval head 相符；`stale` 表示其中可比較狀態已改變；`historical` 表示舊證據仍可追溯，但因 untrusted config、partial／legacy run 或缺少 matching hashes／runtime，無法當作目前權威證據。`stale` 或 `historical` 的舊綠燈都必須依 `freshness.reasons` 處理並重跑 `dk verify`。

把第三行輸出的文字貼到 Codex CLI 或桌面版。它會明確點名 `$dk-design`，並要求 Codex 在真實 repository 與真實 pixels 上工作。你也可以直接手寫 `$dk-design`，不必先生成 prompt。

每個啟動的 skill metadata 都將 `allow_implicit_invocation` 設為 `false`，所以沒有 `$dk-design` 就不會套用。`dk codex init` 也不寫 `~/.codex`、`~/.agents`、`/etc/codex`、plugin cache 或個人 marketplace。整套流程不使用 `npm link`、全域 package、全域 MCP 或全域 plugin 安裝，因此不會把 Axion 自動套到其他 repository，或沒有明確呼叫 `$dk-design` 的既有 Codex 工作。

Repository 內已有可驗證的 Codex plugin artifact，但這不代表已安裝或發布。未來從 plugin 明確呼叫 bundled `$dk-design` 時，它可以對使用者明確指定的 target repository 使用同 bundle runtime；preflight 仍會拒絕檔案系統根目錄、home、`CODEX_HOME` 與全域設定範圍。Plugin 內建 MCP 只提供無狀態、離線的 Design Intelligence，不讀寫任何專案；要讀 context、Reference 或驗證證據，必須使用 `dk codex mcp` 產生、固定在明確 project root 的 Project MCP。

## Design Intelligence 與 Reference → Code

白話需求先可以交給離線引擎：

```bash
dk intelligence recommend "B2B 庫存調度介面，要讓班表人員快速發現缺貨並改派" \
  --stack react --density compact --motion subtle --variance 65 --json
```

資訊足夠時回傳三個可區分方向；資訊不足時回傳 `needs-clarification`，不用通用風格充數。這些配方是給 Codex 的決策證據，不是自動美感分數。

授權參考圖則必須經過五階段：

```text
reference-manifest/v1
  → visual-decomposition/v1
  → component-mapping/v1
  → reconstruction-plan/v1
  → reference-comparison/v1
```

`--license unknown` 只允許登錄與 decomposition；授權未釐清前，mapping、planning、reconstruction 與 comparison 都會被擋下。v1 每張 reference 只有一個已登錄 viewport 與一次 required comparison。實作後，先讓 App Proof 以相同 route、state、theme 與 plan viewport 擷取畫面，再使用成功 case 在 `app-proof.json` 內記錄的原始 `screenshot.path`。compare 指令也必須列出 plan 內 **完全相同的一組** `verification.implementationFiles`：

```bash
dk proof --app http://127.0.0.1:3000 --routes /dashboard
dk reference compare dashboard .dk/proof/screenshots/case_<實際-id>.png \
  src/dashboard/Dashboard.tsx src/dashboard/dashboard.css --json
```

比較會綁定 reconstruction plan、App Proof、ledger、case、screenshot、viewport、config/source freshness 與 implementation digests，在可解碼時比對具位置感的 PNG pixels，並偵測把整張參考圖當成全頁 background 等繞過實作的做法。結果可在 Studio 第八個 **Reference** view 以並排與 overlay 審查，並直接顯示 browser capture 是否 attested。只有目前成功 case 的原始路徑能到 `match`／`complete`；任意圖片或同 bytes 複本只能是 `review`。App Proof v2 目前只證明 DPR 1。像素與美感判讀仍是 advisory，也不取代 visual baseline、accessibility、其他 responsive/state coverage 或 `dk verify`。

完整指令、Studio 操作與隔離邊界見 [P3 Codex 設計引擎實戰手冊](p3-codex-design-engine.zh-TW.md)。

## 三種使用者的具體流程

### 完全不懂設計

你只需提供產品做什麼、給誰用、最重要的動作與不能捏造的內容。Codex 會用白話整理問題；只有不同答案真的會改變畫面時才追問，最多三題。

```bash
dk new my-product
cd my-product
dk design init
```

接著把上面的「建立首頁與主要操作畫面」指示交給 `$dk-design`。它會在必要時讓三案使用同一份內容，讓你比較「資訊怎麼排、字體扮演什麼角色、畫面密度、形狀、色彩分配與 signature」，而不是要求你先懂 hex、grid 或 design token。

你最後要做的只有兩個人類判斷：內容是否真實、方向是否符合產品。難度低，但系統不會假裝替你決定產品策略。

### 會前端，但不會設計

先在既有 repo 執行：

```bash
dk init
dk design init
```

告訴 Codex要做哪個 route／flow、真實資料來源、技術限制與參考。`$dk-design` 會保留 React／Vue／Svelte 等既有 stack，先建立層級與 responsive priority，再把 color/type/spacing/form 映射到 `design/tokens.json` 的 semantic roles，補齊 loading／empty／error／focus／reduced-motion 等必要狀態。

你不需要先選色碼。你要 review 的是：主動作是否明顯、資訊順序是否正確、品牌語氣是否適合。迭代時跑最窄 gate；交付前才跑完整鏈，避免把 8MB JSON 塞回上下文。

### 專業設計師／design-system 團隊

把既有 tokens 匯入或對接 SSOT，要求 `direction.required: true`，再指定 `$dk-design` 使用 Refine 或 Reimagine lane。你仍掌握概念與 policy；系統提供：

- approved identity 的短可版本化規格；
- semantic roles 的 light/dark resolved binding hash；
- redesign 與功能修改可區分的 review boundary；
- screenshot 與 a11y 的真實實作證據；
- SARIF／HTML／JSON ledger 與 CI exit semantics；
- 不會因產品新增內容或畫面就誤報 identity drift 的精準 hash。

它不替代 Figma 或設計評審；它把評審後的決定帶入程式碼與後續 AI 回合。

## 支援範圍

主要範圍是 Web 前端：HTML/CSS、JavaScript/TypeScript、React/JSX/TSX、Vue、Svelte、Astro，以及能由 browser render 的 landing page、dashboard、產品 flow、component surface 與 design system。

方向契約本身是 model-neutral；原則可帶到其他平台，但目前 source scanners、Playwright、axe 與 screenshot proof 以 Web 為完整能力邊界，不應宣稱原生 iOS／Android 已有等價 gates。

## Contract 與命令

```bash
dk design init          # 建短 draft；不覆寫既有檔
dk design check         # 檢查 context / identity / bindings / lock
dk design prompt        # 只在跨 agent handoff 時產生短 prompt
dk design lock          # 預覽 hashes，不寫檔
dk design lock --accept --actor "Design Lead" --reason "已審查 pixels 與 proof" # 建立或明確更新 lock
```

`direction.json` v2 只保留三層：

- `context`：register、product、audience、task、action、最多四個 constraints；
- `identity`：thesis、qualities、signature、composition、responsive、type、color、form、motion、media、avoid；
- `bindings`：4–12 個會實際影響 identity 的 semantic token roles。

三個落選方向、reference research、screens、states 與 review coverage 分別留在探索目錄、route/spec 與 Playwright/config，不再讓產品越大、每次 prompt 越長。

## Taste Lock 到底鎖什麼

```text
directionHash = normalized approved identity
bindingHash   = selected role + token path + resolved light/dark values
```

改 thesis、signature、composition、type、color 或 form 會 drift；改到已綁 accent／font／spacing／radius 的解析值也會 drift。產品描述、受眾、constraint 的成長不會誤觸 identity lock；真正造成的 source、a11y 或 pixels 變化仍由各自 gate 檢查。

這不是「美感 hash」，也不是 pixel baseline。它只回答：這次功能工作是否偷偷改了核准的產品身份。

## CLI 與 Codex 桌面版有差嗎

核心能力、skill、方向契約與 CLI 證據相同：

- **Codex CLI**：較適合 shell、CI、批次與快速讀 JSON/SARIF。
- **Codex 桌面版**：較適合直接看概念圖、browser preview、screenshots 與並排差異。

兩者都從目前 repository 的 `.agents/skills/dk-design` 發現同一個 skill，並都要求 prompt 明確呼叫 `$dk-design`。可以先用 `dk codex status`、`context` 與 `prompt` 在終端準備，再把同一 prompt 交給 CLI 或桌面版。差異是操作介面，不是設計能力或 Taste Lock 語意。

## 必須保持的誠信邊界

- AI critique 是 advisory；只有可重現證據能擋 CI。
- `incomplete` 或 requested gate skipped 不等於 pass。
- 不捏造 metrics、客戶、引言、產品能力、來源或品牌資產。
- 不為綠燈關規則、降 severity、加 ignore、接受 debt 或移除 target。
- 不在沒有 intentional redesign 權限時更新既有 lock 或 visual baseline。
- 參考只抽象關係與原則，不複製 proprietary prompts、code、assets、pixels 或 trade dress。

最重要的產品差異不是「AI 能畫一頁」，而是：

> **它知道何時該創造、何時只該精修，能把選定方向落到真實 UI，並讓之後每次 Codex 修改都不再重新猜品味。**
