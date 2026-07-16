# DESIGN — dk 的核心設計

> **讓 AI 大膽創造，讓機器精確證明，讓核准後的 identity 不再漂移。**

dk 不把「模型覺得漂亮」包裝成客觀分數。它把主觀創作與可重現證據分開，再以一份極小方向契約接起來。

## 三位一體

| 力量 | 做什麼 | 不做什麼 |
|---|---|---|
| **高效率** | 先路由任務；小修改保留現有 identity，只在新產品、改版或高度不確定時探索 | 不讓每次任務重讀落選方案、全站 screens 或重複規則 |
| **AI 創造性** | 同內容比較真正不同的完整畫面方向，選一個 thesis 與一個有功能的 signature | 不把換色當方案，不以固定 preset 取代判斷 |
| **穩定度** | token SSOT、真實 pixels、決定性 gates、directionHash＋bindingHash | 不以美感評分擋 CI，不為綠燈偷換 lock、baseline 或 policy |

## 一個 skill，五條 lane

[`$dk-design`](skills/dk-design/SKILL.md) 是唯一 Codex 入口：

- **Refine**：局部修改或 Taste Lock matched；守住身份，不重生整頁。
- **Explore**：全新產品或方向真的未決；同內容比較三個完整畫面概念。
- **Reconstruct**：只對一至五張已登錄、有授權 scope 的參考圖工作；依五階段證據鏈重建成真實 DOM 與元件。
- **Reimagine**：使用者明確要求 redesign；允許改 identity，但舊 lock 在審查前仍會擋。
- **Verify**：只稽核或處理 failing gate；直接讀證據，不展開創意流程。

共同主線只有：

```text
Route → Shape when needed → Build → See → Prove → Preserve
```

概念生成是條件式：品牌／影像導向或視覺不確定性高時，可先用 image generation 做 complete-surface concepts；高頻產品介面優先用可渲染的輕量 boards。兩者都必須使用相同真內容，不能只做 mood fragment。

## Design Intelligence 是離線決策層

`dk intelligence recommend <brief>` 將使用者白話需求正規化，根據 product、style、color、typography、layout、motion、icons、charts 與 UX 九個知識領域，在資訊足夠時產生三個有結構性差異的配方。它不呼叫模型或網路；資訊不足時回傳 `needs-clarification` 而不生成通用方案。

配方是 provenance-backed decision support，不是美感分數、固定 preset 或機器核准。Codex 仍必須把它與真實 repository、內容、元件、tokens 與使用者任務結合。

## 唯一真相來源

| 來源 | 規範什麼 | 是否進每次 AI 上下文 |
|---|---|---|
| `design/direction.json` | 短人類 rationale：context、approved identity、semantic bindings | 是；刻意保持小 |
| `design/tokens.json` | 機器值：color、type、space、radius、motion 等 SSOT | 依任務讀取 |
| `design/direction.lock.json` | 已接受 identity 與 resolved bindings 的 hashes | 是；很小 |
| `.dk/report.json` | token/source/a11y/visual 的可重現證據 | 先讀 summary，必要時才讀明細 |
| `.dk/dk-design/explore/` | 落選方案、研究、暫時 boards | 否；只在探索時讀 |
| `.dk/reference/` | 授權參考圖的 manifest、拆解、mapping、plan 與 comparison | 只在 Reconstruct 或 Reference 狀態判斷時讀 |

每個責任只有一個來源：機器值留在 token SSOT，人類理由留在 compact direction，探索證據留在 `.dk/`。本檔只描述 dk 本身的架構。

## Direction Contract

永久契約只保留會提高下一次生成品質、判斷 identity drift 與解析語意 binding 所需的內容：

