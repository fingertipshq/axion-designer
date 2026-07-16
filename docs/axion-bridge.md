# Axion Bridge 實戰手冊

Axion Bridge 是 Axion Designer 的「證據整合骨幹」。它不取代 Storybook、Figma、預覽平台、Chromatic、GitHub 或現有 CI；它把這些系統已經知道的事轉成同一種、可驗證、可追溯的 evidence envelope，再交給 `dk verify`、Studio、CLI、MCP 與 CI 使用。

它解決的是這類斷裂：

```text
Figma 元件／Variables ─┐
Storybook stories ─────┤
Preview commit ────────┤       append-only ledger       dk verify / Studio
Chromatic build ───────┼──▶ Axion Bridge ────────────▶ CI / MCP / GitHub Check
任意 JSON artifact ───┤
GitHub Actions ────────┤
Webhook / GitHub sink ─┘
```

Bridge 的工作是「收集、正規化、驗證、綁定、保存與投遞證據」，不是把外部工具的一句 `approved` 變成 Axion 的設計核准。

## 能力與明確邊界

Bridge 目前提供：

- 七個內建 adapter：`storybook`、`figma`、`preview`、`github`、`chromatic`、`artifact`、`webhook`；
- repository-owned 的 `design/bridge.json`，可跟程式碼一起 review；
- 明示 permission grants、逾時、中止、輸入大小與 freshness 政策；
- repository／commit binding；
- canonical SHA-256 envelope digest 與 append-only hash-chain ledger；
- required connection fail-closed；optional connection 保留為 incomplete；
- CLI、Bridge gate、Studio Connections、Node API 與 MCP 讀取面；
- source adapter 收集後，選擇性發布到 GitHub Checks 或 allowlist webhook；
- repository 內的 custom adapter module。

Bridge 不做以下事情：

- 不建立、接受或更新 Taste Lock；
- 不接受 visual baseline；
- 不寫入 design approval history；
- 不把 Figma、Chromatic、GitHub 或 webhook 的 `approved` 當成人工核准；
- 不把 permission 字串當成作業系統 sandbox。permission 是 runtime invocation gate；custom module 仍是 repository 內的受信任可執行程式碼；
- 不保證外部平台本身可信。它只能證明「哪個 adapter 在何時，以何種信任等級，對哪個 commit 產生了什麼內容」。

## 五分鐘接入

先在已安裝 Axion Designer 的專案根目錄建立 manifest：

```bash
dk bridge init
```

這會建立 `design/bridge.json`，而且檔案已存在時會拒絕覆寫。接著加入一個本機 Storybook index：

```json
{
  "$schema": "https://unpkg.com/axion-designer/bridge.schema.json",
  "schema": "axion-bridge-config/v1",
  "connections": [
    {
      "id": "storybook-main",
      "adapter": "storybook",
      "role": "source",
      "required": true,
      "trust": "linked",
      "source": "storybook-static/index.json",
      "permissions": ["fs:read", "network:storybook"]
    }
  ]
}
```

然後依序執行：

```bash
dk bridge doctor
dk bridge sync
dk bridge status
dk bridge inspect storybook-main
```

最後把 Bridge 放進完整驗證鏈：

```js
// dk.config.mjs
export default {
  bridge: {
    enabled: true,
    source: 'design/bridge.json',
  },
};
```

```bash
dk verify --full --require-gates
```

`bridge.enabled: true` 或 `gates.bridge.enabled: true` 都會啟用 heavy Bridge gate。也可只跑：

```bash
dk verify --gate bridge --json
```

## 設定模型

### `dk.config.mjs`：執行政策

`dk.config.mjs` 適合放全專案政策：

```js
export default {
  bridge: {
    enabled: true,
    source: 'design/bridge.json',
    artifactDir: '.dk/bridge',
    timeoutMs: 30_000,
    maxArtifactBytes: 2 * 1024 * 1024,
    freshnessMs: 24 * 60 * 60 * 1000,
  },
  gates: {
    bridge: { enabled: true },
  },
};
```

| 欄位 | 預設 | 實際作用 |
|---|---:|---|
| `enabled` | `false` | 啟用 Bridge gate；之後一般 `dk verify` 與 `dk verify --full` 都會稽核它。Bridge CLI 本身仍可單獨使用。 |
| `source` | `design/bridge.json` | portable manifest 路徑。 |
| `artifactDir` | `.dk/bridge` | ledger 與 `objects/<sha256>` immutable snapshots 的根目錄；必須留在 repository 內。 |
| `timeoutMs` | `30000` | 每次 adapter lifecycle 的上限。 |
| `maxArtifactBytes` | `2097152` | CLI 內所有 source adapter 共用的單次讀取上限；直接呼叫 Node adapter API 且未傳 `maxBytes` 時，才使用各 adapter 自己的 fallback。所有本機／HTTP 讀取硬上限為 64 MiB。GitHub response 固定 1 MiB；webhook response 預設 1 MiB，可用 `options.maxResponseBytes` 調整但不得超過 64 MiB。 |
| `freshnessMs` | `86400000` | audit 接受 evidence 的最長年齡。 |
| `connections` | `[]` | 可直接 inline；同 id 時會覆蓋 manifest 的 connection。 |

