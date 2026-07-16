# CI 整合

dk 提供四個可供 CI 消費的表面：

| 表面 | 命令／入口 | 用途 |
|---|---|---|
| GitHub composite action | repository 根目錄的 `action.yml` | 執行 verify，選擇性寫出 SARIF／HTML，保留退出碼 |
| SARIF 2.1.0 | `verify --sarif --out <file>` | 交給支援 SARIF 的掃描或檢閱工具 |
| summary JSON | `verify --summary` | hook、agent 或自訂 CI 邏輯 |
| Axion Bridge | `bridge sync/status --json` | 將 Storybook、Figma、preview、GitHub、Chromatic、JSON artifact 與 webhook evidence 綁定到同一 commit |

以下 action 範例引用 `fingertipshq/axion-designer`；tag 於正式 release 後可用，也可改用完整 commit SHA 釘選。

## Axion Bridge 的 CI 順序

先把 Axion Designer 固定在專案 `devDependencies` 與 lockfile。Bridge 應先產生／下載本輪 local source、再收集、驗狀態，最後才進完整 Axion gate；`--no-install` 可避免 CI 意外下載未鎖定的同名套件：

```bash
npm ci
# `:` 是安全 no-op；generated Storybook／artifact 專案改成受信任的 producer／restore command。
: "${AXION_BRIDGE_PRE_SYNC_COMMAND:=:}"
bash -euo pipefail -c "$AXION_BRIDGE_PRE_SYNC_COMMAND"
npx --no-install dk bridge doctor
npx --no-install dk bridge sync
npx --no-install dk bridge status --json > bridge-status.json
npx --no-install dk verify --full --require-gates --json > dk-report.json
```

在 `dk.config.mjs` 設定 `bridge.enabled: true` 或 `gates.bridge.enabled: true`，Bridge 便會成為 config-enabled heavy gate：一般 `verify` 與 `verify --full` 都會執行。required collect/source evidence 缺失、過期、信任不足、repository／commit 不符、provider 回報非 passed 或 ledger 損壞都會阻擋；required sink receipt 則只在 `sync --publish` 或 `status --require-sinks` 明確納入 fail-closed。optional/deferred incomplete 仍保留在 JSON 與 Studio。預設 `failOn: 'error'` 下 warn 不單獨產生 exit 1；若你顯式改成 `failOn: 'warn'`，則會照全局 warn 政策擋關。

ledger entry 的 `contractDigest` 會綁定 adapter 的 repository-local AST module graph、package manifest／受支援 lockfiles、`source`、`options`、`permissions`、`trust` 與 `role`。static import/export 與 literal loader 會被追蹤；computed loader、eval／Function／createRequire 直接拒絕，第三方 bare import 也必須有 lockfile。這些 connection contract 內容變動後必須重新執行 `dk bridge sync`；舊 evidence 不會直接滿足新設定。custom module 仍是 executable trust boundary，必須 code review。

GitHub Checks 與 webhook 是 sinks，只有明確加入 `--publish` 才會對外寫入：

```bash
npx --no-install dk bridge sync --publish
```

這一步應限制在 trusted push／protected branch job。fork PR 不得取得 `FIGMA_ACCESS_TOKEN`、`GITHUB_TOKEN` 寫入權限、`AXION_WEBHOOK_ENDPOINT` 或 `AXION_WEBHOOK_TOKEN`；也不要用 `pull_request_target` 執行 PR checkout 內的 `dk.config.mjs` 或 custom adapter。Bridge evidence 可以發布為 Check Run，但不能核准 Taste Lock、visual baseline 或 design approval history。

四份完整範本都採 fail-safe 預設：沒有把 `AXION_BRIDGE_PUBLISH` 顯式設為 `true`，publish job／stage 就不會執行（Jenkins 是 boolean，其餘平台要求精確字串）。只有 manifest 已配置 sink 時才開啟；純 Storybook、Figma 或 artifact source 專案保持關閉。各平台的實際開啟位置如下：

