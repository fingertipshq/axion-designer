# P3：Codex 設計引擎實戰手冊

這份文件描述目前 repository 已完成、但尚未發布或安裝到任何全域環境的 P3 能力。所有會寫檔的操作都被限制在目標專案；沒有任何步驟需要修改 `~/.codex`、`~/.agents`、Codex plugin cache 或個人 marketplace。

## P3 現在多了什麼

P3 把原本的「設計、實作、驗證、保存」補成兩條可直接使用的能力鏈：

1. **Design Intelligence**：把白話需求正規化，再離線產生三個實質不同、符合技術棧的方向配方。
2. **Reference → Code**：把一至五張有授權範圍的參考圖，轉成可追溯的拆解、元件對映、重建計畫與 render comparison。

Codex 的 `auto` lane 仍可處理一般任務；當 `dk codex context` 發現未完成的 Reference evidence chain，會建議 `reconstruct` lane。Reference artifact 無效或既有驗證證據不可信時，則先建議 `verify`，不會直接拿壞資料改 source。

## 一、沒有設計術語也能提出三個方向

在 Axion source repository 內使用 `node bin/dk.mjs`；已把 Axion 加為 project-local dependency 的目標專案則使用 `npx --no-install dk`。

```bash
node bin/dk.mjs intelligence catalog
node bin/dk.mjs intelligence recommend \
  "給台灣小型餐飲店使用的每日營運儀表板，最重要是快速看異常並處理" \
  --stack react --density compact --motion subtle --contrast high --variance 70
```

你會得到三個方向；每個方向會具體列出結構、字體角色、色彩分配、密度、形狀、動態與一個辨識特徵。三案不只是換色。若需求資訊不足，狀態會是 `needs-clarification` 且不輸出假裝適用的通用方案。

給 Codex 使用時，機器格式較穩定：

```bash
node bin/dk.mjs intelligence recommend \
  "B2B 庫存調度產品，使用者要在高壓情境快速發現缺貨並改派" \
  --stack next --density compact --motion subtle --variance 65 --json
```

它完全離線，不呼叫模型、API 或網路。知識分成 product、style、color、typography、layout、motion、icons、charts、UX 九個領域；這是給 Codex 的決策證據，不是替人類假裝計算「美感分數」。

## 二、把授權參考圖重建成真實元件

### 1. 註冊參考圖與權限邊界

先把 PNG、JPEG 或 WebP 放進目標 repository。每張圖最多 20 MB，一個 manifest 最多五張。

```bash
npx --no-install dk reference add dashboard references/dashboard.png \
  --source "內部設計評審 2026-07-16" \
  --license owned \
  --scope "src/dashboard/**,/dashboard" \
  --viewport 1440x900@1
```

這一步會驗證圖片 magic bytes、尺寸、像素上限與 SHA-256，將資產存到 `.dk/reference/assets/` 的 content-addressed 路徑，並在 manifest 記錄來源、授權、viewport 和允許修改的 route／source 範圍。Symlink、路徑穿越、專案外檔案與不支援格式會直接被拒絕。

### 2. 讓 Codex 產生三份結構化草稿

在 Codex CLI 或桌面版明確說：

```text
使用 $dk-design 的 Reconstruct lane。讀取 dashboard 參考圖及其授權範圍，
先建立 visual-decomposition 草稿，再建立 component-mapping 與 reconstruction-plan；
只修改 manifest 授權的 route 和 source，沿用現有技術棧與元件。
```

Codex 會依 [reference.schema.json](../reference.schema.json) 建立：

- `visual-decomposition/v1`：整體結構、palette、type、spacing，以及每個 region 的像素座標與視覺證據；
- `component-mapping/v1`：每個 region 要重用、調整或建立哪個真實 component；
- `reconstruction-plan/v1`：有依賴順序的 source 修改與驗證步驟。

將三份草稿依序交給驗證器：

```bash
npx --no-install dk reference decompose .dk/drafts/dashboard.decomposition.json
npx --no-install dk reference map .dk/drafts/dashboard.mapping.json
npx --no-install dk reference plan .dk/drafts/dashboard.plan.json
npx --no-install dk reference status --json
```

每一層都和上一層的 SHA-256 綁定。Region 超出畫布、元件沒有覆蓋全部 region、目標超出授權 scope、plan 依賴不存在或缺驗證步驟，都不能進入下一層。

### 3. 實作、App Proof 擷圖、比較、修正

Codex 依 plan 修改真實 DOM／components，不得把整張參考圖當成 full-page background。接著在 `dk.config.mjs` 的 `proof` 宣告同一個 route、state、theme 與名為 `reference` 的 `1440 × 900` viewport，啟動專案 dev server，再執行：

```bash
npx --no-install dk proof --app http://127.0.0.1:3000 --routes /dashboard
```

確認 `.dk/proof/app-proof.json` 為 complete、`.dk/report.json` 為 passed，再讀取成功 case 的原始 `screenshot.path`；請直接使用該路徑，不要複製截圖檔。把該路徑與 plan 的 `verification.implementationFiles` **完整且原樣**列入比較：