`design/bridge.json` 存在時會自動載入。推薦把連線描述放 JSON、把環境政策放 `dk.config.mjs`。inline `bridge.connections` 會依 `id` 覆蓋 JSON 中的同名項目，適合 monorepo 或 CI 局部調整；但 manifest 內部或 inline 陣列內部的重複 id 都是 malformed config，不會以後值靜默覆蓋。

### `design/bridge.json`：可攜連線清單

每個 connection 的共同欄位：

| 欄位 | 必填 | 說明 |
|---|---|---|
| `id` | 是 | repository 內唯一、小寫、可攜識別字，例如 `preview-production`。 |
| `adapter` | 是 | 七個內建 id，或 custom module 的 manifest id。 |
| `role` | 否 | `source`、`sink`、`both`；預設 `source`。 |
| `enabled` | 否 | 預設 `true`。停用的 connection 不執行，也不算缺 evidence。 |
| `required` | 否 | `true` 時，collect/source 缺證據、過期、repository／commit 不符、信任不足、runtime failure 或 non-passed payload 都會 fail closed。publish/sink receipt 只有在本輪 `sync --publish` 或明確 `status/list --require-sinks` 時 fail closed；一般唯讀 status／gate 保持 deferred incomplete。 |
| `trust` | 否 | 最低接受等級：`untrusted`、`linked`、`verified`；預設 `linked`。 |
| `source` | 否 | adapter 的主要檔案、目錄或 URL。 |
| `module` | 否 | custom adapter 的 repository-local ESM 路徑。 |
| `permissions` | 否 | 明示授權。adapter 宣告但 connection 未授權的 lifecycle 不會執行。 |
| `options` | 否 | adapter-specific、可進版控的非秘密設定。 |

`role` 的行為很具體：

- `source`：`sync` 呼叫 `collect`，把 envelope 寫入 ledger；
- `sink`：只有 `sync --publish` 才會收到本輪 source envelopes；即使 `required: true`，未嘗試 publish 前也只是 deferred incomplete，避免驗證前被迫產生外部 side effect；一旦明確 publish，失敗就 fail closed；
- `both`：先收集自己的 evidence，再作為 sink 接收本輪 envelopes。

只想同步部分來源時：

```bash
dk bridge sync storybook-main preview-production --json
```

要投遞到已設定的 sinks，必須明確加上：

```bash
dk bridge sync --publish
```

沒有 `--publish` 時不會呼叫 GitHub Checks 或 webhook。若同時提供 ids，篩選會套用到 source 與 sink，因此必須至少列出一個 source id 和一個 sink id；最安全的全量發布方式是省略 ids。若只選 source，命令會以 usage error 拒絕，不會靜默回報已發布。

## 七個內建 adapters

先用 runtime 查目前版本與精確 permissions：

```bash
dk bridge catalog
dk bridge catalog --json
```

### 1. Storybook

用途：讀取 Storybook `index.json`，列出 component、story 與 state coverage。`source` 可以是本機 `index.json`、包含它的目錄，或 Storybook base URL。