```json
{
  "schema": "dk-direction/v2",
  "status": "approved",
  "name": "Control Ledger",
  "context": {
    "register": "product",
    "product": "Release-confidence workspace",
    "audience": ["Release managers"],
    "task": "Decide whether a release should ship",
    "action": "Review blocking evidence",
    "constraints": []
  },
  "identity": {
    "thesis": "A calm editorial evidence ledger for auditable release judgment.",
    "qualities": ["deliberate", "traceable", "restrained"],
    "signature": "A decision seam is interrupted exactly where proof is missing.",
    "composition": "Broad evidence field with a narrow verdict rail.",
    "responsive": "Move the verdict first on mobile; preserve evidence order.",
    "typography": "Serif for judgment, sans for actions, mono for provenance.",
    "color": "Warm paper and charcoal; accent only for blockers and action.",
    "form": "Square ledger structures; compact radius only for controls.",
    "motion": "Explain state changes and honor reduced motion.",
    "media": "No filler imagery.",
    "avoid": ["generic bento dashboard", "decorative glow"]
  },
  "bindings": {
    "accent": "color.brand.accent",
    "surface": "color.surface.page",
    "text": "color.text.primary",
    "displayFont": "font.family.display"
  }
}
```

Runtime validator 與 JSON Schema 都拒絕未知欄位，避免工作階段資料偷偷進入 lock。字串、陣列與 bindings 皆有上限，防止方向契約膨脹成論文。

`dk design prompt` 用於跨 agent／跨模型 handoff；同一個 Codex session 直接讀 compact JSON，避免重複展開相同內容。

## Taste Lock 的精確邊界

Taste Lock 有兩個互補指紋：

```text
directionHash = schema + direction name + register + normalized identity
bindingHash   = role + token path + resolved light value + resolved dark value
```

Identity 會正規化無意義 whitespace；`qualities` 與 `avoid` 這類 set-like arrays 排序後再 hash。因此純格式與排序不會假 drift。

下列資料刻意不進 directionHash：產品描述、受眾、任務文字與 constraints。產品需求可以成長；它造成的 source／a11y／pixel 變化仍由各自 gate 證明。改 thesis、signature、composition、type、color、form 或其他 identity 規則一定 drift；改到已綁定 token 的解析值則由 bindingHash drift。新增無關 token 不會 churn。

`dk design lock` 只預覽；`dk design lock --accept` 才寫檔。第一次方向在真實 pixels 被審查後可建立 lock；既有 lock 只有明確的 intentional redesign 權限才能更新。

## 創意如何收斂

Shape 階段只問會改變結果的問題，最多三題。三案固定同一份內容、功能與 viewport，改變：

- macrostructure 與 focal order；
- type roles 與 density；
- geometry 與 color relationship；
- 一個 earned signature；
- 一個誠實 trade-off。

核准後只把勝出 identity 寫進契約。落選方案不是每次建造都要重讀的產品身份。

Build 順序固定為真內容與 semantics → hierarchy／responsive priority → token-bound system → states／accessibility → signature → restrained motion。沿用既有 stack 與 accessible components；targeted edit 優先於整頁重生。

See 階段只做一次四維 fidelity pass：focal order、composition/responsive、system/states/a11y、signature/genericity。每輪只修一至三個最高槓桿差異；仍有 material drift 才跑第二輪。這些批評是 advisory，不是 blocking score。

## Reference → Code 的五階段完整性

授權參考圖必須依順序通過：

```text
reference-manifest/v1
  → visual-decomposition/v1
  → component-mapping/v1
  → reconstruction-plan/v1
  → reference-comparison/v1
```

每階段的 digest 與 project root 都綁定到上一階段。`--license unknown` 只允許建立 manifest 與 decomposition；mapping、planning、reconstruction 與 comparison 在授權未釐清前 fail closed。v1 將一個 reference 限於一個登錄 viewport 與一次 required comparison，不把單一畫面假裝成完整 responsive coverage。