| 平台 | 明確開啟 publish |
|---|---|
| GitHub Actions | 在 repository／organization Actions variable 建立 `AXION_BRIDGE_PUBLISH=true` |
| GitLab CI | 建立 protected project／group／pipeline variable `AXION_BRIDGE_PUBLISH=true` |
| Azure Pipelines | 建立／授權 `axion-bridge-secrets` variable group、取消範本中的 group 註解，再建立 `AXION_BRIDGE_PUBLISH=true` |
| Jenkins | 在 trusted `main` build 勾選 boolean build parameter `AXION_BRIDGE_PUBLISH` |

每份範本也把 `AXION_BRIDGE_PRE_SYNC_COMMAND` 安全預設為 `:`。若 manifest 讀取 `storybook-static/index.json` 或其他未進版控的生成物，請在受信任的 CI variable／Jenkinsfile 將它改成 `npm run build-storybook`、artifact download／restore command，或一支固定的 repository script。每個呼叫 `sync` 的 fresh job 都會執行它，包含 publish job；publish 必須從同一輪 fresh source envelopes 投遞。若 producer 失敗，範本會跳過外部 sink 寫入但仍執行本輪 status 並保留原始失敗碼。Bridge 會把本機 artifact 快照到 `artifactDir/objects/<sha256>`，所以跨 job 保存／還原時必須傳完整 `AXION_BRIDGE_ARTIFACT_DIR`，不能只傳 `ledger.json`。不要把 secret literal 寫進 command。

四份範本預設 `AXION_BRIDGE_ARTIFACT_DIR=.dk/bridge`、`AXION_BRIDGE_LEDGER=.dk/bridge/ledger.json`。自訂 `bridge.artifactDir` 時兩者必須一起修改；CI artifact 路徑一律上傳完整 directory，才會同時包含 hash-chain ledger 與 immutable objects。objects 可能包含專案設計證據，請使用最小 artifact 存取權與保留天數；整份 envelope 與依內容 sniff 的 JSON snapshot 都會拒絕 credential-shaped fields／敏感 URL，但仍不應把任何 secret 或不必要的敏感原檔當成 evidence source。

Azure 範本的 variable group 預設為註解，所以只含 local／public source 的專案零外部前置；Figma 等 secret-backed source 仍需建立並啟用 group。範本會先把 `FIGMA_ACCESS_TOKEN`、`AXION_WEBHOOK_ENDPOINT` 與 `AXION_WEBHOOK_TOKEN` 定義為安全空值，再讓取消註解後、位於其後的 `axion-bridge-secrets` group 覆寫實際存在的 secret。不要刪除這些空值或把 group 移到它們前方，否則未定義的 `$(NAME)` 可能保留為字面 placeholder。Jenkins 管理者應在受信任 Jenkinsfile／job 設定中固定 `AXION_BRIDGE_FIGMA_CREDENTIAL_ID`、`AXION_BRIDGE_WEBHOOK_ENDPOINT_CREDENTIAL_ID` 與 `AXION_BRIDGE_WEBHOOK_CREDENTIAL_ID`；未使用者保持空字串，不需要建立假 credential，也不得把 credential ID 改成使用者可填的 build parameter。PR／change request 路徑不會解析任何 credential。

內建 GitHub Checks sink 需要完整的 GitHub Actions context 與 `checks: write`，所以只用在 GitHub Actions 範本。GitLab CI、Azure Pipelines 與 Jenkins 的 publish job 應配置 allowlist webhook 或已審查的 custom sink，不要把內建 GitHub adapter 當成跨 CI 通知器。publish 後再執行 `dk bridge status --require-sinks`，才會把 required sink 的最新 receipt 納入 fail-closed 驗證。

可直接複製並依專案調整的完整範本：