```json
{
  "id": "storybook-main",
  "adapter": "storybook",
  "required": true,
  "trust": "linked",
  "source": "storybook-static",
  "permissions": ["fs:read", "network:storybook"],
  "options": {
    "allowRedirects": false,
    "maxRedirects": 0,
    "expectedSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

遠端例：

```json
{
  "id": "storybook-deploy",
  "adapter": "storybook",
  "source": "https://storybook.example.com/",
  "permissions": ["fs:read", "network:storybook"]
}
```

成功 envelope 會包含 component／story／state 數量、排序後的 story metadata 與實際 SHA-256。未提供 `expectedSha256` 時，adapter 只證明「在目前 checkout 收集到這些 bytes」，trust 最高為 `self-attested`；若 connection 要求 `verified`，必須由受信任 producer 更新並固定 `expectedSha256`。這個 commit binding 是 collection context，不會把任意舊 `index.json` 冒充成由目前 commit 產生。遠端 URL 預設不跟 redirect；需要時必須明示 `allowRedirects` 和 `maxRedirects`。

### 2. Figma

用途：從本機 Figma JSON export，或 Figma 官方 REST API，讀取 components、component sets、styles、variables 與可辨識的 DTCG tokens。

本機 export 不需要 secret：

```json
{
  "id": "figma-export",
  "adapter": "figma",
  "source": "design/evidence/figma-file.json",
  "permissions": ["fs:read", "network:api.figma.com", "env:FIGMA_ACCESS_TOKEN"],
  "options": {
    "expectedSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

REST API 模式不要把 token 寫進 JSON：

```json
{
  "id": "figma-product",
  "adapter": "figma",
  "required": true,
  "trust": "linked",
  "permissions": ["fs:read", "network:api.figma.com", "env:FIGMA_ACCESS_TOKEN"],
  "options": {
    "fileKey": "AbCdEf123456",
    "includeVariables": true,
    "variablesRequired": false
  }
}
```

```bash
export FIGMA_ACCESS_TOKEN='...'
dk bridge sync figma-product
```

本機 export 和 Storybook 一樣：未固定 `expectedSha256` 時是 self-attested；官方 REST 回應則因受限 host、HTTPS 與 Figma credential 可達 verified，但 metadata 仍明列 `producerCommitProven: false`，不把 Figma 版本假稱為 Git commit 產物。正式網路請求被限制在 `https://api.figma.com`。`includeVariables` 預設開啟；variables API 不可用時預設產生 warning／partial，設 `variablesRequired: true` 才會讓收集直接失敗。

### 3. Preview

用途：實際請求 preview health endpoint，檢查 HTTP 狀態、最終 URL，並從 response header 或 JSON body 讀出 commit。支援的 commit header 包含 `x-axion-commit`、`x-commit-sha`、`x-git-commit-sha`、`x-vercel-git-commit-sha`。

```json
{
  "id": "preview-production",
  "adapter": "preview",
  "required": true,
  "trust": "verified",
  "permissions": ["network:preview"],
  "options": {
    "url": "https://app.example.com",
    "healthPath": "/api/health",
    "expectedOrigin": "https://app.example.com",
    "allowRedirects": false
  }
}
```

CI 會自動把目前 Git commit 當成 `expectedCommit`。health endpoint 必須回傳相符 commit，例如：

```json
{ "status": "ok", "commit": "0123456789abcdef" }
```

若有 expected commit 卻沒有回報 commit、commit 不同、URL binding 不同或非 2xx，adapter 會產生 failed evidence。`expectedUrl` 可做完整 URL binding；`expectedOrigin` 只綁 origin。

### 4. GitHub

用途一：把 GitHub Actions context 收成 evidence。用途二：把本輪 source envelopes 發布成 GitHub Check Runs；最多將 50 筆有安全 repository-relative path 的 findings 轉成 annotations。

只收集 Actions context：

```json
{
  "id": "github-actions",
  "adapter": "github",
  "role": "source",
  "permissions": [
    "env:GITHUB_ACTIONS",
    "env:GITHUB_REPOSITORY",
    "env:GITHUB_SHA",
    "env:GITHUB_RUN_ID",
    "env:GITHUB_RUN_ATTEMPT",
    "env:GITHUB_WORKFLOW",
    "env:GITHUB_REF",
    "env:GITHUB_EVENT_NAME",
    "env:GITHUB_SERVER_URL",
    "env:GITHUB_API_URL"
  ]
}
```

只發布 Checks：

```json
{
  "id": "github-checks",
  "adapter": "github",
  "role": "sink",
  "required": true,
  "permissions": [
    "env:GITHUB_ACTIONS",
    "env:GITHUB_REPOSITORY",
    "env:GITHUB_SHA",
    "env:GITHUB_RUN_ID",
    "env:GITHUB_RUN_ATTEMPT",
    "env:GITHUB_WORKFLOW",
    "env:GITHUB_REF",
    "env:GITHUB_EVENT_NAME",
    "env:GITHUB_SERVER_URL",
    "env:GITHUB_API_URL",
    "env:GITHUB_TOKEN",
    "network:github-api",
    "github:checks.write"
  ],
  "options": {
    "name": "Axion Design Governance",
    "title": "Axion Bridge evidence"
  }
}
```

workflow 必須授權：

```yaml
permissions:
  contents: read
  checks: write
```

並在執行 Bridge 的 step 或 job 明確映射短效 token：

```yaml
env:
  GITHUB_TOKEN: ${{ github.token }}
```

再執行：

```bash
dk bridge sync --publish
```

GitHub sink 只在完整 GitHub Actions context 中工作，token 只讀 `GITHUB_TOKEN`，而且拒絕把未綁定 `GITHUB_SHA` 的 envelope 發布到該 commit。Check Run 是外部呈現，不是 Taste Lock 核准。

### 5. Chromatic

用途：正規化 Chromatic build artifact、webhook payload 或 CI environment，檢查 build URL、repository 與 commit binding，保留 build status 作為 supporting evidence。

從本機 JSON artifact 收集：

```json
{
  "id": "chromatic-build",
  "adapter": "chromatic",
  "source": "artifacts/chromatic.json",
  "permissions": [
    "fs:read",
    "env:CHROMATIC_BUILD_URL",
    "env:CHROMATIC_BUILD_STATUS",
    "env:CHROMATIC_BUILD_NUMBER",
    "env:CHROMATIC_COMMIT",
    "env:GITHUB_REPOSITORY",
    "env:GITHUB_SHA",
    "env:GITHUB_REF_NAME"
  ]
}
```

或直接使用 CI environment：先把同一 connection 的 `source` 移除（有 `source` 時永遠優先讀 artifact），例如：

```json
{
  "id": "chromatic-build",
  "adapter": "chromatic",
  "permissions": [
    "fs:read",
    "env:CHROMATIC_BUILD_URL",
    "env:CHROMATIC_BUILD_STATUS",
    "env:CHROMATIC_BUILD_NUMBER",
    "env:CHROMATIC_COMMIT",
    "env:GITHUB_REPOSITORY",
    "env:GITHUB_SHA",
    "env:GITHUB_REF_NAME"
  ]
}
```

再於 GitHub Actions context 內提供 build vars：

```bash
export CHROMATIC_BUILD_STATUS='passed'
export CHROMATIC_BUILD_URL='https://www.chromatic.com/build?appId=...'
export CHROMATIC_BUILD_NUMBER='42'
export CHROMATIC_COMMIT="$GITHUB_SHA"
dk bridge sync chromatic-build
```

Chromatic evidence 的 `proven` 與 `promotionEligible` 固定為 `false`：單一外部 visual result 沒有覆蓋 Axion 的 route × state × viewport × theme App Proof，因此只能補強證據，不能冒充完整 proof 或設計核准。

### 6. Generic artifact

manifest 中使用短 id `artifact`；它會載入本機或 HTTP JSON，驗 SHA-256、schema、repository 與 commit，並對 payload 做 secret-key redaction。

```json
{
  "id": "design-audit",
  "adapter": "artifact",
  "required": true,
  "source": "artifacts/design-audit.json",
  "permissions": ["fs:read", "network:artifact-origin"],
  "options": {
    "expectedSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "expectedSchema": "acme-design-audit/v1",
    "includePayload": true
  }
}
```

遠端來源：

```json
{
  "id": "remote-audit",
  "adapter": "artifact",
  "source": "https://evidence.example.com/design-audit.json",
  "permissions": ["fs:read", "network:artifact-origin"],
  "options": {
    "allowRedirects": false,
    "expectedSchema": "acme-design-audit/v1"
  }
}
```

若來源 payload 寫了 `"status": "approved"`，Bridge 只保留為來源 context，正規化後不會取得 Axion approval authority。需要最強 binding 時，同時提供 `expectedSha256`，並讓 artifact 內的 commit／repository 與目前 checkout 相符。

### 7. Webhook sink

用途：把 redacted envelope 以 POST 投遞到一個**精確 allowlist** 的 HTTPS endpoint。allowlist 只能是 origin，不能用 wildcard、path 或 query。

```json
{
  "id": "evidence-webhook",
  "adapter": "webhook",
  "role": "sink",
  "required": true,
  "permissions": ["network:webhook-allowlist", "env:AXION_WEBHOOK_ENDPOINT", "env:AXION_WEBHOOK_TOKEN"],
  "options": {
    "endpointEnv": "AXION_WEBHOOK_ENDPOINT",
    "allowlist": ["https://evidence.example.com"]
  }
}
```

```bash
export AXION_WEBHOOK_ENDPOINT='https://evidence.example.com/hooks/axion'
export AXION_WEBHOOK_TOKEN='...'
dk bridge sync --publish
```

request 會帶 `Idempotency-Key`，body schema 為 `axion-bridge-webhook-delivery/v1`；`AXION_WEBHOOK_TOKEN` 必填並以 Bearer header 傳送，但不會進 ledger。endpoint 預設從 `AXION_WEBHOOK_ENDPOINT`（或 `endpointEnv` 指定的變數）取得，避免 Slack／Teams／Discord 類 path token 進版控；只有確認 URL 完全公開時才可明示 `allowInlineEndpoint: true`。缺 endpoint/token 會直接失敗，不會靜默降級成匿名 POST。非測試模式要求 HTTPS。endpoint 必須落在列出的 exact origin，response 必須是 2xx。實際 request 仍使用完整 endpoint；receipt 只保存 origin 與完整 URL 的 SHA-256，不保存 path／fragment，response URL 也採相同的 origin＋指紋表示。

## Permission 與環境變數

permission 採「adapter 宣告需求、connection 明示 grant」：

```text
adapter lifecycle 所需 permissions ⊆ connection.permissions → 允許呼叫
缺少任一 grant                                      → 拒絕呼叫
```

只要 lifecycle 所需的一個 permission 沒 grant，runtime 就拒絕呼叫，不會先試著連網。可使用精確 grant、namespace wildcard（例如 `env:*`）或 `*`；正式 CI 建議使用精確清單，讓 review 看得出能力增加。

重要限制：這是應用層 capability gate，不是 container、seccomp 或網路防火牆。custom adapter 是 ESM，載入時就有 Node.js 程式碼權限；只允許受信任、已 review 的 repository-local module。

秘密只放 environment：

```bash
FIGMA_ACCESS_TOKEN=... \
AXION_WEBHOOK_ENDPOINT=... \
AXION_WEBHOOK_TOKEN=... \
dk bridge sync --publish
```

不要把 token 放在 `source` URL、`options.token`、`options.password` 或任何 inline secret-like key。config validation 會拒絕 URL credentials、常見 secret query parameters 與 inline credential 欄位。Built-in adapter 固定讀：

| Adapter | 環境變數 |
|---|---|
| Figma | `FIGMA_ACCESS_TOKEN` |
| GitHub publish | `GITHUB_TOKEN`，以及 GitHub Actions 自動提供的 repository、SHA、run、workflow、ref、event、server 與 API context vars |
| Chromatic | `CHROMATIC_BUILD_URL`、`CHROMATIC_BUILD_STATUS`、`CHROMATIC_BUILD_NUMBER`、`CHROMATIC_COMMIT`；GitHub context 可補 repository／SHA／branch |
| Webhook | `AXION_WEBHOOK_ENDPOINT`（完整私密 URL）與 `AXION_WEBHOOK_TOKEN`（Bearer auth），兩者必填 |

`options` 內以 `Env` 結尾的值會被 `doctor` 當成環境變數名稱檢查，這個慣例主要提供 custom adapter 使用，例如 `"credentialEnv": "ACME_TOKEN"`；不要存實際值。

## CLI 逐項操作

### `init`

```bash
dk bridge init
```

建立 `bridge.source` 指向的 manifest；永不覆寫，路徑也不得逃出 repository。

### `catalog`

```bash
dk bridge catalog --json
```

列出 built-in adapter 的 version、kind、capabilities 與 lifecycle permissions。新增 grant 前先看這個輸出。

### `doctor`

```bash
dk bridge doctor
```

載入 adapter、依 connection role 核對實際會用到的 lifecycle grants（source=`collect`、sink=`publish`、both=兩者），並檢查 custom `*Env` reference。built-in preflight 不發外部 request，也不寫 Bridge ledger；但 custom module 是可執行 ESM，import 本身必須視為執行受信任程式碼。只有 optional connection 預檢失敗時，aggregate status 是 `incomplete` 且 exit 0；required 預檢失敗才 exit 1。

### `sync`

```bash
dk bridge sync
dk bridge sync figma-product preview-production --json
dk bridge sync --publish
```

依序執行 source collection，驗 envelope，序列化 append 到 ledger。同一 connection 的單次 lifecycle invocation 輸出共用 `runId`；即使回傳多個 envelopes，audit 也會聚合整個 latest run，任一 required envelope 的 `payload.status` 非 `passed` 都會失敗，不能由最後一筆 passing envelope 遮蔽。`--publish` 再把本輪 envelopes 交給 sink。required provider runtime failure 立即讓命令失敗；成功收集後仍會執行 audit。

### `status` / `list`

```bash
dk bridge status
dk bridge status --require-sinks
dk bridge list --json
dk bridge list --require-sinks --json
```

`status` 驗 hash chain、artifact digest、connection `contractDigest`、freshness、最低 trust、可解析的目前 repository／commit identity 與 required policy。publish entry 以核心欄位 `inputEnvelopeDigest` 綁定實際輸入；`--require-sinks` 會要求每個 required sink 對目前 latest source set 的每一份 envelope 都有相符 receipt，缺少或仍指向舊 source 任一筆都 fail closed。`list` 顯示每個 configured connection 的 per-operation latest state，並同樣暴露全域 ledger issues。一般 status／list／gate 不會觸發外部 side effect，尚未 publish 的 pure sink 只顯示 deferred incomplete；`sync --publish` 本身也會用相同的 required-sink 政策收尾。optional connection incomplete 保持可見，不會單獨造成 exit 1；required failure 或 invalid ledger 會失敗。若它經 Bridge gate 轉成 warn finding，使用者顯式設定 `failOn: 'warn'` 時仍會依全局政策擋關。

### `inspect`

```bash
dk bridge inspect preview-production
dk bridge inspect preview-production --json
```

讀出指定 connection 最新且通過 ledger validation 的 envelope，包括 trust、binding、payload、artifacts 與 digest。

### `ingest`

```bash
dk bridge ingest offline-audit ./envelope.json
cat envelope.json | dk bridge ingest offline-audit - --json
```

offline envelope 上限 8 MiB；file 與 stdin 都在讀取過程中硬性截斷，不會先把無界輸入載入記憶體。connection 必須已存在、enabled，且 role 只能是 `source`／`both`。ingest 會載入該 connection 的 collect manifest，要求 envelope 的 provider、kind 與 permissions 完全相符，再驗 schema、canonical digest、freshness、最低 trust、可解析的目前 repository／commit binding 與本機 artifact，通過後才 append。離線 JSON 沒有可驗證的簽章驗證器，因此最高只能宣告 `self-attested`；`verified` connection 必須走 live adapter，不能靠 ingest 自證。append 後立即 audit；required connection 的 non-passed evidence 仍會留在 append-only history，但命令當下 exit 1。

### Exit code

| Code | 意義 |
|---:|---|
| `0` | passed，或只有 optional incomplete（包含 `doctor/status/list/sync/ingest`）。 |
| `1` | required provider、policy 或 ledger failure；optional provider failure 會保持 incomplete。 |
| `2` | 用法、malformed 設定／adapter contract、path 或輸入錯誤。缺 lifecycle grant 則依 connection 是否 required 回 1 或 0。 |

自動化應同時保存 JSON 與 exit code，不要只 grep 終端字串。

## Evidence envelope 與 ledger

每份 `axion-bridge-envelope/v1` 包含：

- `provider` / `kind` / `createdAt` / `expiresAt`；
- `trust.level`、issuer 與 evidence claims；
- `binding.repository` 與 `binding.commit`；
- 本次使用的 permission claims；
- provider status、capability、coverage、findings 與 metadata；
- 可驗證的 repository-relative artifacts；
- canonical SHA-256 `digest`。

ledger 預設位於 `.dk/bridge/ledger.json`。每筆 connection entry 有 `previousHash` 與 `entryHash`，整份 ledger 也有 digest。修改舊 entry、調換順序、刪除中段、偽造 summary 或改 artifact bytes 都會被 status／gate 發現。這是單一 snapshot 內的 tamper-evidence，不是本機 rollback-proof：把整個目錄換回較舊但內部有效的 snapshot，單靠目前檔案無法辨識。因此 CI 必須在外部保存每次完整 artifactDir 與 `headHash`／run identity，才能偵測整體回滾。核心讀寫上限統一為 64 MiB，CLI、Gate、Studio 與 MCP 不會各自套用不同標準；接近上限時 append 會在改檔前 fail closed。若需換期，先把完整 artifactDir 原封不動歸檔，再移除 working ledger 並重新 sync，不能截斷或手改現有 chain。

每筆 connection entry 也會保存 `contractDigest`，把當次 adapter 的 repository-local module graph、`package.json`、存在的 npm／pnpm／Yarn／Bun lockfile、`source`、`options`、`permissions`、`trust` 與 `role` 綁進 evidence contract。graph 由 JavaScript AST 解析；static import/export 與 literal `import()`／`require()` 會被追蹤，computed loader、`require` alias／`module.require`、`eval`、動態 `Function` 與 `createRequire` 直接 fail closed。若 custom adapter 有第三方 bare import，repository 必須有受支援 lockfile。執行時會把同一次 fingerprint 的 repository-local graph 寫入 `.dk/cache/bridge-modules/<contractDigest>/` 並從該 content-addressed snapshot 載入；它刻意位於 Bridge evidence artifactDir 之外，CI 不會連同 ledger 上傳第二份 repository source。長駐 Node process 即使依賴檔改變，也不會把 Node 快取中的舊程式碼綁成新 digest。任何上述設定、依賴或 graph 內容變動後，都必須重新執行 `dk bridge sync`；舊 ledger 若沒有 digest 會顯示 `contract-unbound`，digest 不同則顯示 `contract-mismatch`，required evidence 不會用舊結果通關。

append 時，本機 artifact 會自動複製成 `artifactDir/objects/<sha256>` content-addressed snapshot，ledger descriptor 改指 immutable object；之後正常重建原始 Storybook／JSON 不會破壞歷史 evidence。落盤前會掃描整份 envelope；JSON artifact 也依實際內容 sniff，不信任可偽造的 media type。credential-shaped singular／plural fields、numeric passwords／tokens、access keys，以及任何 hierarchical scheme（包含 HTTP、Postgres、Redis）的 userinfo／敏感 query／fragment URL 命中即 fail closed；只有 `tokenCount`、`passwordLength` 這類明確統計 metadata 可用數字。adapter 原始錯誤訊息與任意錯誤碼不會寫入 ledger，持久化 evidence 只保留 allowlisted code 與固定 withheld 訊息；verifier 也會拒絕舊式 raw error。應先在 producer 輸出去敏、專用的 evidence artifact，不可把 token 原檔當證據。驗證或跨 job 傳遞時必須保存整個 artifactDir，不能只拿 `ledger.json`。

`.dk/bridge` 是可重建的 machine evidence，通常不進版控；CI 若要跨 job 使用，應把含 `ledger.json` 與 `objects/` 的完整 directory 以 artifact 原封不動傳遞，並在消費 job 再跑 `dk bridge status`。

## Trust 模型

Bridge runtime 的三層 trust：

```text
untrusted < self-attested < verified
              ▲
        config 名稱 linked
```

- `untrusted`：有資料，但沒有足夠來源連結；
- `linked`／`self-attested`：adapter 可指出來源、digest 或平台 context，但仍是 provider 的自我陳述；
- `verified`：adapter 的具體條件成立，例如預先固定的 digest、provider 回報的 commit／repository／URL binding，或受限制且已認證的 API response。單純把目前 checkout SHA 填進 envelope 不構成 producer provenance。

connection 的 `trust` 是最低門檻，不是強制改寫 envelope。設定 `verified` 時，收到 self-attested evidence 會失敗。

`verified` 仍然不等於「人已核准設計」。Taste Lock 只能由明確的 Axion design review 流程接受；visual baseline 與 approval history 也有各自的顯式寫入命令。Bridge、adapter、MCP、GitHub Check、Chromatic 或 webhook 都沒有這個 authority。

## MCP 配置

安裝 package 後，可把 `dk-mcp` 加進任何支援 stdio MCP 的 host。以下是通用 JSON 形狀；實際設定檔位置依 host 而異：

```json
{
  "mcpServers": {
    "axion-designer": {
      "command": "npx",
      "args": [
        "--no-install",
        "dk-mcp",
        "--root",
        "/absolute/path/to/your-project"
      ]
    }
  }
}
```

也可直接指定已安裝 package 的入口，避免 PATH／npx 差異：

```json
{
  "mcpServers": {
    "axion-designer": {
      "command": "node",
      "args": [
        "/absolute/path/to/your-project/node_modules/axion-designer/bin/dk-mcp.mjs",
        "--root",
        "/absolute/path/to/your-project"
      ]
    }
  }
}
```

可用 server flags：

```text
--root <dir>
--timeout-ms <ms>
--max-resource-bytes <n>
--max-tool-bytes <n>
--allow-remote-proof
```

Bridge 相關 MCP surface：

- resource `axion://bridge/status`：讀取 sanitized config 與目前 Bridge status；
- tool `bridge_status`：唯讀 status；
- tool `bridge_sync`：目前只接受 `dryRun: true`。只有全部是 built-in adapter 時才執行 `dk bridge doctor` 式預檢；全部通過回傳 `planned`，只有 optional 警告回傳 `planned-with-warnings`，required 預檢失敗回傳 `preflight-failed`，不會把失敗誤報成可執行計畫。Axion 的 preflight 本身不發網路 request、不寫 ledger、不 publish。若有 executable custom adapter，回傳 `manual-review-required`，不 import 該 module。

若要真正同步，請由使用者或 CI 明確執行 `dk bridge sync`。MCP tools 沒有 root override，也沒有 Taste Lock、baseline 或 approval 寫入工具；stdio 的 stdout 專供 protocol frame，診斷只走 stderr。專案的 `dk.config.mjs` 本身仍是受信任的可執行 JavaScript，MCP 會在隔離子進程載入它；不應在 config top level 放網路或寫檔 side effect。

## CI 實戰

先把 Axion Designer 固定在專案 `devDependencies` 與 lockfile。最小可靠順序如下；`--no-install` 可避免 CI 意外下載未鎖定的同名套件：

```bash
npm ci
# `:` 為安全 no-op；需要本機生成物時由受信任 CI 設定覆寫。
: "${AXION_BRIDGE_PRE_SYNC_COMMAND:=:}"
bash -euo pipefail -c "$AXION_BRIDGE_PRE_SYNC_COMMAND"
npx --no-install dk bridge doctor
npx --no-install dk bridge sync
npx --no-install dk bridge status --json > bridge-status.json
npx --no-install dk verify --full --require-gates --json > dk-report.json
```

若有 sink，只有受信任 branch／push job 才執行：

```bash
npx --no-install dk bridge sync --publish
npx --no-install dk bridge status --require-sinks --json > bridge-publish-status.json
```

repository 內四份完整範本的 publish 都預設關閉；只有把 `AXION_BRIDGE_PUBLISH` 顯式設為 `true` 才會進入 trusted main publish（Jenkins 是 boolean，其餘平台要求精確字串）。GitHub Actions 使用 repository／organization Actions variable，GitLab 使用 protected CI variable，Azure 先建立並取消註解可選的 `axion-bridge-secrets` variable group，Jenkins 使用 boolean build parameter。source-only 專案不需開啟這個 publish opt-in；若 source 本身需要 secret，仍只提供該 adapter 的最小 secret。

四份範本也將 `AXION_BRIDGE_PRE_SYNC_COMMAND` 預設為 `:`，並在每個 `sync` 前執行。若 source 是 `storybook-static/index.json`、CI 生成 JSON 或前一 job 的 artifact，請在受信任 CI 設定把它改成 `npm run build-storybook`、下載／restore command，或固定的 repository script。evidence 與 publish 往往是兩個 fresh jobs，所以兩邊都必須產生或取回本機 source；publish 不能用舊 ledger 代替本輪 fresh envelopes。Bridge 歷史 evidence 則必須以完整 `AXION_BRIDGE_ARTIFACT_DIR` 傳遞，才能同時還原 ledger 與 immutable objects。不要把 token 寫進這個 command。

四平台在 doctor／producer／sync 或 publish producer 失敗時仍會執行 status，並以 always artifact/post 保存本輪 JSON；producer 失敗時不會呼叫 sink。GitHub／Azure／GitLab／Jenkins 也都會盡可能產生完整 policy report，避免只看到上一輪 ledger 而沒有這次事故原因。

不受信任 fork PR 不應拿到 Figma、webhook 或發布 token，也不要使用 `pull_request_target` 執行 PR 內的 `dk.config.mjs` 或 custom adapter。建議將流程拆成：

1. PR：無 secrets，收集本機／公開 evidence，執行 status 與 verify；
2. trusted push：提供最小 secrets，重新 sync；
3. publish：只在前兩步通過後呼叫 sinks；
4. 用 `status --require-sinks` 驗證 required sink 的最新 receipt；
5. 保存完整 Bridge artifactDir、status JSON 與 Axion report 為 CI artifacts。預設 directory 是 `.dk/bridge`，內含 `ledger.json` 與 `objects/`；若改過 `bridge.artifactDir`，同步修改範本中的 `AXION_BRIDGE_ARTIFACT_DIR` 與 `AXION_BRIDGE_LEDGER`。

內建 GitHub Checks sink 明確依賴完整 GitHub Actions environment，只應放在 GitHub Actions 的 trusted publish job。GitLab CI、Azure Pipelines 與 Jenkins 範本的 publish job 只應使用 allowlist webhook 或已審查的 custom sink；不要手動偽造 `GITHUB_*` 變數來跨 CI 發布 Check Run。Azure 範本的 variable group 預設註解，Figma token、webhook endpoint 與 token 都有安全空值，未配置 secret 不會把 `$(NAME)` placeholder 當成 credential。Jenkins 管理者只在受信任 Jenkinsfile／job 設定固定實際使用的三個 credential ID，未使用者保持空字串；credential ID 不得成為 build parameter，PR 路徑也不會解析 credential。若 PR 也要通過，請為 PR 使用只含公開／本機 source 的 manifest。Chromatic connection 在發布 job 會重新 collect，因此 trusted job 也必須提供 `CHROMATIC_BUILD_URL`、`CHROMATIC_BUILD_STATUS`、`CHROMATIC_BUILD_NUMBER` 與對應 commit。

可直接採用 repository 內的範本：

- `templates/integrations/github-actions-bridge.yml`
- `templates/integrations/gitlab-ci-bridge.yml`
- `templates/integrations/azure-pipelines-bridge.yml`
- `templates/integrations/Jenkinsfile.bridge`

## Custom adapter

custom module 必須位於 repository 內；repo 內的 relative 或 absolute path 都可使用，但 missing、`..`／absolute repo escape 與 symlink escape 會被拒絕。module 必須 export 有效的 versioned manifest；connection 的 `adapter` 必須和 manifest id 相同，實際 export 的 lifecycle 也必須與 manifest 完全一致。

以下是最小 source adapter。它固定連向一個 host、從 environment 取 token、綁定目前 commit，並只產生 self-attested evidence：

```js
// tools/bridge/acme-evidence.mjs
import {
  createAdapterManifest,
  createIntegrationEnvelope,
  safeFetch,
} from 'axion-designer/bridge';

const collectPermissions = [
  'env:ACME_EVIDENCE_TOKEN',
  'network:evidence.example.com',
];

export const manifest = createAdapterManifest({
  id: 'acme-evidence',
  provider: 'acme-evidence',
  version: '1.0.0',
  lifecycle: ['collect'],
  permissions: {
    discover: [],
    collect: collectPermissions,
    publish: [],
  },
});

export async function collect(ctx) {
  const token = ctx.env.ACME_EVIDENCE_TOKEN;
  if (!token) throw new Error('ACME_EVIDENCE_TOKEN is required.');
  if (typeof ctx.projectId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(ctx.projectId)) {
    throw new Error('projectId is invalid.');
  }

  const url = `https://evidence.example.com/v1/projects/${ctx.projectId}/status`;
  const result = await safeFetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: ctx.signal,
    fetchImpl: ctx.fetch,
    timeoutMs: ctx.timeoutMs,
    maxBytes: Math.min(ctx.maxBytes ?? 1024 * 1024, 1024 * 1024),
    allowRedirects: false,
    validateUrlOptions: {
      label: 'Acme evidence URL',
      httpsOnly: true,
      allowHttpLoopback: false,
      allowedOrigins: ['https://evidence.example.com'],
    },
  });
  if (!result.response.ok) throw new Error(`Acme evidence returned HTTP ${result.response.status}.`);
  let data;
  try { data = JSON.parse(Buffer.from(result.bytes).toString('utf8')); }
  catch { throw new Error('Acme evidence response is not valid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || !['passed', 'failed'].includes(data.status) || typeof data.commit !== 'string') {
    throw new Error('Acme evidence response shape is invalid.');
  }
  if (data.commit !== ctx.expectedCommit) throw new Error('Acme commit mismatch.');

  const createdAt = new Date(ctx.now).toISOString();
  return createIntegrationEnvelope({
    provider: 'acme-evidence',
    kind: 'collect/acme-evidence',
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString(),
    trust: {
      level: 'self-attested',
      issuer: 'acme-evidence',
      evidence: [`commit:${data.commit}`],
    },
    binding: {
      repository: ctx.repository?.remote ?? null,
      commit: ctx.expectedCommit ?? null,
    },
    permissions: collectPermissions,
    payload: {
      status: data.status === 'passed' ? 'passed' : 'failed',
      capability: 'acme.design-evidence.read',
      coverage: data.coverage ?? null,
      findings: Array.isArray(data.findings) ? data.findings : [],
    },
    artifacts: [],
  });
}
```

manifest：

```json
{
  "id": "acme-main",
  "adapter": "acme-evidence",
  "module": "tools/bridge/acme-evidence.mjs",
  "required": true,
  "trust": "linked",
  "permissions": [
    "env:ACME_EVIDENCE_TOKEN",
    "network:evidence.example.com"
  ],
  "options": {
    "projectId": "design-system",
    "tokenEnv": "ACME_EVIDENCE_TOKEN"
  }
}
```

custom adapter 的 production checklist：

- URL host 固定或 exact allowlist，不接受含 credentials 的任意 endpoint；
- 使用 `ctx.signal`，並限制 response bytes；
- 驗證 JSON shape、status、commit、repository 與 timestamp；
- secret 只從 `ctx.env` 讀，不放 payload、artifact、error 或 log；
- remote bytes 不冒充本機 artifact；本機 artifact 必須是 repository-relative 且 digest／bytes 相符；
- 沒有驗證簽章或具體 binding 時只發 `untrusted`／`self-attested`；
- 永遠不發 `approved` trust/status，也不寫 Taste Lock、baseline 或 approval history；
- 用 `dk bridge doctor`、isolated adapter tests、`sync`、`status` 與 tamper test 驗證。

## 問題排查

| 症狀 | 先看哪裡 | 常見修正 |
|---|---|---|
| `permission-missing` | `dk bridge catalog --json` | 把該 lifecycle 的精確 permissions 加到 connection。 |
| `missing-evidence` | `dk bridge sync <id>` | 確認 connection enabled、source 存在、網路／env 可用。 |
| `stale` | envelope `createdAt`／`expiresAt` | 重新 sync，或合理調整 `freshnessMs`，不要手改 ledger。 |
| `commit-mismatch` | `git rev-parse HEAD` 與 provider commit | 讓 preview／artifact／CI evidence 指向同一 checkout。 |
| `provider-failed` | `sync --json` 的 run error，以及最新 envelope 的 `payload.status`／`findings` | 修 adapter input、HTTP、token、permission 或 provider 回報的失敗；不要改成 optional 掩蓋必要證據。 |
| `provider-incomplete` | 最新 envelope `payload.status` | `pending`／`partial`／`unknown`／缺值都不是 passed；等 provider 完成或修正 adapter 映射後重新 sync。 |
| `invalid ledger` | `dk bridge status --json` issues | 恢復完整 CI artifact，或刪除可重建的 `.dk/bridge` 後重新 sync；不要修補 hash。 |
| `trust insufficient` | connection `trust` 與 envelope trust | 補上實際 digest／commit／repository binding，或經風險評估降低最低門檻。 |
| GitHub Check 不發布 | Actions permissions 與 `GITHUB_TOKEN` | 使用 trusted workflow、`checks: write`、`sync --publish`，並確認 envelope 綁定 `GITHUB_SHA`。 |

最終判斷不要只看「provider API 回 200」。完成條件是 `dk bridge status` 驗過 ledger、freshness、trust、commit 與 artifacts；若 Bridge 是交付政策的一部分，再以 `dk verify --full --require-gates` 的 exit code 作為 CI gate。