實作後必須先以相同 route、state、theme 與 plan viewport 執行 App Proof，再把成功 case 的原始 `screenshot.path` 傳給 `dk reference compare <id> <candidate> <implementation-files...>`。檔案參數必須與 plan 的 `verification.implementationFiles` 是完全相同的一組。Artifact 會綁定 reconstruction plan、App Proof、ledger、case、screenshot、viewport、config/source freshness 與 implementation digests；讀取 comparison 時再次驗證 freshness，可解碼 PNG 使用 position-aware pixel metrics，並掃描將整張 reference 當成 background、overlay 或其他繞過真實元件的 anti-cheat 風險。

Studio 的第八個 **Reference** view 只讀顯示 browser capture attestation、side-by-side、overlay、stage status、top deltas 與 scoped repair request。只有目前成功 case 的原始 screenshot path 能到 `match`／`complete`；任意圖片或同 bytes 複本只能是 `review`，source 變更後也必須重跑 App Proof。App Proof v2 目前只證明 DPR 1。像素與美感 comparison 是 advisory evidence，不取代 visual baseline、accessibility、其他 responsive/state coverage 或 `dk verify`。

## 決定性證明

所有 gate 只產生同一種 `Finding`，所有報告只消費同一本 ledger：

```text
contract → direction → ssot-sync → source/slop → css → a11y → visual
```

核心 gate 只需 Node。選配 heavy gates 在依賴存在時真跑；被要求卻 skipped 時，狀態是 `incomplete` 或 `failed`，不是綠燈。

- `dk verify --summary`：agent 預設的 bounded context。
- `dk verify --json`：只有需要 finding-level 證據才讀。
- exit `0`：沒有達門檻 finding，但仍需看 gate status。
- exit `1`：finding blocking 或 required gate 無法完成。
- exit `2`：usage、config 或 token input 錯誤。

Visual baseline 的 tokenHash／directionHash 只是稽核脈絡，不能證明某個 pixel diff 的原因。任何 pixel diff 仍是 error；第一次建立與替換既有 baseline 是兩種不同權限。

## Plugin artifact 與 runtime 共用同一份 bundle

repo／npm package root 同時是 Codex plugin root：

```text
axion-designer/
├── .codex-plugin/plugin.json
├── .mcp.json
├── skills/dk-design/
├── bin/dk.mjs
├── src/
├── templates/
├── direction.schema.json
└── reference.schema.json
```

skill 先解析自己旁邊的 bundled runtime；不要求使用者另外把 `dk` 放進 PATH。npm 版本、plugin 版本、schema 與 CLI 來自同一 artifact，消除雙份 bundle 漂移。在 plugin 裡明確呼叫 bundled skill 並明確指定 target repository 後，preflight 允許同 bundle runtime 對該 repository 工作；檔案系統根目錄、home、`CODEX_HOME` 與全域設定範圍始終被拒絕。

MCP 分成兩種不混用的權限面：

- Plugin MCP 只提供無狀態、離線 Design Intelligence，不得讀寫專案檔案。
- `dk codex mcp` 產生的 Project MCP 才能讀 Codex context、Reference 與驗證 evidence，且啟動參數固定在一個明確 project root。

當前 repository 只包含可驗證的 plugin artifact；不因此安裝、發布、更新 cachebuster、寫入 plugin cache、個人 marketplace 或全域 MCP。`.agents/skills/dk-design` 只是在本 clone 內的 discovery symlink。

## 不可跨越的誠信邊界

- 不捏造 metrics、客戶、引言、產品能力、來源或品牌資產。
- 不為通過而關 rule、降 severity、加 ignore、接受 debt、移除 target／required gate。
- 不在沒有 redesign 權限時更新既有 Taste Lock 或 visual baseline。
- 不以 tokenHash 為 pixel diff 開脫，不以 AI critique 冒充 deterministic proof。
- 不以 Reference comparison 冒充 browser capture、App Proof、accessibility 或完整 `dk verify`。

最終核心不是一條「神奇 prompt」，而是一個可替換模型、可攜工具、可進 CI 的閉環：

> **Route narrowly → create boldly → inspect real pixels → prove mechanically → preserve identity.**