- [GitHub Actions](../templates/integrations/github-actions-bridge.yml)
- [GitLab CI](../templates/integrations/gitlab-ci-bridge.yml)
- [Azure Pipelines](../templates/integrations/azure-pipelines-bridge.yml)
- [Jenkins](../templates/integrations/Jenkinsfile.bridge)

七個 adapters、permission grants、環境變數、MCP 與 custom module 詳見 [Axion Bridge 實戰手冊](axion-bridge.md)。

## GitHub Action 與 SARIF

`action.yml` 的主要 inputs：

| input | 預設 | 作用 |
|---|---|---|
| `working-directory` | `.` | dk 執行目錄；SARIF 路徑也以此為基準 |
| `args` | `verify` | 傳給 dk 的命令與旗標 |
| `sarif` | `false` | 設為 `true` 時額外寫出 SARIF |
| `sarif-path` | `dk-report.sarif` | SARIF 輸出位置 |
| `html` | `false` | 設為 `true` 時把本次持久化 ledger 渲染成自包含 HTML |
| `html-path` | `dk-report.html` | HTML review artifact 輸出位置 |
| `bridge-sync` | `false` | 在主驗證前執行 `dk bridge sync`；Bridge 失敗會保留為 action 失敗碼 |
| `bridge-publish` | `false` | 搭配 `bridge-sync: true`，明確把本輪 envelopes 發布到 configured sinks |

Action 順序是：選配 Bridge sync（與顯式 publish）→ `args` 恰好執行一次 → 從這一輪新寫的 `.dk/report.json` 分別渲染 SARIF 與 HTML。它不會把 `--sarif` 塞進 `args`，因此 `args: verify --json` 也不會把 JSON 誤寫到 `.sarif` 檔。若主命令沒有產生 fresh ledger 卻要求 SARIF 或 HTML，或 render 未實際寫出本輪 artifact，action 會 fail closed，不會拿舊檔假裝成本輪結果。

outputs：

- `exit-code`：dk 的 `0 | 1 | 2`。
- `sarif-path`：本輪成功產生的 SARIF 絕對路徑；未啟用或產生失敗時為空字串。
- `html-path`：本輪成功產生的 HTML 絕對路徑；未啟用或產生失敗時為空字串。
- `bridge-ledger-path`：本輪 Bridge sync 成功、`bridge status` 驗證通過，且 ledger 實際存在時的絕對路徑；會尊重自訂 `artifactDir`，其餘情況為空字串。

`bridge-ledger-path` 是成功狀態與 ledger 位置的 output，不代表完整 evidence bundle。若後續 job 或人工稽核要保存 Bridge evidence，請上傳設定的完整 `bridge.artifactDir`（預設 `.dk/bridge`），不要只上傳這個單檔 output；`objects/` 內的 content-addressed snapshots 也是驗證必要資料。

> **信任邊界：** `dk.config.mjs`、Stylelint 設定與 Playwright 設定都是可執行程式碼。對不受信任的 fork PR，只能使用權限最小、用完即棄的 runner；不要改用 `pull_request_target`、不要提供 secrets，也不要在長存的 self-hosted runner 上執行。若 SARIF 上傳需要寫入權限，請移到受信任的 `push` 或合併後工作流程。

下例先保留 dk 的輸出；trusted push 寫入 code scanning，PR（包含 fork）只存 workflow artifact，最後再依原始退出碼決定 job 是否失敗：