```bash
# case id 只是示意；必須使用 app-proof.json 實際記錄的 screenshot.path
npx --no-install dk reference compare dashboard \
  .dk/proof/screenshots/case_0123456789abcdef01234567.png \
  src/dashboard/Dashboard.tsx src/dashboard/dashboard.css --json
```

比較結果會保存在 `.dk/reference/reference-comparison.dashboard.json`，包含：

- reference 與 candidate 的 digest、格式和尺寸；
- App Proof／ledger digest、config/source freshness、route、state、theme、viewport、擷取時間與 screenshot digest；
- 支援時的位置感 PNG pixel statistics；
- 經驗證的 region findings；
- 影響最大的零至三個 delta；
- 全頁背景／整張參考圖重用的 anti-cheat 掃描。

只有「目前、完整、零錯誤、由 ledger 認證」的 App Proof 成功 case 原始截圖路徑，才可能取得 `match` 並讓整條 Reference status 成為 `complete`。任意 repository 圖片、同 bytes 複本或手動 render 仍可留下比較證據，但只能是 `review`。讀取 comparison 時會再次驗 proof、ledger、screenshot、source 與 plan freshness；任一項變舊或被改寫都會失效。

App Proof v2 尚未記錄可變 DPR，runner 的可證明值是 DPR 1；因此 Reference v1 的 capture attestation 只在 `@1` 成立。其他 DPR 可做 advisory comparison，但不能宣稱 browser-attested complete。即使已 attested，comparison 仍不宣稱主觀上必然好看，也不取代 visual baseline、完整 responsive/state coverage 或人工審查。

## 三、在 Studio 直接看差異

```bash
npx --no-install dk studio --open
```

進入 **Reference** 頁：

1. 選擇 reference；
2. 用 Side by side 比較全局構圖；
3. 用 Overlay slider 找 alignment、尺寸與密度落差；
4. 查看 provenance、license、scope、digest、browser capture attestation、stage status 與 top deltas；
5. 在本機 preview 開啟 DOM inspector 並選一個元素；
6. 按產生 repair request，再複製給 Codex。

Repair request 只會引用已驗證的 comparison、被選中的 DOM 線索和授權 scope。Studio 不會自己呼叫 Codex，也不會修改 source；它是本機、唯讀的 review surface。

## 四、Codex CLI 與桌面版怎麼啟動

一般設計：

```bash
npx --no-install dk codex context --json
npx --no-install dk codex prompt auto
```

參考圖重建：

```bash
npx --no-install dk codex context --json
npx --no-install dk codex prompt reconstruct
```

把 prompt 輸出貼到同一 repository 的 Codex CLI 或桌面版即可。兩個介面使用相同的 `$dk-design`、Intelligence、Reference artifacts、Taste Lock 與 gates；差別只在操作介面。

## 五、Skill、MCP、Plugin 的目前邊界

- **Skill**：`dk codex init` 只複製到目標 repo 的 `.agents/skills/dk-design`，而且 `allow_implicit_invocation: false`；沒有 `$dk-design` 就不套用。
- **Project MCP**：`dk codex mcp --json` 只印出綁定目前 repository 的啟動規格；使用者要明確採用才會啟動。它可提供 context、intelligence、reference status 與 comparison，但所有檔案權限仍固定在該 root。
- **Plugin artifact**：repository 內已有可驗證的 `.codex-plugin/plugin.json` 與 `.mcp.json`，供本機開發與未來發布；目前不執行安裝、cachebuster、marketplace 更新或全域 MCP 註冊。
- **Bundled Plugin MCP**：只暴露無狀態、離線的 `design_recommend` 與 catalog resource，不取得任一專案的讀寫權限。要讀專案 evidence，必須改走明確的 project MCP。

這個雙 MCP 邊界避免「為了讓 Plugin 好用，就讓所有正在執行的 Codex task 自動取得目前專案能力」。

## 六、P3 的完成判準

P3 不是「指令存在」就算完成。驗收時應確認：

```bash
npm run typecheck
npm run test:p3:product
npm test
```

能力判準包括：

- 同一 brief 產生穩定的三方向 JSON，低資訊 brief fail closed；
- Reference 五階段 artifact schema、digest link、scope、source freshness 與 App Proof capture attestation 全部可驗證；任意同圖複本不能假冒 complete；
- Codex context 能辨識 Reference 狀態並路由到 reconstruct 或 verify；
- Studio 能安全顯示對照、overlay 與 scoped repair request；
- MCP 工具只能讀寫固定 project root 或純離線 intelligence；
- package、skill 與 plugin 結構能在本機驗證；
- 所有隔離測試證明 `HOME`、`CODEX_HOME` 與其他 repository 沒有被改動。

`check:release-identity` 和實際發布不屬於這次本機 P3 驗收；在正式 repository URL 尚未決定前，release gate 應繼續刻意阻擋發布。