```yaml
name: design-quality
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  security-events: write

jobs:
  dk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - id: dk
        uses: fingertipshq/axion-designer@v1.0.0
        continue-on-error: true
        with:
          args: verify
          sarif: 'true'
          sarif-path: dk-report.sarif
          html: 'true'
          html-path: dk-report.html

      - name: Upload SARIF to code scanning on trusted push
        if: ${{ always() && github.event_name == 'push' && steps.dk.outputs.sarif-path != '' }}
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ${{ steps.dk.outputs.sarif-path }}
          category: dk

      - name: Preserve PR reports without write permission
        if: ${{ always() && github.event_name == 'pull_request' && steps.dk.outputs.sarif-path != '' }}
        uses: actions/upload-artifact@v4
        with:
          name: dk-pr-report-${{ github.run_id }}-${{ github.run_attempt }}
          if-no-files-found: error
          retention-days: 14
          path: |
            ${{ steps.dk.outputs.sarif-path }}
            ${{ steps.dk.outputs.html-path }}

      - name: Enforce dk exit code
        if: ${{ always() && steps.dk.outputs.exit-code != '0' }}
        env:
          DK_EXIT_CODE: ${{ steps.dk.outputs.exit-code }}
        run: exit "$DK_EXIT_CODE"
```

`security-events: write` 在 fork PR 會被降級，因此範例只在 trusted push 寫入 code scanning；所有 PR（包含 fork）改用不需要 repository 寫權的 workflow artifact 保存 SARIF／HTML。若只要產出 alert、不以 dk 結果讓 job 失敗，可省略最後的 `Enforce dk exit code`。若不需要先上傳失敗結果，也可移除 `continue-on-error`。

action 需要 runner 的 `PATH` 上有 Node.js 18 以上版本。self-hosted runner 若未提供，應在 action 前自行設定 Node.js。

### 直接從 repository 產生 SARIF

不使用 action 時，可直接執行目前 checkout 內的 CLI；這不會解析或安裝任何同名第三方套件：

```bash
set +e
node bin/dk.mjs verify --sarif --out dk-report.sarif
code=$?
set -e

# 在這裡上傳或保存 dk-report.sarif
exit "$code"
```

每個 SARIF result 包含 `ruleId`、severity、message、位置，以及 `partialFingerprints["dkFingerprint/v1"]`。檔案 URI 相對於 dk 的執行目錄；在 monorepo 中應讓上傳工具使用相同的路徑基準。

`verify`、`proof`、`slop` 與 `report` 每次只允許一種輸出表面：`--summary`、`--json`、`--sarif`、`--html` 不能併用。要多種 artifact，先執行一次 verify，再對同一份 ledger 執行多次 `dk report`；格式衝突會在寫檔前以 exit 2 拒絕。

## Summary JSON

`--summary` 不含逐筆 Finding，適合只需要狀態與聚合資訊的 consumer：

```bash
node bin/dk.mjs verify --summary
```

主要欄位：

```json
{
  "schema": "dk-summary/v1",
  "status": "failed",
  "exitCode": 1,
  "tokenHash": "…",
  "direction": { "status": "approved", "locked": true },
  "counts": { "error": 1, "warn": 0, "info": 0 },
  "gates": [
    { "id": "slop", "status": "ran", "findingCount": 1 }
  ],
  "rules": {
    "top": [
      { "ruleId": "slop/hardcoded-color", "count": 1 }
    ]
  }
}
```

hook 範例：

```bash
set +e
node bin/dk.mjs verify --summary > dk-summary.json
code=$?
set -e

jq -r '"status=\(.status) errors=\(.counts.error) warnings=\(.counts.warn)"' dk-summary.json
exit "$code"
```

consumer 應先檢查 `schema`，並同時判讀 `status` 與 `exitCode`：`incomplete` 可能在未使用 `--require-gates` 時保留 exit 0。需要逐筆 `file`、`line`、`col`、`evidence` 與 `fix` 時，改用 `verify --json`。

## 在子目錄執行

action 可指定：

```yaml
- id: dk
  uses: fingertipshq/axion-designer@v1.0.0
  with:
    working-directory: packages/web
    args: verify --full --require-gates
    sarif: 'true'
```

CLI 路徑、tokens、targets、baseline 與 SARIF artifact 都應以同一個 working directory 為基準，避免報告位置與 checkout 路徑不一致。
