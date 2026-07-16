/* ============================================================
   命令分派表 —— 每個 CLI 動詞一支薄 handler。
   解析 flag、呼叫 core、選 reporter、印出、回 exit code。無設計邏輯。
   全部動詞皆已實作：new / init / design / verify / watch / build / fix /
   baseline / tokens / contrast / slop / explain / rules / report / doctor / help。
   統一 exit code：0 通過 · 1 有達 failOn 門檻的 Finding · 2 用法錯誤。
   ============================================================ */
import { readFileSync, existsSync, readdirSync, statSync, watch } from 'node:fs';
import { join, dirname, resolve as resolvePath, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig, findConfigFile, PRESETS } from '../core/config.mjs';
import { loadTokens, compile, buildManifest, resolve, contrast as wcag, apca, validateTokens, fromTokensStudio } from '../core/tokens.mjs';
import {
  createDirectionTemplate,
  createDirectionLock,
  hashDirection,
  hashDirectionBindings,
  renderDirectionPrompt,
  validateDirection,
  validateDirectionLock,
} from '../core/direction.mjs';
import { run as runChain, pathExists, fingerprint, loadBaseline, globToRegExp, isKnownGateId, KNOWN_GATE_IDS, collectFiles, buildIgnoreIndex, isSuppressed } from '../core/ledger.mjs';
import { renderTerminal, renderJson, renderSarif, renderHtml, renderSummary } from '../core/report.mjs';
import { getRule, listRules, RULES, ruleTitle, ruleWhy, ruleFix } from '../core/finding.mjs';
import { dedupePairs } from '../gates/contract.mjs';
import { buildColorFixIndex, scanColorFixes } from '../gates/slop.mjs';
import { resolveLang, LANG, pick } from '../core/i18n.mjs';
import { isUnsafeWriteError, safeCopyDirectorySync, safeWriteFileSync } from '../core/safe-write.mjs';
import {
  appendApproval,
  defaultApprovalHistoryPath,
  readApprovalHistory,
  readVerificationEvidence,
  resolveApprovalActor,
} from '../core/approvals.mjs';
import { renderDriftBenchmarkHtml, runDriftBenchmark } from '../benchmark/drift.mjs';
import { AppProofConfigError, applyAppProofCliOverrides } from '../proof/app-proof.mjs';
import { startStudio } from '../studio/server.mjs';
import { indexRepository } from '../system/indexer.mjs';
import { cmdBridge, printBridgeHelp } from './bridge.mjs';
import { cmdCodex, printCodexHelp } from './codex.mjs';
import { cmdClaude, printClaudeHelp } from './claude.mjs';
import { cmdIntelligence, printIntelligenceHelp } from './intelligence.mjs';
import { cmdReference, printReferenceHelp } from './reference.mjs';

const EXIT_OK = 0, EXIT_FAIL = 1, EXIT_USAGE = 2;

/* ============================================================
   語言層 —— findings、報告本文與命令輸出共用同一語言選擇。
   core/i18n.mjs 解析語言（DK_LANG > locale > en 預設）；
   gate finding 訊息與報告本文由 i18n.fmsg / report.mjs 渲染；命令輸出以 pick(zh,en) 就地二選一。
   下方 MESSAGES（M）只承載 CLI 殼層的 usage、help 與 exit 2 錯誤。
   ============================================================ */
export { resolveLang, LANG };

// CLI 殼層訊息表（僅 usage、錯誤與 help）；依 LANG 選擇顯示語言。
const MESSAGES = {
  'zh-TW': {
    unknownFlag: (cmd, key, sugg) => `未知旗標：--${key}${sugg ? `（是不是要打 --${sugg}？）` : ''}\n執行 dk ${cmd} --help 看該命令可用的旗標。\n`,
    missingFlagValue: (cmd, key) => `旗標 --${key} 缺少值。\n執行 dk ${cmd} --help 看正確用法。\n`,
    unexpectedError: (d) => `dk: 未預期錯誤：${d}\n`,
    unknownCommand: (cmd) => `未知命令：dk ${cmd}\n執行 dk --help 看可用命令。\n`,
    unknownPreset: (p, avail) => `未知的 preset '${p}'（可用：${avail}）\n`,
    newUsage: () => `用法：dk new <dir> [--preset recommended|strict|minimal]\n例：dk new portfolio\n`,
    scaffoldMissing: (p) => `找不到內建範本（${p}）——安裝可能不完整。\n`,
    targetExists: (dir) => `目標已存在且非空：${dir}\ndk new 絕不覆蓋你的檔案。請換一個新目錄名，或先清空它。\n`,
    tokensMissing: (p) => `找不到 tokens：${p}\n`,
    tokensMissingVerify: (p) => `找不到 tokens：${p}\n（在 dk.config 設定 tokens.source，或執行 dk new 建立起點。）\n`,
    tokensMissingWatch: (p) => `找不到 tokens：${p}\n（先執行 dk new / dk init，或設定 tokens.source。）\n`,
    gateNeedsId: (ids) => `--gate 需要一個關卡 id（可用：${ids}）\n`,
    unknownGate: (g, ids) => `未知的 gate '${g}'（可用：${ids}）\n執行 dk rules 看規則、dk --help 看用法。\n`,
    noFilesMatched: (t) => `沒有檔案符合：${t}\n檢查路徑/glob；未加參數時 dk 會用 dk.config 的 targets。\n`,
    destCollide: (rp, base) => `拒絕把報告寫到 ${rp}：它落在本次掃描範圍內——寫出會覆寫你的來源檔，且下次 dk verify 會把報告掃回，其 evidence 的 lorem/hex 字樣會讓 findings 連鎖暴增。\n改用 --out 指到專案內不在掃描範圍的位置（如 .dk/reports/${base}），或把它加進 dk.config 的 ignore。`,
    buildCheckNoArtifacts: (f) => `✗ 沒有可檢查的產物：要求的格式（${f}）都沒有設定輸出路徑（config.tokens.output）。\n`,
    buildNoArtifacts: (f) => `✗ 沒有可寫出的產物：要求的格式（${f}）都沒有設定輸出路徑（config.tokens.output）。\n`,
    tokensDiffUsage: () => `用法：dk tokens diff <other-tokens.json>\n`,
    tokensUnknownSub: (sub) => `未知子命令：dk tokens ${sub}（list | contrast | coverage | diff | import）\n`,
    tokensImportUsage: () => `用法：dk tokens import <file.json | dir> [--out design/tokens.imported.json]\n把 Tokens Studio 匯出（single-file JSON 或 multi-file 目錄）搬運成 dk 的 DTCG token。\n這是格式搬運、不是生成——不改值、不補值、不發明轉換。\n`,
    tokensImportMissing: (p) => `找不到匯入來源：${p}\n`,
    tokensImportParse: (p, d) => `無法解析 Tokens Studio 匯出（${p}）：${d}\n`,
    tokensImportEmpty: (p) => `匯入來源沒有可辨識的 token set：${p}\n（single-file 頂層應為 token set 名；multi-file 目錄應含 *.json set 檔。）\n`,
    tokensImportOverwrite: (p) => `拒絕覆寫既有檔：${p}\ndk tokens import 絕不覆寫你的檔——改用 --out 指到一個新路徑（既有 design/tokens.json 一律受保護）。\n`,
    tokenValues: (lines) => `✗ tokens 值無法解析（DTCG 讀入端）：\n${lines.map((l) => `   · ${l}`).join('\n')}\n  讀入端支援：2021 字串方言（hex/px/rem 字串）＋ 2025.10 物件式 color（colorSpace/components/hex）與 dimension（value/unit）。\n  composite 型別（typography、shadow 物件等）尚未支援——請改用字串方言。\n`,
    explainUsage: () => `用法：dk explain <ruleId>（例：dk explain slop/hardcoded-color）\n`,
    ruleNotFound: (id) => `找不到規則：${id}\n執行 dk rules 看清單。\n`,
    noLedger: () => `沒有上一次 run 的帳本（.dk/report.json）。先執行 dk verify。\n`,
    surfaceConflict: (flags) => `報告格式不能同時指定：${flags.join(' / ')}。每次命令只能選 --summary、--json、--sarif 或 --html 一種；要其他格式請再執行 dk report。\n`,
    slopFixedGate: (flags) => `dk slop 是固定執行 slop 關卡的別名，不能使用 ${flags.join(' / ')}。\n要選其他關卡或重關卡，請改用 dk verify --gate <id> 或 dk verify --full。\n`,
  },
  en: {
    unknownFlag: (cmd, key, sugg) => `Unknown flag: --${key}${sugg ? ` (did you mean --${sugg}?)` : ''}\nRun \`dk ${cmd} --help\` to see the flags this command accepts.\n`,
    missingFlagValue: (cmd, key) => `Flag --${key} requires a value.\nRun \`dk ${cmd} --help\` to see the correct usage.\n`,
    unexpectedError: (d) => `dk: unexpected error: ${d}\n`,
    unknownCommand: (cmd) => `Unknown command: dk ${cmd}\nRun \`dk --help\` to see available commands.\n`,
    unknownPreset: (p, avail) => `Unknown preset '${p}' (available: ${avail})\n`,
    newUsage: () => `Usage: dk new <dir> [--preset recommended|strict|minimal]\nExample: dk new portfolio\n`,
    scaffoldMissing: (p) => `Built-in scaffold not found (${p}) — the install may be incomplete.\n`,
    targetExists: (dir) => `Target already exists and is not empty: ${dir}\ndk new never overwrites your files. Pick a new directory name, or empty it first.\n`,
    tokensMissing: (p) => `Tokens not found: ${p}\n`,
    tokensMissingVerify: (p) => `Tokens not found: ${p}\n(Set tokens.source in dk.config, or run dk new to create a starting point.)\n`,
    tokensMissingWatch: (p) => `Tokens not found: ${p}\n(Run dk new / dk init first, or set tokens.source.)\n`,
    gateNeedsId: (ids) => `--gate needs a gate id (available: ${ids})\n`,
    unknownGate: (g, ids) => `Unknown gate '${g}' (available: ${ids})\nRun dk rules to see the rules, dk --help for usage.\n`,
    noFilesMatched: (t) => `No files matched: ${t}\nCheck the path/glob; with no argument dk uses the targets from dk.config.\n`,
    destCollide: (rp, base) => `Refusing to write the report to ${rp}: it falls inside this run's scan set — writing it would overwrite your source file, and the next dk verify would scan the report back in, whose lorem/hex evidence would cascade findings.\nUse --out to point to an unscanned location inside the project (e.g. .dk/reports/${base}), or add it to ignore in dk.config.`,
    buildCheckNoArtifacts: (f) => `✗ Nothing to check: none of the requested formats (${f}) has an output path configured (config.tokens.output).\n`,
    buildNoArtifacts: (f) => `✗ Nothing to write: none of the requested formats (${f}) has an output path configured (config.tokens.output).\n`,
    tokensDiffUsage: () => `Usage: dk tokens diff <other-tokens.json>\n`,
    tokensUnknownSub: (sub) => `Unknown subcommand: dk tokens ${sub} (list | contrast | coverage | diff | import)\n`,
    tokensImportUsage: () => `Usage: dk tokens import <file.json | dir> [--out design/tokens.imported.json]\nCarry a Tokens Studio export (single-file JSON or multi-file directory) into dk's DTCG tokens.\nThis is a format carry, not generation — it never changes, invents, or fills in values.\n`,
    tokensImportMissing: (p) => `Import source not found: ${p}\n`,
    tokensImportParse: (p, d) => `Could not parse the Tokens Studio export (${p}): ${d}\n`,
    tokensImportEmpty: (p) => `No recognizable token set in the import source: ${p}\n(Single-file: top-level keys are token set names; multi-file: the directory should contain *.json set files.)\n`,
    tokensImportOverwrite: (p) => `Refusing to overwrite an existing file: ${p}\ndk tokens import never overwrites your files — point --out at a fresh path (an existing design/tokens.json is always protected).\n`,
    tokenValues: (lines) => `✗ Token values could not be resolved (DTCG reader):\n${lines.map((l) => `   · ${l}`).join('\n')}\n  Reader supports: the 2021 string dialect (hex/px/rem strings) + 2025.10 object-form color (colorSpace/components/hex) and dimension (value/unit).\n  Composite types (typography, shadow objects, etc.) are not yet supported — use the string dialect.\n`,
    explainUsage: () => `Usage: dk explain <ruleId> (e.g. dk explain slop/hardcoded-color)\n`,
    ruleNotFound: (id) => `Rule not found: ${id}\nRun dk rules to see the list.\n`,
    noLedger: () => `No ledger from a previous run (.dk/report.json). Run dk verify first.\n`,
    surfaceConflict: (flags) => `Report formats cannot be combined: ${flags.join(' / ')}. Choose exactly one of --summary, --json, --sarif, or --html per command; run dk report separately for another format.\n`,
    slopFixedGate: (flags) => `dk slop is a fixed alias for the slop gate and cannot use ${flags.join(' / ')}.\nUse dk verify --gate <id> or dk verify --full to select other or heavy gates.\n`,
  },
};
export const M = MESSAGES[LANG];

/** 分派器。回傳 process exit code。 */
export async function dispatch(cmd, args, flags, ctx = {}) {
  const cwd = ctx.cwd ?? process.cwd();
  switch (cmd) {
    case 'new': return cmdNew(args, flags, cwd);
    case 'init': return cmdInit(args, flags, cwd);
    case 'verify': return cmdVerify(args, flags, cwd);
    case 'proof': return cmdProof(args, flags, cwd);
    case 'watch': return cmdWatch(args, flags, cwd);
    case 'build': return cmdBuild(args, flags, cwd);
    case 'fix': return cmdFix(args, flags, cwd);
    case 'baseline': return cmdBaseline(args, flags, cwd);
    case 'design': return cmdDesign(args, flags, cwd);
    case 'tokens': return cmdTokens(args, flags, cwd);
    case 'contrast': return cmdTokens(['contrast', ...args], flags, cwd);
    case 'slop': return cmdVerify(args, { ...flags, gate: 'slop' }, cwd);
    case 'explain': return cmdExplain(args, flags, cwd);
    case 'rules': return cmdRules(args, flags, cwd);
    case 'report': return cmdReport(args, flags, cwd);
    case 'benchmark': return cmdBenchmark(args, flags, cwd);
    case 'system': return cmdSystem(args, flags, cwd);
    case 'studio': return cmdStudio(args, flags, cwd);
    case 'bridge': return cmdBridge(args, flags, cwd);
    case 'codex': return cmdCodex(args, flags, cwd);
    case 'claude': return cmdClaude(args, flags, cwd);
    case 'intelligence': return cmdIntelligence(args, flags, cwd);
    case 'reference': return cmdReference(args, flags, cwd);
    case 'doctor': return cmdDoctor(args, flags, cwd);
    case 'help': case undefined: case '': printHelp(); return EXIT_OK;
    default:
      process.stderr.write(M.unknownCommand(cmd));
      return EXIT_USAGE;
  }
}

/* ---- studio [dir] ---- */
async function cmdStudio(args, flags, cwd) {
  if (args.length > 1) {
    process.stderr.write(pick('用法：dk studio [dir] [--port <n>] [--host <host>] [--open] [--allow-remote] [--json]\n',
      'Usage: dk studio [dir] [--port <n>] [--host <host>] [--open] [--allow-remote] [--json]\n'));
    return EXIT_USAGE;
  }
  const root = resolvePath(cwd, args[0] ?? '.');
  if (!pathExists(root) || !statSync(root).isDirectory()) {
    process.stderr.write(pick(`Studio 專案目錄不存在：${root}\n`, `Studio project directory does not exist: ${root}\n`));
    return EXIT_USAGE;
  }
  const port = flags.port == null ? 4177 : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(pick('Studio --port 必須是 0–65535 的整數。\n', 'Studio --port must be an integer from 0 to 65535.\n'));
    return EXIT_USAGE;
  }
  const host = flags.host == null ? '127.0.0.1' : String(flags.host);
  const studio = await startStudio({ root, port, host, allowRemote: !!flags['allow-remote'] });
  const address = studio.address;
  const surface = {
    schema: 'dk-studio-start/v1',
    url: studio.url,
    root: studio.root,
    host,
    port: typeof address === 'object' && address ? address.port : port,
    mode: 'read-only',
  };
  if (flags.json) process.stdout.write(`${JSON.stringify(surface)}\n`);
  else process.stdout.write(`\nAxion Studio · ${pick('唯讀本機工作台', 'read-only local workbench')}\n  ${studio.url}\n  root  ${studio.root}\n  ${pick('按 Ctrl+C 關閉', 'Press Ctrl+C to stop')}\n\n`);
  if (flags.open) openFile(studio.url);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await studio.close(); } finally { process.exit(0); }
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return EXIT_OK;
}

/* ---- system [graph] ---- */
function cmdSystem(args, flags, cwd) {
  const rest = args[0] === 'graph' ? args.slice(1) : args;
  if (rest.length) {
    process.stderr.write(pick('用法：dk system [graph] [--json] [--out <path>] [--include-generated]\n',
      'Usage: dk system [graph] [--json] [--out <path>] [--include-generated]\n'));
    return EXIT_USAGE;
  }
  const graph = indexRepository(cwd, { includeGenerated: !!flags['include-generated'] });
  const body = `${JSON.stringify(graph, null, 2)}\n`;
  let written = null;
  if (flags.out) {
    written = resolvePath(cwd, String(flags.out));
    safeWriteFileSync(cwd, written, body);
  }
  if (flags.json) process.stdout.write(body);
  else {
    const kinds = graph.stats?.kinds ?? {};
    const relations = graph.stats?.relations ?? {};
    process.stdout.write([
      '',
      `✓ Axion System Graph · ${graph.stats?.nodes ?? graph.nodes.length} nodes · ${graph.stats?.edges ?? graph.edges.length} edges`,
      `  ${pick('元件', 'components')}  ${kinds.component ?? 0}    ${pick('路由', 'routes')}  ${kinds.route ?? 0}    stories  ${kinds.story ?? 0}    tokens  ${kinds.token ?? 0}`,
      `  imports  ${relations.imports ?? 0}    uses  ${relations.uses ?? 0}    tokenUses  ${relations.tokenUses ?? 0}`,
      `  ${pick('證據面', 'proof surfaces')}  ${graph.proof?.routes?.length ?? 0} ${pick('條 route', 'routes')} · ${graph.proof?.summary?.screenshotCount ?? 0} screenshots`,
      `  ${pick('警告', 'warnings')}  ${graph.warnings?.length ?? 0}`,
      ...(written ? [`  ${pick('寫入', 'wrote')}  ${relative(cwd, written)}`] : []),
      '',
    ].join('\n'));
  }
  return EXIT_OK;
}

/* ---- benchmark ----
   Runs ten real mutations in an isolated shipped scaffold. This never edits
   the caller's project; only an explicitly requested report path is written. */
async function cmdBenchmark(args, flags, cwd) {
  if (args.length) {
    process.stderr.write(pick('用法：dk benchmark [--json] [--html [path] | --out <path>] [--keep-workspace]\n',
      'Usage: dk benchmark [--json] [--html [path] | --out <path>] [--keep-workspace]\n'));
    return EXIT_USAGE;
  }
  const result = await runDriftBenchmark({
    keepWorkspace: flags['keep-workspace'] === true,
    throwOnFailure: false,
  });
  const outputArg = flags.out ?? (flags.html ? (typeof flags.html === 'string' ? flags.html : 'axion-p3-benchmark.html') : null);
  let written = null;
  if (outputArg) {
    written = resolvePath(cwd, String(outputArg));
    // `--json --html report.html` is a useful dual surface: JSON remains on
    // stdout for automation while the explicitly requested file is HTML.
    // Previously the `.html` destination silently received JSON.
    const body = flags.html ? renderDriftBenchmarkHtml(result)
      : flags.json ? `${JSON.stringify(result, null, 2)}\n`
        : renderDriftBenchmarkHtml(result);
    safeWriteFileSync(cwd, written, body);
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const icon = result.status === 'passed' ? '✓' : '✗';
    process.stdout.write([
      '',
      `${icon} Axion P3 drift benchmark · ${result.status}`,
      `  ${pick('偵測', 'detection')}  ${result.detected}/${result.rounds}`,
      `  ${pick('復原', 'recovery')}   ${result.recovered}/${result.rounds}`,
      `  ${pick('乾淨重驗', 'clean checks')} ${result.cleanChecks} · ${result.unexpectedFindings} ${pick('筆非預期 finding', 'unexpected findings')}`,
      `  ${pick('延遲', 'latency')}     ${result.medianDetectionMs} ms median · ${result.p95DetectionMs} ms p95`,
      `  proof       ${result.proofHash}`,
      ...(written ? [`  ${pick('報告', 'report')}      ${relative(cwd, written)}`] : []),
      ...(result.workspace ? [`  workspace   ${result.workspace}`] : []),
      '',
    ].join('\n'));
  }
  return result.status === 'passed' ? EXIT_OK : EXIT_FAIL;
}

/* ---- proof ----
   Unlike `verify --gate a11y`, this command promises browser-backed App Proof.
   It must therefore fail closed when neither dk.config nor `--app` supplies a
   proof contract; otherwise a file-only axe run could masquerade as app proof. */
async function cmdProof(args, flags, cwd) {
  let config = await loadConfig(cwd);
  try { config = applyAppProofCliOverrides(config, flags); }
  catch (error) {
    if (!(error instanceof AppProofConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return EXIT_USAGE;
  }
  if (reportConfigErrors(config)) return EXIT_USAGE;
  if (!config.proof) {
    process.stderr.write(pick(
      '✗ dk proof 需要真實 Web App 證據設定。請在 dk.config 定義 proof.baseUrl，或傳入 --app <url>。\n如果只要掃描本機檔案，請用 dk verify --gate a11y。\n',
      '✗ dk proof requires a real Web app proof contract. Define proof.baseUrl in dk.config or pass --app <url>.\nFor file-only accessibility scanning, use dk verify --gate a11y.\n',
    ));
    return EXIT_USAGE;
  }
  return cmdVerify(args, { ...flags, gate: 'a11y', 'require-gates': true }, cwd);
}

/* ---- new <dir> [--preset recommended|strict|minimal] ----
   把 templates/scaffold/ 逐字複製到新目錄：一份品牌中性的 tokens.json、
   已編好且同步的 styles/tokens.css、一頁誠實樸素、已通過核心關卡的 index.html、
   註解好的 dk.config.mjs、忽略 .dk/ 的 .gitignore。
   這是 dk 的 scaffold 寫檔行為——逐位元組複製，無模板變數、無 LLM、無提示詞。
   --preset 只在三個 vetted 品味基線間切換（改 config 一行），不生成任何內容。 */
function cmdNew(args, flags, cwd) {
  const dir = args[0];
  if (!dir) {
    process.stderr.write(M.newUsage());
    return EXIT_USAGE;
  }
  const preset = flags.preset ? String(flags.preset) : null;
  if (preset && !PRESETS[preset]) {
    process.stderr.write(M.unknownPreset(preset, Object.keys(PRESETS).join(' / ')));
    return EXIT_USAGE;
  }

  const scaffold = fileURLToPath(new URL('../../templates/scaffold', import.meta.url));
  if (!existsSync(scaffold)) {
    process.stderr.write(M.scaffoldMissing(scaffold));
    return EXIT_USAGE;
  }

  const target = resolvePath(cwd, dir);
  if (existsSync(target)) {
    let entries = [];
    try { entries = readdirSync(target); } catch { /* not a dir */ }
    if (entries.length) {
      process.stderr.write(M.targetExists(dir));
      return EXIT_USAGE;
    }
  }

  // 逐字複製整個 scaffold（含 .gitignore 等 dotfiles），但絕不搬運 .dk
  // runtime evidence。即使開發或驗收曾在 template 目錄誤跑 verify，新消費者也不能
  // 在首次執行前繼承舊 cache、pass report 或 localhost App Proof。
  safeCopyDirectorySync(cwd, scaffold, target, {
    filter: (source) => {
      const fromScaffold = relative(scaffold, source);
      return fromScaffold !== '.dk' && !fromScaffold.startsWith(`.dk${sep}`);
    },
  });
  // 安全網：npm 發布時會把 tarball 內的 .gitignore 剝除，故從 npm 安裝的 dk 其 scaffold 可能缺此檔。
  // 缺時補回完整 .gitignore（只在缺席時寫，永不覆蓋）——避免 npm tarball
  // 剝除 dotfile 後，讓快取、建置與測試產物意外進版控。
  const giTarget = join(target, '.gitignore');
  if (!existsSync(giTarget)) {
    try {
      safeWriteFileSync(cwd, giTarget, [
        '.dk/',
        'node_modules/',
        'dist/',
        'build/',
        'test-results/',
        'playwright-report/',
        '*-snapshots/',
        '',
      ].join('\n'));
    }
    catch (err) { if (isUnsafeWriteError(err)) throw err; /* 非致命 */ }
  }

  // --preset：在三個 vetted 基線間切換——只改 config 一行，不生成任何內容。
  let chosen = 'recommended';
  if (preset && preset !== 'recommended') {
    const cfgPath = join(target, 'dk.config.mjs');
    try {
      const src = readFileSync(cfgPath, 'utf8');
      const next = src.replace(/preset:\s*'[a-z]+'/, `preset: '${preset}'`);
      if (next !== src) { safeWriteFileSync(cwd, cfgPath, next); chosen = preset; }
    } catch (err) {
      if (isUnsafeWriteError(err)) throw err;
      /* config 缺失不致命——preset 維持 recommended */
    }
  }

  const B = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
  const D = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
  const rp = relative(cwd, target);
  const disp = (!rp || rp.startsWith('..')) ? dir : rp; // 顯示使用者輸入的路徑，別畫出一長串 ../
  process.stdout.write(`\n${B(pick('✓ 建立工作區', '✓ Workspace created'))} ${disp}  ${D('· preset:' + chosen)}\n\n`);
  process.stdout.write('  ' + pick('已放入（逐字複製、非生成）：', 'Placed (copied verbatim, not generated):') + '\n');
  process.stdout.write(`   ${D('·')} design/tokens.json     ${D(pick('品牌中性 SSOT——你唯一該手改的設計來源', 'brand-neutral SSOT — the one design source you should hand-edit'))}\n`);
  process.stdout.write(`   ${D('·')} styles/tokens.css      ${D(pick('已編好且與 SSOT 同步的產物', 'a compiled artifact, in sync with the SSOT'))}\n`);
  process.stdout.write(`   ${D('·')} index.html             ${D(pick('一頁誠實樸素、已通過核心關卡的起點', 'an honestly-plain starting page that passes the core gates'))}\n`);
  process.stdout.write(`   ${D('·')} dk.config.mjs          ${D(pick('註解好的設定（改這裡把品味變機檢規則）', 'a commented config (edit here to turn taste into machine checks)'))}\n`);
  process.stdout.write(`   ${D('·')} stylelint.config.mjs   ${D(pick('選用 CSS strict 關卡設定', 'optional CSS strict-gate config'))}\n`);
  process.stdout.write(`   ${D('·')} .gitignore             ${D(pick('忽略快取、依賴與測試產物', 'ignores caches, dependencies, and test artifacts'))}\n`);
  process.stdout.write(`   ${D('·')} gates/visual.spec.mjs  ${D(pick('視覺回歸關卡範本（dk verify --full 用）', 'a visual-regression gate spec (used by dk verify --full)'))}\n`);
  process.stdout.write(`   ${D('·')} playwright.config.mjs  ${D(pick('視覺關卡的 Playwright 設定', 'Playwright config for the visual gate'))}\n\n`);
  process.stdout.write('  ' + pick('下一步：', 'Next:') + '\n');
  process.stdout.write(`   ${B('cd ' + disp)}\n`);
  process.stdout.write(`   ${B('dk verify')}          ${D(pick('跑整條鏈——它現在全綠，是你的基準線', 'run the whole chain — it is green now, your baseline'))}\n`);
  process.stdout.write(`   ${D(pick('編輯 index.html，寫錯時 dk verify 會精確擋你並教你為什麼。', 'Edit index.html; when you slip, dk verify blocks you precisely and teaches you why.'))}\n\n`);
  return EXIT_OK;
}

/* ---- init [--preset …] ----
   高手採用入口。在既有 repo 就地寫 dk.config.mjs，自動偵測 targets glob，
   永不覆蓋既有檔。因為關卡吃 glob 不綁框架，dk 收編進你現有的 source。
   這不「產生」任何頁面——只放一份註解好的設定，讓你把品味寫成機檢規則。 */
function cmdInit(args, flags, cwd) {
  const preset = flags.preset ? String(flags.preset) : 'recommended';
  if (!PRESETS[preset]) {
    process.stderr.write(M.unknownPreset(preset, Object.keys(PRESETS).join(' / ')));
    return EXIT_USAGE;
  }
  const B = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
  const D = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

  const existing = findConfigFile(cwd);
  if (existing) {
    process.stdout.write(pick(
      `\n已有設定：${relative(cwd, existing)}\ndk init 絕不覆蓋你的檔案。改編輯它，或執行 dk rules 看目前生效的規則。\n\n`,
      `\nConfig already exists: ${relative(cwd, existing)}\ndk init never overwrites your files. Edit it, or run dk rules to see the rules in effect.\n\n`));
    return EXIT_OK;
  }

  // 偵測 targets：掃 repo 找設計相關副檔名，回推最合適的 glob。
  const detected = detectTargets(cwd);
  const targets = detected.length ? detected : ['**/*.{css,scss,less,html,js,jsx,ts,tsx,vue,svelte,astro}'];
  // 偵測 tokens 來源。
  const tokensGuess = ['design/tokens.json', 'tokens.json', 'src/tokens.json'].find((p) => pathExists(join(cwd, p))) ?? 'design/tokens.json';

  const cfg = `// dk.config.mjs — 由 dk init 就地產生（不覆蓋既有檔）。
// 合併順序：內建預設 < preset < 這份。把「品味」寫成會 exit 1 的機檢規則。
export default {
  preset: ${JSON.stringify(preset)}, // recommended | strict | minimal

  tokens: {
    source: ${JSON.stringify(tokensGuess)},   // SSOT——你唯一該手改的設計來源
    output: { css: 'styles/tokens.css' }, // dk build 由此編出；dk verify 驗同步
  },

  // 自動偵測到的掃描範圍（改成你的 component source 路徑）：
  targets: ${JSON.stringify(targets)},
  ignore: ['**/node_modules/**', '**/.dk/**', '**/dist/**', '**/build/**'],

  failOn: 'error', // CI 門檻：error | warn

  // ── 擴充 token 覆蓋 / 自訂 slop 規則（解開即生效）──────
  // tokens_required: ['color.brand.accent'],
  // contrast: { algorithm: 'wcag', modes: ['light','dark'],
  //   pairs: [['color.text.primary','color.surface.raised', 4.5]] },
  // enforce: { spacing: 'warn', radius: 'warn', type: 'warn' },
  // slop: { fonts: { deny: ['Inter','Roboto','DM Sans'] }, rules: [
  //   { id: 'brand/no-glow-shadow', zone: 'style',
  //     pattern: 'filter:\\\\s*drop-shadow', severity: 'warn',
  //     message: '禁止 glow 陰影', hint: '用 var(--shadow-card)' } ] },
  // severity: { 'slop/vanity-number': 'error' },
  // allowlist: { 'slop/hardcoded-color': ['src/embed/**'] },

  baseline: '.dk/baseline.json',
};
`;
  safeWriteFileSync(cwd, join(cwd, 'dk.config.mjs'), cfg);

  // .gitignore：確保 .dk/ 被忽略（只在缺少時 append，不覆蓋）。記錄是否動過、以便如實告知。
  const giPath = join(cwd, '.gitignore');
  let gi = '';
  try { gi = readFileSync(giPath, 'utf8'); } catch { gi = ''; }
  const giExisted = gi.length > 0;
  let giTouched = false;
  if (!/^\.dk\/?\s*$/m.test(gi)) {
    safeWriteFileSync(cwd, giPath, (gi && !gi.endsWith('\n') ? gi + '\n' : gi) + '.dk/\n');
    giTouched = true;
  }

  const hasTokens = pathExists(join(cwd, tokensGuess));

  process.stdout.write(`\n${B(pick('✓ 已寫入', '✓ Wrote'))} dk.config.mjs  ${D('· preset:' + preset)}\n\n`);
  process.stdout.write('  ' + pick('偵測到的 targets：', 'Detected targets:') + '\n');
  for (const t of targets) process.stdout.write(`   ${D('·')} ${t}\n`);
  process.stdout.write(`  ${pick('tokens 來源：', 'tokens source: ')}${tokensGuess}${hasTokens ? '' : D(pick('（尚不存在——設 tokens.source 或先 dk new 借一份 SSOT）', ' (does not exist yet — set tokens.source or run dk new to borrow an SSOT)'))}\n`);
  // 如實告知動過 .gitignore（append 非覆蓋——你既有內容原封不動）。
  if (giTouched) {
    process.stdout.write(`  ${pick('.gitignore：', '.gitignore: ')}${giExisted ? pick('已附加', 'appended') : pick('已建立', 'created')} .dk/ ${D(pick('（只加這一行，不動你既有內容）', '(only this line added; your existing content is untouched)'))}\n`);
  }
  process.stdout.write('\n');
  // 下一步：與「實際可走通的路徑」一致。無 tokens 時 dk verify 會立刻 exit 2，故先補 tokens。
  if (hasTokens) {
    process.stdout.write('  ' + pick('下一步：', 'Next:') + '\n');
    process.stdout.write(`   ${B('dk build')}            ${D(pick('· 由 SSOT 編出 styles/tokens.css', '· compile styles/tokens.css from the SSOT'))}\n`);
    process.stdout.write(`   ${B('dk verify')}           ${D(pick('· 跑整條鏈（編輯 dk.config.mjs 把判斷寫成規則）', '· run the whole chain (edit dk.config.mjs to encode your judgment as rules)'))}\n\n`);
  } else {
    process.stdout.write('  ' + pick('下一步（本 repo 還沒有 tokens——先補上，否則 dk verify 會 exit 2）：', 'Next (no tokens yet — add them first, or dk verify exits 2):') + '\n');
    process.stdout.write(`   ${B('dk new _seed')}        ${D(pick('· 借一份 vetted SSOT：把 _seed/design/tokens.json 複製進 design/', '· borrow a vetted SSOT: copy _seed/design/tokens.json into design/'))}\n`);
    process.stdout.write(`   ${D(pick('· 或在 dk.config.mjs 的 tokens.source 指到你自備的 token 檔', '· or point tokens.source in dk.config.mjs at your own token file'))}\n`);
    process.stdout.write(`   ${B('dk build')} ${D('→')} ${B('dk verify')}  ${D(pick('· 有 tokens 後編產物、再跑整條鏈', '· once you have tokens, compile artifacts then run the whole chain'))}\n\n`);
  }
  return EXIT_OK;
}

// 掃 repo（去掉 node_modules 等），回推最精簡的 targets glob。
function detectTargets(cwd) {
  const exts = new Set();
  const dirs = new Set();
  const SKIP = new Set(['node_modules', '.git', '.dk', 'dist', 'build']);
  let count = 0;
  (function walk(dir, depth) {
    if (depth > 5 || count > 4000) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(abs, depth + 1); continue; }
      // standalone styles、scripts 與常見 component formats 都是 slop gate 的輸入；漏接任何
      // 一類都可能讓 init 後的 verify/baseline/watch 靜默放行。
      const m = /\.(css|scss|less|html|js|jsx|ts|tsx|vue|svelte|astro)$/.exec(e.name);
      if (m) { exts.add(m[1]); dirs.add(relative(cwd, dir).split('\\').join('/')); count++; }
    }
  })(cwd, 0);
  if (!exts.size) return [];
  const extGlob = exts.size === 1 ? [...exts][0] : `{${[...exts].sort().join(',')}}`;
  const topDirs = [...dirs].filter((d) => d && !d.includes('/'));
  if (dirs.has('src') || topDirs.includes('src')) return [`src/**/*.${extGlob}`];
  if (dirs.has('')) return [`*.${extGlob}`, `**/*.${extGlob}`];
  return [`**/*.${extGlob}`];
}

/* ---- verify ---- */
async function cmdVerify(args, flags, cwd) {
  let config = await loadConfig(cwd);
  try { config = applyAppProofCliOverrides(config, flags); }
  catch (error) {
    if (!(error instanceof AppProofConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return EXIT_USAGE;
  }
  if (reportConfigErrors(config)) return EXIT_USAGE;
  if (!pathExists(config.tokensPath)) {
    process.stderr.write(M.tokensMissingVerify(config.tokensPath));
    return EXIT_USAGE;
  }
  // 畸形 2025.10 物件式 token → 教學錯誤 exit 2（不讓畸形值下探到 gate 才 crash）。
  const tvErr = guardTokenValues(config.tokensPath);
  if (tvErr) { process.stderr.write(tvErr); return EXIT_USAGE; }
  // Reject unknown gate ids so a typo cannot produce an empty successful run.
  if (flags.gate === true) {
    process.stderr.write(M.gateNeedsId(KNOWN_GATE_IDS.join(' / ')));
    return EXIT_USAGE;
  }
  if (typeof flags.gate === 'string' && !isKnownGateId(flags.gate)) {
    process.stderr.write(M.unknownGate(flags.gate, KNOWN_GATE_IDS.join(' / ')));
    return EXIT_USAGE;
  }

  const explicitTargets = args.length ? args : undefined;
  const outPath = typeof flags.out === 'string' ? flags.out : null;

  // ── 報告落點：覆寫保護（a）＋ 自我污染阻斷（b）──────────────────────────
  // 落點：--html [path] / --sarif（需 --out 才寫檔）/ --out。無寫檔則 null。
  const reportDest = flags.html ? ((typeof flags.html === 'string' ? flags.html : outPath) ?? 'dk-report.html')
                   : (flags.sarif && outPath) ? outPath
                   : ((flags.json || flags.summary) && outPath) ? outPath
                   : null;
  if (outPath && !flags.html && !flags.sarif && !flags.json && !flags.summary) {
    process.stderr.write(pick('--out 必須搭配 --json、--summary、--sarif 或 --html。\n',
      '--out must be paired with --json, --summary, --sarif, or --html.\n'));
    return EXIT_USAGE;
  }
  if (reportDest) {
    // (a) 落點命中掃描集合（targets ∩ ¬ignore）＝寫出會覆寫使用者來源檔、且下次 verify 掃回污染 → 拒絕。
    const collide = destCollides(reportDest, cwd, explicitTargets ?? config.targets, config.ignore);
    if (collide) { process.stderr.write(collide + '\n'); return EXIT_USAGE; }
    // (b) 把落點併入本次 ignore（自訂落點也不會被本次掃回；預設 dk-report.html 已在 config 預設 ignore）。
    const rrel = relative(cwd, resolvePath(cwd, reportDest)).split(sep).join('/');
    if (!rrel.startsWith('..')) config.ignore = [...config.ignore, rrel];
  }

  const opts = {
    full: !!flags.full,
    requireGates: !!flags['require-gates'],
    only: typeof flags.gate === 'string' ? flags.gate : undefined,
    targets: explicitTargets,
    cache: !flags['no-cache'],
  };
  const result = runChain(config, opts);

  // 明確指定的 positional targets 卻掃到 0 檔＝路徑/glob 打錯：用法錯誤（exit 2），不要靜默綠燈。
  if (explicitTargets && result.filesScanned === 0) {
    process.stderr.write(M.noFilesMatched(explicitTargets.join(' ')));
    return EXIT_USAGE;
  }

  // 輸出表面：summary/json/terminal 直接印；sarif/html 寫檔（或無路徑時印到 stdout），--out 指定路徑、--open 開啟。
  // --summary：限制在約 10KB 的機器表面，避免大型 repo 的完整 JSON 超過子程序 buffer。
  if (flags.summary) return emitSurface('summary', renderSummary(result, config), outPath, cwd, result.exitCode, flags);
  if (flags.json) return emitSurface('json', renderJson(result, config), outPath, cwd, result.exitCode, flags);
  if (flags.sarif) return emitSurface('sarif', renderSarif(result, config), outPath, cwd, result.exitCode, flags);
  if (flags.html) {
    const dest = (typeof flags.html === 'string' ? flags.html : outPath) ?? 'dk-report.html';
    return emitSurface('html', renderHtml(result, config), dest, cwd, result.exitCode, flags);
  }
  process.stdout.write(renderTerminal(result, config, { all: !!flags.all }));
  return result.exitCode;
}

/* 把渲染好的表面寫到檔（或無路徑→stdout）；印確認到 stderr（不污染 stdout 管線）；--open best-effort 開啟。 */
function emitSurface(kind, content, dest, cwd, exitCode, flags) {
  if (!dest) { process.stdout.write(content); return exitCode; }
  const abs = resolvePath(cwd, dest);
  safeWriteFileSync(cwd, abs, content);
  process.stderr.write(`✓ ` + pick('已寫入', 'wrote') + ` ${kind.toUpperCase()} → ${rel(cwd, abs)}\n`);
  if (flags.open) openFile(abs);
  return exitCode;
}
function openFile(p) {
  try {
    if (process.platform === 'win32') {
      // 不經 shell：避免檔名中的 shell 元字元被解讀；空字串是 `start` 的視窗標題佔位。
      spawnSync('cmd', ['/c', 'start', '', p], { stdio: 'ignore' });
    } else {
      spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [p], { stdio: 'ignore' });
    }
  } catch { /* best-effort */ }
}
/* 報告落點命中掃描集合（targets ∩ ¬ignore）＝寫出會覆寫使用者來源檔、下次 verify 又把它掃回污染。
   回傳教學用拒絕訊息，或 null。寫檔層另外強制目標留在 cwd 且不經 symlink。 */
function destCollides(dest, cwd, targets, ignore) {
  if (!dest) return null;
  const abs = resolvePath(cwd, dest);
  const rel = relative(cwd, abs).split(sep).join('/');
  if (rel.startsWith('..') || isAbsolute(rel)) return null; // 由 safe-write 邊界拒絕 cwd 外寫入
  const hit = (targets ?? []).some((g) => globToRegExp(g).test(rel));
  const ignored = (ignore ?? []).some((g) => globToRegExp(g).test(rel));
  if (!hit || ignored) return null;
  const base = rel.split('/').pop();
  return M.destCollide(rel, base);
}
/* ---- watch [globs] ----
   存檔事件只重掃變更檔，並以 ledger merge-by-file 合併；terminal 同時顯示該檔結果與全 repo 摘要。
   tokens.json / dk.config.* 變更 → 全量重跑（全域指紋變了，per-file 快取整簇作廢）。
   per-file 快取讓「一檔改、其餘命中」的增量掃描逼近常數成本。零依賴（fs.watch）。
   以 mtime+size 去抖：同檔 signature 沒變就忽略事件。這同時解 Windows fs.watch 的寫檔
   自觸發、與各編輯器一次存檔噴多個 change 的重複事件（debounce 之外再加一層冪等）。
   recursive watch 不可用時改為逐目錄監看；事件缺少檔名時保守走全量。 */
async function cmdWatch(args, flags, cwd) {
  let config = await loadConfig(cwd);
  if (reportConfigErrors(config)) return EXIT_USAGE;
  if (!pathExists(config.tokensPath)) {
    process.stderr.write(M.tokensMissingWatch(config.tokensPath));
    return EXIT_USAGE;
  }
  const tvErr = guardTokenValues(config.tokensPath);
  if (tvErr) { process.stderr.write(tvErr); return EXIT_USAGE; }
  const targets = args.length ? args : undefined;
  const useCache = !flags['no-cache'];
  const clear = () => { if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H'); };
  const watchTip = () => process.stdout.write('\n  ' + dim2(pick('監看中… 存檔即增量重掃 · tokens/config 變更則全量 · Ctrl-C 結束', 'Watching… save to rescan incrementally · a tokens/config change reruns fully · Ctrl-C to exit')) + '\n');

  const tokensRel = relative(cwd, config.tokensPath).split(sep).join('/');
  const isGlobalChange = (rel) => rel === tokensRel || /(^|\/)dk\.config\.(mjs|js|json)$/.test(rel);

  // 全量重跑（初次 · tokens/config 變更）——重載 config（config 檔可能剛改），走完整核心鏈。
  const runFull = async () => {
    clear();
    try {
      config = await loadConfig(cwd);
      reportConfigErrors(config);
      const result = runChain(config, { full: !!flags.full, requireGates: !!flags['require-gates'], targets, cache: useCache });
      process.stdout.write(renderTerminal(result, config, { all: !!flags.all }));
    } catch (err) {
      process.stdout.write(pick(`watch: 全量重跑失敗：${err.message}\n`, `watch: full rerun failed: ${err.message}\n`));
    }
    watchTip();
  };

  // 增量：只重掃單一變更檔（partial run → merge-by-file 帳本）。印該檔紅綠 ＋ 全 repo 摘要。
  const runIncremental = (rel) => {
    clear();
    let result;
    try {
      result = runChain(config, { only: 'slop', targets: [rel], cache: useCache });
    } catch (err) {
      process.stdout.write(pick(`watch: 增量重掃失敗（${rel}）：${err.message}\n`, `watch: incremental rescan failed (${rel}): ${err.message}\n`));
      watchTip();
      return;
    }
    const own = (result.findings ?? []).filter((f) => f.file === rel && !f.auxiliary);
    const errN = own.filter((f) => f.severity === 'error').length;
    const warnN = own.filter((f) => f.severity === 'warn').length;
    const mark = own.length === 0 ? green2('✓') : errN ? red2('✗') : yellow2('⚠');
    const tail = own.length === 0 ? dim2(pick('乾淨', 'clean')) : dim2(pick(`${errN} error · ${warnN} warn（本檔）`, `${errN} error · ${warnN} warn (this file)`));
    process.stdout.write(`\n  ${mark} ` + pick('增量重掃', 'rescanned') + ` ${rel}  ${tail}\n`);
    for (const f of own.slice(0, 10)) {
      const loc = `${f.file}${f.line ? ':' + f.line : ''}${f.col ? ':' + f.col : ''}`;
      process.stdout.write(`     ${f.severity} ${loc}  ${dim2(f.ruleId)}\n       ${f.message}\n`);
    }
    if (own.length > 10) process.stdout.write(`     ${dim2(pick('… 另有 ' + (own.length - 10) + ' 筆同檔（dk report --json 或 --all 看全部）', '… ' + (own.length - 10) + ' more in this file (dk report --json or --all to see all)'))}\n`);
    // 全 repo 摘要讀「合併後帳本」——merge-by-file 已把本檔刷新回全貌（counts 為全 repo）。
    const rep = readReportJson(cwd);
    if (rep?.counts) {
      const { error = 0, warn = 0, info = 0 } = rep.counts;
      process.stdout.write(`\n  ${dim2(pick('全 repo（合併帳本）：', 'Whole repo (merged ledger): '))}${error} error · ${warn} warn · ${info} info · ${rep.filesScanned ?? '?'} ` + pick('檔', 'files') + `\n`);
    }
    watchTip();
  };

  await runFull();

  // mtime+size 去抖，過濾 Windows 自觸發與編輯器的重複事件。
  const lastSig = new Map(); // repoRel -> `${mtimeMs}:${size}`
  const reallyChanged = (rel) => {
    let st;
    try { st = statSync(join(cwd, rel)); }
    catch {
      // 刪檔必須觸發全量：partial run 的 collected 為空，無法知道要從 ledger 移除哪個舊 finding。
      lastSig.delete(rel);
      return 'deleted';
    }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (lastSig.get(rel) === sig) return false; // signature 沒變＝自觸發/重複事件
    lastSig.set(rel, sig);
    return true;
  };

  // debounce：累積待處理集合，120ms 後一次 flush（全量優先於逐檔增量）。
  let timer = null;
  const pending = new Set();
  let pendingFull = false;
  const flush = () => {
    timer = null;
    if (pendingFull) { pendingFull = false; pending.clear(); runFull(); return; }
    const files = [...pending]; pending.clear();
    for (const rel of files) runIncremental(rel);
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, 120); };

  const RE_WATCH = /\.(css|scss|less|html|js|jsx|ts|tsx|vue|svelte|astro|json|mjs)$/;
  const onEvent = (name) => {
    if (!name) { pendingFull = true; schedule(); return; } // 無檔名 → 保守走全量
    const rel = String(name).split(sep).join('/');
    if (rel.includes('.dk/') || rel.includes('node_modules/')) return; // 別被自己寫的帳本觸發
    if (!RE_WATCH.test(rel)) return;
    const changed = reallyChanged(rel);
    if (!changed) return; // mtime+size 沒變 → 忽略
    if (changed === 'deleted' || isGlobalChange(rel)) { pendingFull = true; schedule(); return; }
    pending.add(rel);
    schedule();
  };

  const watchers = [];
  try {
    watchers.push(watch(cwd, { recursive: true }, (_evt, name) => onEvent(name)));
  } catch {
    // 不支援 recursive 的平台：逐目錄監看現有 source tree，而非只看 token 目錄。
    // 新建深層目錄時事件會先命中父層並觸發全量；重啟 watch 後會納入新目錄。
    const skip = new Set(['node_modules', '.git', '.dk', 'dist', 'build', 'test-results', 'playwright-report']);
    const stack = [cwd];
    while (stack.length && watchers.length < 2000) {
      const dir = stack.pop();
      try {
        watchers.push(watch(dir, (_evt, name) => {
          if (!name) { pendingFull = true; schedule(); return; }
          onEvent(relative(cwd, join(dir, String(name))).split(sep).join('/'));
        }));
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && !skip.has(entry.name)) stack.push(join(dir, entry.name));
        }
      } catch { /* unreadable/disappeared directory: another watched parent will trigger */ }
    }
  }
  // watch 持續執行，直到使用者以 Ctrl-C 結束。
  await new Promise((resolve) => {
    process.on('SIGINT', () => { clearTimeout(timer); for (const w of watchers) { try { w.close(); } catch { /* */ } } process.stdout.write(pick('\n再見。\n', '\nBye.\n')); resolve(); });
  });
  return EXIT_OK;
}
function dim2(s) { return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s; }
function green2(s) { return process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s; }
function red2(s) { return process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s; }
function yellow2(s) { return process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s; }
function readReportJson(cwd) { try { return JSON.parse(readFileSync(join(cwd, '.dk', 'report.json'), 'utf8')); } catch { return null; } }

/* ---- build ---- */
async function cmdBuild(args, flags, cwd) {
  const config = await loadConfig(cwd);
  if (reportConfigErrors(config)) return EXIT_USAGE;
  if (!pathExists(config.tokensPath)) {
    process.stderr.write(M.tokensMissing(config.tokensPath));
    return EXIT_USAGE;
  }
  const tvErr = guardTokenValues(config.tokensPath);
  if (tvErr) { process.stderr.write(tvErr); return EXIT_USAGE; }
  const tokens = loadTokens(config.tokensPath);
  const formats = flags.format ? String(flags.format).split(',') : (config.formats.length ? config.formats : ['css']);
  const out = compile(tokens, { formats });

  const outputs = { ...config.output };
  if (!outputs.css && formats.includes('css')) outputs.css = join(cwd, 'styles', 'tokens.css');

  const targets = [];
  for (const fmt of formats) {
    const dest = outputs[fmt];
    const content = out[fmt];
    if (!dest || content == null) continue;
    targets.push([fmt, dest, content]);
  }
  // 被要求、卻沒有設定輸出路徑的格式（如 --format js 但 config.tokens.output.js 未設）——明說略過，不假裝成功。
  const unconfigured = formats.filter((fmt) => out[fmt] != null && !outputs[fmt]);
  for (const fmt of unconfigured) {
    process.stderr.write(pick(
      `⚠ 格式 '${fmt}' 沒有設定輸出路徑（config.tokens.output.${fmt}）——略過。\n`,
      `⚠ Format '${fmt}' has no output path configured (config.tokens.output.${fmt}) — skipped.\n`));
  }

  const resolvedPath = join(cwd, '.dk', 'tokens.resolved.json');

  if (flags.check) {
    if (!targets.length) {
      process.stderr.write(M.buildCheckNoArtifacts(formats.join(', ')));
      return EXIT_USAGE;
    }
    let drift = false;
    for (const [fmt, dest, content] of targets) {
      let disk = null;
      try { disk = readFileSync(dest, 'utf8'); } catch { disk = null; }
      if (disk !== content) {
        drift = true;
        process.stderr.write(pick(
          `✗ ${rel(cwd, dest)}（${fmt}）與 SSOT 不同步 — 執行 dk build\n`,
          `✗ ${rel(cwd, dest)} (${fmt}) is out of sync with the SSOT — run dk build\n`));
      }
    }
    if (drift) return EXIT_FAIL;
    process.stdout.write(pick(
      `✓ 產物與 SSOT 同步（${targets.map((t) => t[0]).join(', ')}）\n`,
      `✓ Artifacts in sync with the SSOT (${targets.map((t) => t[0]).join(', ')})\n`));
    return EXIT_OK;
  }

  if (!targets.length) {
    process.stderr.write(M.buildNoArtifacts(formats.join(', ')));
    return EXIT_USAGE;
  }
  for (const [fmt, dest, content] of targets) {
    safeWriteFileSync(cwd, dest, content);
  }
  safeWriteFileSync(cwd, resolvedPath, JSON.stringify(out.resolved, null, 2) + '\n');
  process.stdout.write(pick(
    `✓ 已編譯 ${out.tokenCount} tokens（${out.darkCount} 深色覆寫）→ ${targets.map((t) => rel(cwd, t[1])).join(', ')}\n`,
    `✓ Compiled ${out.tokenCount} tokens (${out.darkCount} dark overrides) → ${targets.map((t) => rel(cwd, t[1])).join(', ')}\n`));
  process.stdout.write(`  tokenHash ${out.tokenHash}\n`);
  return EXIT_OK;
}

/* ---- fix ----
   只套用機械式、安全的修正——刻意受限的白名單，是守住「非生成器」底線的關鍵之一：
     (1) 重編 tokens.css（把產物拉回與 SSOT 同步）
     (2) stylelint --fix（若已安裝）
     (3) --slop：SSOT 精確反查替換寫死色（見 cmdFixSlop）
   三者都校正既有值，永不發明內容、版面或顏色——從不作曲。 */
async function cmdFix(args, flags, cwd) {
  const config = await loadConfig(cwd);
  if (reportConfigErrors(config)) return EXIT_USAGE;
  if (!pathExists(config.tokensPath)) {
    process.stderr.write(M.tokensMissing(config.tokensPath));
    return EXIT_USAGE;
  }
  const tvErr = guardTokenValues(config.tokensPath);
  if (tvErr) { process.stderr.write(tvErr); return EXIT_USAGE; }
  // --slop：聚焦模式——只做寫死色的「SSOT 精確反查替換」（第三種白名單動作），不重編/不轉包 stylelint。
  if (flags.slop) return cmdFixSlop(args, flags, cwd, config);
  const B = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
  const D = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
  process.stdout.write(`\n${B('dk fix')} ${D(pick('· 白名單機械修正：只重編產物、跑 stylelint --fix，絕不發明內容', '· allowlisted mechanical fixes: only recompile artifacts and run stylelint --fix, never inventing content'))}\n\n`);

  // 1) 重編 tokens.css（及設定的其他格式）——把產物拉回與 SSOT 同步。
  const rebuilt = await cmdBuild([], {}, cwd);
  if (rebuilt !== EXIT_OK) return rebuilt;

  // 2) stylelint --fix（僅在已安裝時；缺依賴則優雅跳過，指向 dk doctor）。
  const hasStylelint = await hasModule('stylelint', cwd);
  if (!hasStylelint) {
    process.stdout.write(`  ${D('·')} ` + pick('stylelint 未安裝——略過 CSS 自動修正。', 'stylelint not installed — skipping CSS autofix.') + ` ${D(pick('要啟用：dk doctor', 'to enable: dk doctor'))}\n`);
  } else {
    const globs = config.targets.filter((g) => /css/.test(g));
    const styleTargets = globs.length ? globs : ['styles/**/*.css'];
    process.stdout.write(`  ${D('·')} stylelint --fix ${styleTargets.join(' ')}\n`);
    const r = spawnSync('npx', ['stylelint', '--fix', ...styleTargets], { cwd, stdio: 'inherit' });
    if (r.status !== 0 && r.status != null) process.stdout.write(`  ${D(pick('（stylelint 回報仍有無法自動修的項目——請手動處理。）', '(stylelint reports items it could not auto-fix — please handle them manually.)'))}\n`);
  }
  process.stdout.write(`\n  ${D(pick('修正完成。跑 dk verify 確認鏈是否翻綠。', 'Fixes done. Run dk verify to confirm the chain turns green.'))}\n\n`);
  return EXIT_OK;
}

/* ---- fix --slop ----
   第三種白名單機械動作：把「寫死 #hex ＝ 某 semantic token 的 light 解析值」的宣告，替換成
   var(--token)。這仍是校正、不是作曲——值全數來自使用者自己的 tokens.json（SSOT），替換是逐
   字元的雙射改寫（`#0071e3` ⇄ `var(--color-brand-accent)`），不是生成。三條哲學紅線：
     1) 只做 exact-match（與 token 解析值完全相等）；無法 exact 的一律不動、列為「需人工」。
     2) 三層選擇 deterministic：優先 semantic；多個 semantic 同值＝歧義，跳過並可見列出（絕不猜）。
     3) 只在 slop 關卡認定的 style zone 內替換；HTML 屬性/非 style 語境、含 dk-ignore 的行、
        allowlist 檔一律不動（尊重既有逃生口）。
   反查判定全在 slop.mjs（buildColorFixIndex / scanColorFixes）——與偵測共用同一組 RE_HEX /
   styleZoneRanges / normHex，確保「替換處」與「slop 認定寫死色處」是同一集合。 */
async function cmdFixSlop(args, flags, cwd, config) {
  const dryRun = !!flags['dry-run'];
  const B = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
  const D = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
  process.stdout.write(`\n${B('dk fix --slop')} ${D(pick('· SSOT 精確反查替換寫死色（僅 exact-match、優先 semantic）', '· exact SSOT reverse-lookup replacement of hardcoded colors (exact-match only, semantic-first)') + (dryRun ? ' · dry-run' : ''))}\n\n`);

  // 1) 反查索引（僅 color token、僅 light 解析值——見 slop.mjs buildColorFixIndex 註解）。
  const manifest = buildManifest(loadTokens(config.tokensPath));
  const fixIndex = buildColorFixIndex(manifest);

  // 2) 依 collectFiles 的 ignore 與 2MB 上限蒐集 targets；明確 targets 掃 0 檔屬用法錯誤。
  const explicitTargets = args.length ? args : undefined;
  const files = collectFiles(cwd, explicitTargets ?? config.targets, config.ignore);
  if (explicitTargets && files.length === 0) {
    process.stderr.write(M.noFilesMatched(explicitTargets.join(' ')));
    return EXIT_USAGE;
  }

  // 3) 逃生口：dk-ignore 行內抑制 ＋ allowlist 檔級豁免（一律不動）。
  const ignoreIndex = buildIgnoreIndex(files);
  const allowGlobs = (config.allowlist?.['slop/hardcoded-color'] ?? []).map(globToRegExp);
  const isAllowedFile = (p) => allowGlobs.some((re) => re.test(p));

  // 4) 逐檔掃描、分類（用檔內既有 source，不重讀檔）。
  const applied = [];    // { file, line, hex, token }
  const ambiguous = [];  // { file, line, hex, names }
  const manual = [];     // { file, line, hex, kind, names? }
  let ignoredN = 0, allowedN = 0;
  const editsByFile = new Map(); // path -> { source, edits:[{hexStart,hexEnd,replacement}] }

  for (const { path, source } of files) {
    if (isAllowedFile(path)) { allowedN++; continue; }
    for (const c of scanColorFixes(source, path, fixIndex)) {
      if (isSuppressed(ignoreIndex, { file: path, line: c.line, ruleId: 'slop/hardcoded-color' })) { ignoredN++; continue; }
      if (c.decision.kind === 'exact') {
        applied.push({ file: path, line: c.line, hex: c.hex, token: c.decision.name });
        let bucket = editsByFile.get(path);
        if (!bucket) editsByFile.set(path, bucket = { source, edits: [] });
        bucket.edits.push({ hexStart: c.hexStart, hexEnd: c.hexEnd, replacement: `var(--${c.decision.name})` });
      } else if (c.decision.kind === 'ambiguous') {
        ambiguous.push({ file: path, line: c.line, hex: c.hex, names: c.decision.names });
      } else {
        manual.push({ file: path, line: c.line, hex: c.hex, kind: c.decision.kind, names: c.decision.names });
      }
    }
  }

  // 5) 套用（dry-run 不寫）——每檔由後往前替換，避免前面的替換使後面的位移飄移。
  if (!dryRun) {
    for (const [path, { source, edits }] of editsByFile) {
      edits.sort((a, b) => b.hexStart - a.hexStart);
      let next = source;
      for (const e of edits) next = next.slice(0, e.hexStart) + e.replacement + next.slice(e.hexEnd);
      safeWriteFileSync(cwd, resolvePath(cwd, path), next);
    }
  }

  // 6) 輸出清單（file:line、before→after；findings 相關輸出維持 zh-TW）。
  const verb = pick(dryRun ? '將替換' : '已替換', dryRun ? 'Will replace' : 'Replaced');
  const sites = (n) => pick(`${n} 處`, `${n} ${n === 1 ? 'site' : 'sites'}`);
  if (applied.length) {
    process.stdout.write(`  ${B(verb + ' ' + sites(applied.length))} ${D(pick('（寫死色 → var(--token)，值來自你的 SSOT）：', '(hardcoded color → var(--token), values from your SSOT):'))}\n`);
    for (const a of applied) process.stdout.write(`   ${D('·')} ${a.file}:${a.line}  ${a.hex} → ${B('var(--' + a.token + ')')}\n`);
  } else {
    process.stdout.write(`  ${D(pick('精確反查替換：0 處（沒有可 exact-match 的寫死色）。', 'Exact reverse-lookup replacement: 0 sites (no exact-matchable hardcoded colors).'))}\n`);
  }
  if (ambiguous.length) {
    process.stdout.write(`\n  ${B(pick('歧義未動 ' + ambiguous.length + ' 處', 'Ambiguous, left untouched: ' + sites(ambiguous.length)))} ${D(pick('（多個 semantic token 同值——絕不猜，交你決定）：', '(multiple semantic tokens share the value — never guessing, your call):'))}\n`);
    for (const a of ambiguous) process.stdout.write(`   ${D('·')} ${a.file}:${a.line}  ${a.hex} ${D(pick('同時是', 'is both'))} ${a.names.map((n) => 'var(--' + n + ')').join(' / ')}\n`);
  }
  if (manual.length) {
    process.stdout.write(`\n  ${B(pick('需人工 ' + manual.length + ' 處', 'Needs manual: ' + sites(manual.length)))} ${D(pick('（無精確對應的 token——不發明值）：', '(no exact-matching token — no invented values):'))}\n`);
    for (const a of manual) {
      const note = a.kind === 'primitive-only'
        ? D(pick('僅對應 primitive ' + a.names.map((n) => '--' + n).join('/') + '（元件應改用 semantic 層，不自動注入 primitive）',
                 'only maps to primitive ' + a.names.map((n) => '--' + n).join('/') + ' (components should use the semantic layer; primitives are not auto-injected)'))
        : D(pick('SSOT 中無此色——請先抬進 tokens.json 再改用 var(--token)',
                 'this color is not in the SSOT — lift it into tokens.json first, then use var(--token)'));
      process.stdout.write(`   ${D('·')} ${a.file}:${a.line}  ${a.hex}  ${note}\n`);
    }
  }
  if (ignoredN || allowedN) {
    process.stdout.write(`\n  ${D(pick('尊重逃生口：dk-ignore ' + ignoredN + ' 處、allowlist 檔 ' + allowedN + ' 個——未動。',
             'Respecting escape hatches: dk-ignore ' + ignoredN + ', allowlisted files ' + allowedN + ' — left untouched.'))}\n`);
  }

  // 7) 自動重驗改動檔，回報仍存在的寫死色。
  if (!dryRun && editsByFile.size) {
    const changed = [...editsByFile.keys()];
    const res = runChain(config, { only: 'slop', targets: changed });
    const remain = res.findings.filter((f) => f.ruleId === 'slop/hardcoded-color' && changed.includes(f.file));
    if (remain.length === 0) {
      process.stdout.write(`\n  ${B(pick('✓ 重驗改動檔', '✓ Re-verified changed files'))} ${D(pick('· ' + changed.join(' ') + ' 已無寫死色 finding（紅翻綠）', '· ' + changed.join(' ') + ' has no hardcoded-color finding left (red → green)'))}\n`);
    } else {
      process.stdout.write(`\n  ${D(pick('重驗改動檔：仍有 ' + remain.length + ' 處寫死色未動（歧義/需人工，本就不由機械處理）。',
             'Re-verified changed files: ' + remain.length + ' hardcoded color(s) still untouched (ambiguous/manual — not handled mechanically by design).'))}\n`);
    }
  }

  // 8) 輸出此次機械修正的邊界。
  process.stdout.write(`\n  ${D(pick(
    (dryRun ? '這是 dry-run（未寫檔）。' : '') + '僅做 SSOT 精確反查替換，未發明任何值——絕不作曲。',
    (dryRun ? 'This is a dry-run (nothing written). ' : '') + 'Only exact SSOT reverse-lookup replacement — no invented values, never composes.'))}\n\n`);
  return EXIT_OK;
}

/* ---- design <init|check|prompt|lock|history> ----
   AI 美感層的 deterministic seam：CLI 不呼叫模型，而是建立／驗證／編譯／鎖定
   compact direction contract。真正的探索、建造與證據式驗收由單一 dk-design skill 路由；
   一旦選定，contract hash 便進核心帳本與 visual baseline metadata。 */
async function cmdDesign(args, flags, cwd) {
  const sub = args[0] ?? 'help';
  if (sub === 'help') { printHelp('design'); return EXIT_OK; }
  if (!['init', 'check', 'prompt', 'lock', 'history'].includes(sub)) {
    process.stderr.write(pick(
      `未知子命令：dk design ${sub}（init | check | prompt | lock | history）\n`,
      `Unknown subcommand: dk design ${sub} (init | check | prompt | lock | history)\n`));
    return EXIT_USAGE;
  }

  const config = await loadConfig(cwd);
  if (reportConfigErrors(config)) return EXIT_USAGE;
  const source = config.directionPath;
  const lockPath = config.directionLockPath ?? join(dirname(source), 'direction.lock.json');
  const historyPath = defaultApprovalHistoryPath(lockPath);
  const relSource = relative(cwd, source) || 'design/direction.json';
  const relLock = relative(cwd, lockPath) || 'design/direction.lock.json';
  const relHistory = relative(cwd, historyPath) || 'design/approval-history.json';

  if (sub === 'history') {
    const loadedHistory = readApprovalHistory(historyPath);
    const surface = approvalHistorySurface(loadedHistory, relHistory);
    if (flags.json) process.stdout.write(`${JSON.stringify(surface, null, 2)}\n`);
    else renderApprovalHistory(surface);
    return loadedHistory.ok ? EXIT_OK : EXIT_FAIL;
  }

  if (sub === 'init') {
    if (existsSync(source)) {
      process.stderr.write(pick(
        `拒絕覆寫既有方向契約：${relSource}\n`,
        `Refusing to overwrite the existing direction contract: ${relSource}\n`));
      return EXIT_USAGE;
    }
    safeWriteFileSync(cwd, source, JSON.stringify(createDirectionTemplate(), null, 2) + '\n');
    process.stdout.write(pick(
      `\n✓ 已建立 ${relSource}\n\n  這是未完成的 draft，不是風格 preset。下一步讓 dk UI Director：\n  1. 用相同內容探索三個真正不同的方向\n  2. 選定並填完契約、把 status 改成 approved\n  3. 執行 dk design check，再用 dk design lock --accept 建立 Taste Lock\n\n`,
      `\n✓ Created ${relSource}\n\n  This is an unfinished draft, not a style preset. Next, have dk UI Director:\n  1. Explore three genuinely different directions with the same content\n  2. Select one, complete the contract, and set status to approved\n  3. Run dk design check, then create the Taste Lock with dk design lock --accept\n\n`));
    return EXIT_OK;
  }

  const loaded = readDirectionDocument(source, relSource);
  if (!loaded.ok) {
    process.stderr.write(loaded.message + '\n');
    return loaded.missing ? EXIT_USAGE : EXIT_FAIL;
  }
  const tokenLoad = safeLoadTokens(config.tokensPath);
  const resolveToken = tokenLoad.ok ? (path, mode) => resolve(tokenLoad.tokens, path, mode) : undefined;
  const issues = validateDirection(loaded.doc, { resolveToken });
  if (!tokenLoad.ok) issues.push({
    code: 'token-binding', severity: 'error', path: 'bindings',
    message: pick(`無法載入 token SSOT：${tokenLoad.error}`,
      `The token SSOT could not be loaded: ${tokenLoad.error}`),
    fix: pick('先修復 design/tokens.json；Taste Lock 不會在無法驗證 token bindings 時建立。',
      'Fix design/tokens.json first; Taste Lock is never created while token bindings cannot be verified.'),
  });
  const directionHash = hashDirection(loaded.doc);
  const bindingHash = hashDirectionBindings(loaded.doc, resolveToken);
  const lockState = inspectDirectionLock(lockPath, directionHash, bindingHash);
  const approvalState = inspectApprovalHistory(historyPath, lockState.lock);
  if (approvalState.status === 'invalid' || approvalState.status === 'stale') issues.push({
    code: 'approval-history', severity: 'error', path: relHistory,
    message: approvalState.status === 'invalid'
      ? pick('設計核准歷史已損壞或被改寫，無法證明 Taste Lock 的決策鏈。',
        'The design approval history is corrupt or rewritten, so the Taste Lock decision chain cannot be proven.')
      : pick('設計核准歷史的最新紀錄與 Taste Lock 不一致。',
        'The latest design approval record does not match the Taste Lock.'),
    fix: pick('從版本控制還原核准歷史；不要覆寫或刪除既有 entry。',
      'Restore the approval history from version control; never overwrite or delete an existing entry.'),
  });
  const check = {
    schema: 'dk-design-check/v1',
    status: issues.some((i) => i.severity === 'error') || lockState.status === 'drift' || lockState.status === 'invalid'
      ? 'failed'
      : loaded.doc.status === 'draft' || lockState.status === 'missing' || approvalState.status === 'missing' ? 'incomplete' : 'passed',
    direction: relSource,
    directionName: loaded.doc.name ?? null,
    directionStatus: loaded.doc.status ?? null,
    directionHash,
    bindingHash,
    lock: relLock,
    lockStatus: lockState.status,
    approvalHistory: relHistory,
    approvalStatus: approvalState.status,
    approvalCount: approvalState.count,
    approvalHeadHash: approvalState.headHash,
    issues,
  };

  if (sub === 'check') {
    if (flags.json) process.stdout.write(JSON.stringify(check, null, 2) + '\n');
    else renderDirectionCheck(check);
    return check.status === 'failed' ? EXIT_FAIL : EXIT_OK;
  }

  if (sub === 'prompt') {
    if (check.status === 'failed' || loaded.doc.status !== 'approved') {
      renderDirectionCheck(check);
      process.stderr.write(pick(
        '\n方向必須完成、approved，且不得與既有 Taste Lock 飄移，才能編譯成 AI build prompt。\n',
        '\nThe direction must be complete, approved, and free of drift from an existing Taste Lock before it can compile into an AI build prompt.\n'));
      return EXIT_FAIL;
    }
    process.stdout.write(renderDirectionPrompt(loaded.doc));
    return EXIT_OK;
  }

  // lock
  if (issues.some((i) => i.severity === 'error') || loaded.doc.status !== 'approved') {
    renderDirectionCheck(check);
    process.stderr.write(pick(
      '\n拒絕鎖定：先修完方向契約並把 status 設成 approved。\n',
      '\nRefusing to lock: fix the direction contract and set status to approved first.\n'));
    return EXIT_FAIL;
  }
  if (lockState.status === 'matched' && approvalState.status === 'verified') {
    process.stdout.write(pick(
      `\n✓ Taste Lock 已是最新：contract ${shortHash(directionHash)} · bindings ${shortHash(bindingHash)} · ${relLock}\n\n`,
      `\n✓ Taste Lock is current: contract ${shortHash(directionHash)} · bindings ${shortHash(bindingHash)} · ${relLock}\n\n`));
    return EXIT_OK;
  }
  if (lockState.status === 'matched' && approvalState.status === 'missing' && !flags.accept) {
    process.stdout.write(pick(
      `\n△ Taste Lock hash 已相符，但尚無可追溯核准歷史：${relHistory}\n  以 dk design lock --accept --reason <採用原因> 將現有 lock 升級成 P3 防竄改決策鏈。\n\n`,
      `\n△ Taste Lock hashes match, but there is no traceable approval history: ${relHistory}\n  Upgrade the existing lock to the P3 tamper-evident decision chain with dk design lock --accept --reason <why>.\n\n`));
    return EXIT_OK;
  }
  if (!flags.accept) {
    process.stdout.write(pick(
      `\nTaste Lock 預覽（未寫檔）\n  direction  ${loaded.doc.name}\n  contract   ${directionHash}\n  bindings   ${bindingHash}\n  lock       ${relLock}\n\n審查方向後，以 dk design lock --accept 明確接受。\n\n`,
      `\nTaste Lock preview (no file written)\n  direction  ${loaded.doc.name}\n  contract   ${directionHash}\n  bindings   ${bindingHash}\n  lock       ${relLock}\n\nAfter reviewing the direction, explicitly accept it with dk design lock --accept.\n\n`));
    return EXIT_OK;
  }
  const previous = lockState.lock && validateDirectionLock(lockState.lock) ? lockState.lock : null;
  const historyBefore = readApprovalHistory(historyPath);
  if (!historyBefore.ok || (previous?.approvalHeadHash && (historyBefore.missing || historyBefore.history.entries.length === 0))) {
    process.stderr.write(pick(
      `\n拒絕更新：${relHistory} 的防竄改鏈驗證失敗。請先從版本控制還原。\n`,
      `\nRefusing to update: the tamper-evident chain in ${relHistory} failed verification. Restore it from version control first.\n`));
    return EXIT_FAIL;
  }
  if (previous && !flags.reason) {
    process.stderr.write(pick(
      '\n更新既有 Taste Lock 必須用 --reason <原因> 留下刻意改版的審查理由。\n',
      '\nUpdating an existing Taste Lock requires --reason <why> so the intentional redesign has a review record.\n'));
    return EXIT_USAGE;
  }
  const approval = appendApproval(cwd, historyPath, {
    directionName: loaded.doc.name,
    directionHash,
    bindingHash,
    actor: resolveApprovalActor(flags.actor),
    reason: flags.reason,
    evidence: readVerificationEvidence(cwd),
  });
  safeWriteFileSync(cwd, lockPath, JSON.stringify(createDirectionLock(loaded.doc, previous, {
    bindingHash,
    approvalHeadHash: approval.headHash,
  }), null, 2) + '\n');
  process.stdout.write(pick(
    `\n✓ Taste Lock 已${previous ? '更新' : '建立'}：contract ${shortHash(directionHash)} · bindings ${shortHash(bindingHash)} · ${relLock}\n  核准 ${approval.entry.id} 已追加到 ${relHistory}；後續 drift 或歷史竄改都會被擋下。\n\n`,
    `\n✓ Taste Lock ${previous ? 'updated' : 'created'}: contract ${shortHash(directionHash)} · bindings ${shortHash(bindingHash)} · ${relLock}\n  Approval ${approval.entry.id} was appended to ${relHistory}; later drift or history tampering is blocked.\n\n`));
  return EXIT_OK;
}

function readDirectionDocument(source, display) {
  if (!existsSync(source)) return {
    ok: false, missing: true,
    message: pick(`找不到方向契約：${display}\n先執行 dk design init。`,
      `Direction contract not found: ${display}\nRun dk design init first.`),
  };
  try { return { ok: true, doc: JSON.parse(readFileSync(source, 'utf8')) }; }
  catch (err) { return {
    ok: false, missing: false,
    message: pick(`方向契約不是合法 JSON（${display}）：${err.message}`,
      `Direction contract is not valid JSON (${display}): ${err.message}`),
  }; }
}
function safeLoadTokens(path) {
  try { return { ok: true, tokens: loadTokens(path), error: null }; }
  catch (err) { return { ok: false, tokens: null, error: err?.message ?? String(err) }; }
}
function inspectDirectionLock(path, currentHash, currentBindingHash) {
  if (!existsSync(path)) return { status: 'missing', lock: null };
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8'));
    if (!validateDirectionLock(lock)) return { status: 'invalid', lock };
    return {
      status: lock.directionHash === currentHash && lock.bindingHash === currentBindingHash ? 'matched' : 'drift',
      lock,
      directionChanged: lock.directionHash !== currentHash,
      bindingsChanged: lock.bindingHash !== currentBindingHash,
    };
  } catch { return { status: 'invalid', lock: null }; }
}
function inspectApprovalHistory(path, lock) {
  const loaded = readApprovalHistory(path);
  const lockRequiresHistory = typeof lock?.approvalHeadHash === 'string';
  if (loaded.missing && lockRequiresHistory) return {
    status: 'invalid', count: 0, headHash: null,
    issues: [{ code: 'missing-history', message: 'Taste Lock commits to an approval history that is missing.' }],
  };
  if (!loaded.ok) return {
    status: 'invalid', count: loaded.history?.entries?.length ?? 0,
    headHash: loaded.headHash, issues: loaded.issues,
  };
  const entries = loaded.history.entries;
  if (!entries.length) return lockRequiresHistory
    ? { status: 'invalid', count: 0, headHash: null, issues: [{ code: 'empty-history', message: 'Taste Lock commits to an empty approval history.' }] }
    : { status: 'missing', count: 0, headHash: null, issues: [] };
  const latest = entries.at(-1);
  const stale = validateDirectionLock(lock)
    && (latest.directionHash !== lock.directionHash || latest.bindingHash !== lock.bindingHash
      || (lock.approvalHeadHash && lock.approvalHeadHash !== loaded.headHash));
  return {
    status: stale ? 'stale' : 'verified', count: entries.length,
    headHash: loaded.headHash, latest, issues: [],
  };
}
function approvalHistorySurface(loaded, displayPath) {
  return {
    schema: 'dk-approval-history-check/v1',
    status: loaded.ok ? (loaded.history.entries.length ? 'verified' : 'empty') : 'invalid',
    path: displayPath,
    count: loaded.history?.entries?.length ?? 0,
    headHash: loaded.headHash,
    issues: loaded.issues,
    entries: loaded.history?.entries ?? [],
  };
}
function renderApprovalHistory(surface) {
  const icon = surface.status === 'invalid' ? '✗' : surface.status === 'empty' ? '△' : '✓';
  process.stdout.write(`\n${icon} dk design history · ${surface.status}\n`);
  process.stdout.write(`  ${surface.path} · ${surface.count} ${pick('筆核准', 'approval(s)')} · head ${shortHash(surface.headHash)}\n`);
  for (const entry of surface.entries) {
    const evidence = entry.evidence?.status ? ` · evidence:${entry.evidence.status}` : '';
    process.stdout.write(`\n  ${entry.createdAt} · ${entry.action} · ${entry.id}${evidence}\n`);
    process.stdout.write(`    ${entry.directionName} · contract ${shortHash(entry.directionHash)} · bindings ${shortHash(entry.bindingHash)}\n`);
    process.stdout.write(`    ${entry.actor} — ${entry.reason}\n`);
  }
  for (const issue of surface.issues) process.stdout.write(`\n  ✗ ${issue.code}: ${issue.message}\n`);
  if (surface.status === 'empty') process.stdout.write(`\n  ${pick('尚無核准；以 dk design lock --accept 建立第一筆。', 'No approval yet; create the first with dk design lock --accept.')}\n`);
  process.stdout.write('\n');
}
function renderDirectionCheck(check) {
  const icon = check.status === 'failed' ? '✗' : check.status === 'incomplete' ? '△' : '✓';
  process.stdout.write(`\n${icon} dk design check · ${check.status}\n`);
  process.stdout.write(`  ${pick('方向', 'direction')}  ${check.directionName ?? '(unnamed)'} · ${shortHash(check.directionHash)}\n`);
  process.stdout.write(`  ${pick('綁定', 'bindings')}  ${shortHash(check.bindingHash)}\n`);
  process.stdout.write(`  ${pick('狀態', 'status')}    ${check.directionStatus} · lock:${check.lockStatus}\n`);
  process.stdout.write(`  ${pick('核准', 'approval')}  ${check.approvalStatus} · ${check.approvalCount} · head ${shortHash(check.approvalHeadHash)}\n`);
  for (const issue of check.issues) {
    const mark = issue.severity === 'error' ? '✗' : '△';
    process.stdout.write(`\n  ${mark} [${issue.severity}] ${issue.path}\n    ${issue.message}\n    → ${issue.fix}\n`);
  }
  if (!check.issues.length) process.stdout.write(`\n  ${pick('契約結構與 token bindings 通過。', 'Contract structure and token bindings pass.')}\n`);
  if (check.lockStatus === 'drift') process.stdout.write(`\n  ✗ ${pick('direction hash 與 Taste Lock 不一致。', 'Direction hash does not match the Taste Lock.')}\n`);
  if (check.lockStatus === 'invalid') process.stdout.write(`\n  ✗ ${pick('Taste Lock 格式無效。', 'Taste Lock format is invalid.')}\n`);
  if (check.lockStatus === 'missing') process.stdout.write(`\n  △ ${pick('尚未建立 Taste Lock。', 'No Taste Lock exists yet.')}\n`);
  process.stdout.write('\n');
}
function shortHash(hash) { return hash ? String(hash).slice(0, 8) : '(none)'; }

/* ---- tokens <list|contrast|coverage|diff|import> ---- */
async function cmdTokens(args, flags, cwd) {
  const sub = args[0] ?? 'list';
  // import 是格式搬運，不需既有 config/SSOT——在載入前分派。
  if (sub === 'import') return cmdTokensImport(args, flags, cwd);
  const config = await loadConfig(cwd);
  if (!pathExists(config.tokensPath)) {
    process.stderr.write(M.tokensMissing(config.tokensPath));
    return EXIT_USAGE;
  }
  const tvErr = guardTokenValues(config.tokensPath);
  if (tvErr) { process.stderr.write(tvErr); return EXIT_USAGE; }
  const tokens = loadTokens(config.tokensPath);
  const manifest = buildManifest(tokens);

  if (sub === 'list') {
    if (flags.json) { process.stdout.write(JSON.stringify(Object.fromEntries(manifest.flat), null, 2) + '\n'); return EXIT_OK; }
    for (const [name, v] of manifest.flat) {
      const dark = v.dark !== v.light ? `  (dark: ${v.dark})` : '';
      process.stdout.write(`${name.padEnd(30)} ${v.light}${dark}\n`);
    }
    process.stdout.write(`\n${manifest.count} tokens · ${manifest.darkCount} ` + pick('深色覆寫', 'dark overrides') + ` · tokenHash ${manifest.tokenHash}\n`);
    return EXIT_OK;
  }

  if (sub === 'contrast') {
    const algo = config.contrast.algorithm;
    const measure = algo === 'apca' ? apca : wcag;
    const pairs = dedupePairs([
      ['color.text.primary', 'color.surface.page', 4.5],
      ['color.text.secondary', 'color.surface.page', 4.5],
      ['color.text.muted', 'color.surface.page', 3.0],
      ['color.text.on-accent', 'color.brand.accent', 4.5],
      ['color.text.link', 'color.surface.page', 4.5],
      ...config.contrast.pairs,
    ]);
    const rows = [];
    for (const [fg, bg, min] of pairs) {
      for (const mode of config.contrast.modes) {
        const f = resolve(tokens, fg, mode), b = resolve(tokens, bg, mode);
        const val = (f && b) ? measure(f, b) : null;
        const ok = val != null && val >= min;
        rows.push({ fg, bg, mode, min, val, ok, note: val == null ? pick('(非 hex / 缺 token)', '(non-hex / missing token)') : '' });
      }
    }
    if (flags.json) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return EXIT_OK; }
    process.stdout.write(pick(`對比（${algo}）— fg on bg [mode]  值 / 門檻\n\n`, `Contrast (${algo}) — fg on bg [mode]  value / threshold\n\n`));
    for (const r of rows) {
      const mark = r.val == null ? '·' : r.ok ? '✓' : '✗';
      const v = r.val == null ? r.note : (algo === 'apca' ? `Lc ${r.val.toFixed(1)}` : `${r.val.toFixed(2)}:1`);
      process.stdout.write(`  ${mark} ${r.fg} on ${r.bg} [${r.mode}]  ${v} / ${r.min}\n`);
    }
    return EXIT_OK;
  }

  if (sub === 'coverage') {
    const result = runChain(config, { only: 'slop' });
    const used = new Set((result.emits.usedTokens ?? []).map((t) => t.replace(/^--/, '')));
    const semantic = [...manifest.flat.keys()].filter((n) => !n.startsWith('color-base-'));
    const unused = semantic.filter((n) => !used.has(n));
    if (flags.json) { process.stdout.write(JSON.stringify({ used: [...used], unused }, null, 2) + '\n'); return EXIT_OK; }
    process.stdout.write(pick(`token 覆蓋 — targets 用到 ${used.size} 個 var(--token)\n\n`, `Token coverage — targets use ${used.size} var(--token)\n\n`));
    if (!unused.length) process.stdout.write('  ✓ ' + pick('所有語意 token 都被用到', 'every semantic token is used') + '\n');
    else { process.stdout.write('  ' + pick(`未被 targets 使用的語意 token（${unused.length}）：`, `Semantic tokens not used by targets (${unused.length}):`) + '\n'); for (const n of unused) process.stdout.write(`    · --${n}\n`); }
    return EXIT_OK;
  }

  if (sub === 'diff') {
    const other = args[1];
    if (!other || !pathExists(other)) { process.stderr.write(M.tokensDiffUsage()); return EXIT_USAGE; }
    const otherErr = guardTokenValues(resolvePath(cwd, other));
    if (otherErr) { process.stderr.write(otherErr); return EXIT_USAGE; }
    const b = buildManifest(loadTokens(other));
    const diffs = [];
    const names = new Set([...manifest.flat.keys(), ...b.flat.keys()]);
    for (const n of names) {
      const A = manifest.flat.get(n), B = b.flat.get(n);
      if (!A) diffs.push(`+ ${n} = ${B.light}`);
      else if (!B) diffs.push(`- ${n}`);
      else if (A.light !== B.light || A.dark !== B.dark) diffs.push(`~ ${n}: ${A.light}/${A.dark} → ${B.light}/${B.dark}`);
    }
    process.stdout.write(diffs.length ? diffs.join('\n') + '\n' : pick('無差異\n', 'No differences\n'));
    process.stdout.write(`\ntokenHash: ${manifest.tokenHash} → ${b.tokenHash}\n`);
    return EXIT_OK;
  }

  process.stderr.write(M.tokensUnknownSub(sub));
  return EXIT_USAGE;
}

/* ---- tokens import <file|dir> [--out …] ----
   Tokens Studio 匯出 → dk 的 DTCG token。格式搬運，不是生成：不改值、不補值、不發明轉換。
     · single-file JSON：頂層 key 為 token set 名（Tokens Studio 慣例），攤平合併。
     · multi-file 目錄：每個 *.json 為一個 set（$themes.json / $metadata.json 為 metadata，跳過），攤平合併。
     · 不支援的 type（typography / boxShadow composite 等物件值）可見列出、原樣跳過。
     · alias {a.b.c} 原樣保留；對合併後結果檢查解析度，未解析者列出。
     · 覆寫保護（沿用 --html 精神）：輸出檔已存在 → 拒絕 exit 2（既有 design/tokens.json 一律受保護）。
     · 收尾自檢：對輸出跑 validateTokens + buildManifest，失敗指出哪個 token。 */
async function cmdTokensImport(args, flags, cwd) {
  const input = args[1];
  if (!input) { process.stderr.write(M.tokensImportUsage()); return EXIT_USAGE; }
  const abs = resolvePath(cwd, input);
  if (!existsSync(abs)) { process.stderr.write(M.tokensImportMissing(input)); return EXIT_USAGE; }

  // 1) 讀入：single-file JSON 或 multi-file 目錄 → set 陣列 [{ name, data }]。
  let sets, mode;
  try {
    if (statSync(abs).isDirectory()) { sets = readTokensStudioDir(abs); mode = 'multi-file'; }
    else { sets = readTokensStudioFile(abs); mode = 'single-file'; }
  } catch (e) {
    process.stderr.write(M.tokensImportParse(input, e.message));
    return EXIT_USAGE;
  }
  if (!sets.length) { process.stderr.write(M.tokensImportEmpty(input)); return EXIT_USAGE; }

  // 2) 轉換（純函式；格式搬運）。
  const res = fromTokensStudio(sets);

  // 3) 收尾自檢：對輸出跑 validateTokens + buildManifest（失敗要說哪個 token）。
  const valErrors = validateTokens(res.tree);
  if (valErrors.length) {
    process.stderr.write(pick(`✗ 匯入自檢失敗（dk 無法解析轉換後的值）：\n`, `✗ Import self-check failed (dk cannot resolve the converted values):\n`));
    for (const e of valErrors) process.stderr.write(`   · ${e}\n`);
    return EXIT_USAGE;
  }
  let manifest;
  try { manifest = buildManifest(res.tree); }
  catch (e) { process.stderr.write(pick(`✗ 匯入自檢失敗：buildManifest 無法解析輸出——${e.message}\n`, `✗ Import self-check failed: buildManifest cannot resolve the output — ${e.message}\n`)); return EXIT_USAGE; }

  // 4) 輸出落點 ＋ 覆寫保護。預設 design/tokens.imported.json；既有檔一律拒絕覆寫（保護 SSOT）。
  const outArg = typeof flags.out === 'string' ? flags.out : join('design', 'tokens.imported.json');
  const outAbs = resolvePath(cwd, outArg);
  if (existsSync(outAbs)) { process.stderr.write(M.tokensImportOverwrite(rel(cwd, outAbs))); return EXIT_USAGE; }
  safeWriteFileSync(cwd, outAbs, JSON.stringify(res.tree, null, 2) + '\n');

  // 5) 匯入摘要。
  printImportSummary({ input, mode, res, manifest, outRel: rel(cwd, outAbs) });
  return EXIT_OK;
}

// single-file：頂層非 $ key 為 token set 名（有 $metadata.tokenSetOrder 則依其序），攤平合併。
function readTokensStudioFile(abs) {
  const data = JSON.parse(readFileSync(abs, 'utf8'));
  const order = Array.isArray(data.$metadata?.tokenSetOrder) ? data.$metadata.tokenSetOrder : null;
  const keys = (order ?? Object.keys(data)).filter((k) => !k.startsWith('$') && data[k] && typeof data[k] === 'object');
  return keys.map((k) => ({ name: k, data: data[k] }));
}
// multi-file：目錄內每個 *.json 為一個 set（$themes.json / $metadata.json 為 metadata，跳過）。
function readTokensStudioDir(abs) {
  const files = readdirSync(abs).filter((f) => f.endsWith('.json') && f !== '$themes.json' && f !== '$metadata.json').sort();
  return files.map((f) => ({ name: f.replace(/\.json$/, ''), data: JSON.parse(readFileSync(join(abs, f), 'utf8')) }));
}

function printImportSummary({ input, mode, res, manifest, outRel }) {
  const B = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
  const D = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
  process.stdout.write(`\n${B('dk tokens import')} ${D(pick('· 格式搬運（不改值、不補值、不發明轉換）', '· a format carry (never changes, fills in, or invents values)'))}\n\n`);
  const setNote = res.setNames.length ? `（${res.setNames.join(', ')}）` : '';
  // 摘要固定列出來源、集合數、轉換數、跳過數、未解析 alias 數與自檢結果。
  process.stdout.write(`  ${pick('來源：', 'Source: ')}${input}  ${D('· ' + mode + ' · ' + pick(res.setNames.length + ' 個 token set' + setNote, res.setNames.length + ' token set(s)' + setNote))}\n`);
  process.stdout.write(`  ${B(pick('✓ 轉換 ' + res.converted.length + ' 個 token', '✓ Converted ' + res.converted.length + ' token(s)'))}\n`);
  if (res.skipped.length) {
    const byType = new Map();
    for (const s of res.skipped) { if (!byType.has(s.type)) byType.set(s.type, []); byType.get(s.type).push(s.path); }
    process.stdout.write(`  ${B(pick('⊘ 跳過 ' + res.skipped.length + ' 個', '⊘ Skipped ' + res.skipped.length))} ${D(pick('（不支援的 type，可見列出、原樣未轉——絕不靜默丟失）：', '(unsupported types, listed and carried verbatim — never silently dropped):'))}\n`);
    for (const [type, paths] of byType) {
      const shown = paths.slice(0, 6).join(', ') + (paths.length > 6 ? ' …' : '');
      process.stdout.write(`     ${D('·')} ${String(type).padEnd(12)} ×${paths.length}  ${D(shown)}\n`);
    }
  }
  if (res.unresolved.length) {
    process.stdout.write(`  ${B(pick('⚠ 未解析 alias ' + res.unresolved.length + ' 個', '⚠ Unresolved alias ' + res.unresolved.length))} ${D(pick('（保留原樣、未改寫——目標不在匯入集合內）：', '(kept verbatim, not rewritten — target is outside the import set):'))}\n`);
    for (const u of res.unresolved.slice(0, 8)) process.stdout.write(`     ${D('·')} ${u.path} → {${u.ref}}\n`);
    if (res.unresolved.length > 8) process.stdout.write(`     ${D(pick('… 及另外 ' + (res.unresolved.length - 8) + ' 個', '… and ' + (res.unresolved.length - 8) + ' more'))}\n`);
  }
  process.stdout.write(`  ${D(pick('自檢：buildManifest 解析 ' + manifest.count + ' 個 token · tokenHash ' + manifest.tokenHash, 'Self-check: buildManifest resolved ' + manifest.count + ' token(s) · tokenHash ' + manifest.tokenHash))}\n`);
  process.stdout.write(`\n  ${B(pick('→ 已寫入', '→ Wrote'))} ${outRel}\n`);
  process.stdout.write(`  ${D(pick('下一步：把它設為 dk.config 的 tokens.source，或 dk tokens diff ' + outRel + ' 對比既有 SSOT。', 'Next: set it as tokens.source in dk.config, or dk tokens diff ' + outRel + ' against the existing SSOT.'))}\n`);
  process.stdout.write(`  ${D(pick('注意：import 是搬運不是生成——未補任何值/單位；缺的 required token 由 dk verify 如實回報。', 'Note: import is a carry, not generation — no values/units filled in; missing required tokens are reported faithfully by dk verify.'))}\n\n`);
}

/* ---- explain <ruleId> ---- */
async function cmdExplain(args, flags, cwd) {
  const id = args[0];
  if (!id) { process.stderr.write(M.explainUsage()); return EXIT_USAGE; }
  const rule = getRule(id);
  if (!rule) { process.stderr.write(M.ruleNotFound(id)); return EXIT_USAGE; }
  const config = await loadConfig(cwd).catch(() => null);
  const override = config?.severity?.[id];
  const eff = override ?? rule.severity;
  const B = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
  process.stdout.write(`\n${B(rule.id)}  —  ${ruleTitle(rule)}\n`);
  process.stdout.write(`${pick('分類：', 'Category: ')}${rule.category}${rule.zone ? ' · zone:' + rule.zone : ''}${rule.heavy ? pick(' · 需 --full', ' · needs --full') : ''}\n\n`);
  process.stdout.write(pick('為什麼重要', 'Why it matters') + `\n  ${ruleWhy(rule)}\n\n`);
  process.stdout.write(pick('怎麼被程式驗證', 'How it is checked') + '\n  ' + pick(`由 ${gateForCategory(rule.category)} 關卡機檢；命中即產生 Finding。`, `Checked by the ${gateForCategory(rule.category)} gate; a hit produces a Finding.`) + '\n\n');
  process.stdout.write(pick('一行怎麼修', 'One-line fix') + `\n  ${ruleFix(rule)}\n\n`);
  process.stdout.write(`severity\n  ${pick('預設', 'default')} ${rule.severity}${override ? pick(`　→ 你的 config 覆寫為 ${B(eff)}`, `  → overridden by your config to ${B(eff)}`) : pick('（未被 config 覆寫）', ' (not overridden by config)')}\n\n`);
  return EXIT_OK;
}

/* ---- rules [--json] ---- */
async function cmdRules(args, flags, cwd) {
  const config = await loadConfig(cwd).catch(() => ({}));
  const rules = listRules(config);
  if (flags.json) {
    process.stdout.write(JSON.stringify(rules.map((r) => ({
      id: r.id, category: r.category, zone: r.zone, severity: r.resolvedSeverity,
      default: r.severity, source: r.source, overridden: r.overridden, heavy: !!r.heavy,
      allowlist: r.allowlist,
    })), null, 2) + '\n');
    return EXIT_OK;
  }
  const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
  process.stdout.write(pick(`\n生效規則（preset:${config.presetName ?? 'recommended'}）\n\n`, `\nRules in effect (preset:${config.presetName ?? 'recommended'})\n\n`));
  for (const r of rules) {
    const sev = r.resolvedSeverity.padEnd(5);
    const flagsStr = [r.heavy ? 'heavy' : '', r.overridden ? 'overridden' : '', r.source !== 'builtin' ? r.source : '', r.allowlist.length ? `allow:${r.allowlist.length}` : '']
      .filter(Boolean).join(' ');
    process.stdout.write(`  ${sev} ${r.id.padEnd(26)} ${dim(flagsStr)}\n`);
  }
  process.stdout.write(pick(`\n${rules.length} 條 · dk explain <id> 看單條教學卡\n`, `\n${rules.length} rules · dk explain <id> for a single teaching card\n`));
  return EXIT_OK;
}

/* ---- report [--json] —— 渲染上一次 run（不重跑）---- */
async function cmdReport(args, flags, cwd) {
  const path = join(cwd, '.dk', 'report.json');
  if (!pathExists(path)) { process.stderr.write(M.noLedger()); return EXIT_USAGE; }
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  // 用持久化的 payload 還原成 result 形狀（不重跑——報告就是帳本被畫出來）。
  const result = {
    findings: payload.findings ?? [], counts: payload.counts ?? { error: 0, warn: 0, info: 0 },
    exitCode: payload.exitCode ?? 0, gates: payload.gates ?? [], emits: payload.emits ?? {},
    tokenHash: payload.tokenHash, directionHash: payload.directionHash ?? payload.direction?.hash ?? null,
    filesScanned: payload.filesScanned ?? 0, full: payload.full,
    // 還原持久化欄位供報告表面使用；缺欄位時採安全預設值。
    suppressed: payload.suppressed ?? 0, baselined: payload.baselined ?? 0,
    configErrors: payload.configErrors ?? [], fatal: payload.fatal,
  };
  const config = { presetName: payload.preset };
  const outPath = typeof flags.out === 'string' ? flags.out : null;
  // 報告落點覆寫保護（同 verify）：載入真實 config 取掃描集合，避免 dk report --html 覆寫來源檔。
  const scanCfg = await loadConfig(cwd).catch(() => null);
  const reportDest = flags.html ? ((typeof flags.html === 'string' ? flags.html : outPath) ?? 'dk-report.html')
                   : (flags.sarif && outPath) ? outPath
                   : (flags.json && outPath) ? outPath
                   : null;
  if (reportDest && scanCfg) {
    const collide = destCollides(reportDest, cwd, scanCfg.targets, scanCfg.ignore);
    if (collide) { process.stderr.write(collide + '\n'); return EXIT_USAGE; }
  }
  if (flags.sarif) return emitSurface('sarif', renderSarif(result, config), outPath, cwd, EXIT_OK, flags);
  if (flags.html) {
    const dest = (typeof flags.html === 'string' ? flags.html : outPath) ?? 'dk-report.html';
    return emitSurface('html', renderHtml(result, config), dest, cwd, EXIT_OK, flags);
  }
  if (flags.json) {
    const jsonPayload = payload.direction ? payload : {
      ...payload,
      direction: {
        status: payload.emits?.directionStatus ?? 'absent',
        name: payload.emits?.directionName ?? null,
        hash: payload.directionHash ?? payload.emits?.directionHash ?? null,
        bindingHash: payload.emits?.directionBindingHash ?? null,
        locked: payload.emits?.directionLocked ?? false,
        baselineHash: payload.emits?.directionBaselineHash ?? null,
        baselineBindingHash: payload.emits?.directionBaselineBindingHash ?? null,
      },
    };
    const json = JSON.stringify(jsonPayload, null, 2) + '\n';
    return outPath ? emitSurface('json', json, outPath, cwd, EXIT_OK, flags) : (process.stdout.write(json), EXIT_OK);
  }
  process.stdout.write(renderTerminal(result, config, { all: !!flags.all }));
  return EXIT_OK;
}

/* ---- baseline [--accept] [--all] [--prune] ----
   棘輪式收緊（語意對齊 ESLint bulk suppressions：合併寫入、--prune 單向收緊）。
   把當前既有違規記入 .dk/baseline.json 接受清單，之後 dk verify 只擋「新增」違規。
   · 不加 --accept = 只預覽（dry-run，不寫檔）。
   · --accept 合併「既有接受清單 ＋ 本次可收違規」（以 fingerprint 去重）——重跑不毀債、
     第二次 accept 別的檔也不會清掉第一次的舊債；棘輪只單向放行、不反向。
   · 預設接受 error/warn（既有債）；info 需加 --all 才收（避免把提示性項目一併蓋章）。
   · --prune 顯式清除「已不再出現」（已修復）的既有條目——唯一會「移除」條目的路徑，且單向收緊。
   · 收進 error 級 finding 時終端顯式警告：error 是真回歸的高風險項，須確認是刻意接受既有債、
     而非把新錯誤無聲收下（視覺回歸 visual/regression 即註冊為 error 級，會走此警告）。 */
async function cmdBaseline(args, flags, cwd) {
  const config = await loadConfig(cwd);
  if (reportConfigErrors(config)) return EXIT_USAGE;
  if (!pathExists(config.tokensPath)) {
    process.stderr.write(M.tokensMissing(config.tokensPath));
    return EXIT_USAGE;
  }
  const tvErr = guardTokenValues(config.tokensPath);
  if (tvErr) { process.stderr.write(tvErr); return EXIT_USAGE; }
  const B = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
  const D = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

  // 以「空 baseline」掃描取得當前全部違規（含先前已接受者）——否則既有接受清單會先被過濾掉，
  // 導致 merge 看不到全貌、--prune 無從判斷哪些條目已修復。用複本覆寫 baselinePath 到不存在路徑。
  const scanCfg = { ...config, baselinePath: join(cwd, '.dk', '__dk_baseline_scan__.json') };
  const result = runChain(scanCfg, { full: !!flags.full });

  // 既有接受清單（棘輪的既有債）——合併而非覆寫。
  const existing = normalizeAccepted(loadBaseline(config.baselinePath).accepted);
  const existingByFp = new Map(existing.map((e) => [e.fingerprint, e]));
  const currentFps = new Set(result.findings.map((f) => fingerprint(f)));

  // 本次可收的違規（error/warn；info 需 --all）。
  const eligible = result.findings.filter((f) => flags.all ? true : f.severity !== 'info');
  const skippedInfo = result.findings.length - eligible.length;
  // 每個 fingerprint 記錄精確出現次數，確保同指紋最多只抑制已接受的 count 筆。
  const grouped = new Map(); // fingerprint -> { rep(Finding), count }
  for (const f of eligible) {
    const fp = fingerprint(f);
    const g = grouped.get(fp);
    if (g) g.count++;
    else grouped.set(fp, { rep: f, count: 1 });
  }
  const newEntries = [...grouped.values()].map(({ rep, count }) => toAcceptedEntry(rep, count));
  const newlyAdded = newEntries.filter((e) => !existingByFp.has(e.fingerprint));
  const errorNewly = newlyAdded.filter((e) => e.severity === 'error');

  // --prune：單向收緊——清除「已不再出現」（已修復）的既有條目；未修復的保留。
  const kept = flags.prune ? existing.filter((e) => currentFps.has(e.fingerprint)) : existing;
  const prunedN = existing.length - kept.length;

  // 合併時，本次掃到的 fingerprint 以精確 count 覆蓋；未掃到且未 prune 的條目維持原樣。
  // 掃描使用空 baseline，因此 count 涵蓋目前所有違規，既有接受項不會復活，超額項仍會被擋。
  const mergedMap = new Map(kept.map((e) => [e.fingerprint, e]));
  for (const e of newEntries) mergedMap.set(e.fingerprint, e);
  const accepted = [...mergedMap.values()];
  const stillLegacy = accepted.filter((e) => e.count === undefined).length; // 尚未升級的舊格式條目

  process.stdout.write(`\n${B('dk baseline')} ${D(pick('· 棘輪：合併既有接受清單、之後只擋新增（重跑不毀債）', '· ratchet: merge the existing accepted set, then block only what is new (reruns never destroy debt)'))}\n\n`);
  if (!accepted.length) {
    // 接受清單為空時仍寫入空陣列，避免磁碟殘留指紋繼續抑制復發違規。
    // 保留檔案可讓狀態明確、可 diff 且冪等。
    if (flags.accept && pathExists(config.baselinePath)) {
      const payload = { version: 1, generatedAt: new Date().toISOString(), tokenHash: result.tokenHash, accepted: [] };
      safeWriteFileSync(cwd, config.baselinePath, JSON.stringify(payload, null, 2) + '\n');
      process.stdout.write(`  ${B(pick('✓ 已清空 baseline', '✓ Cleared baseline'))} ${rel(cwd, config.baselinePath)} ${D(pick(
        '· 全部既有債已修復；接受清單清空（復發違規會重新被擋）',
        '· all prior debt is fixed; accepted set emptied (recurring violations will be blocked again)'))}\n\n`);
    } else {
      process.stdout.write(`  ${D(pick('目前沒有可接受的違規、接受清單也空——鏈是綠的，無需 baseline。', 'No capturable violations and an empty accepted set — the chain is green, no baseline needed.'))}\n\n`);
    }
    return EXIT_OK;
  }
  process.stdout.write(`  ${pick('接受清單共', 'Accepted set:')} ${B(String(accepted.length))} ${pick(
    `筆（既有保留 ${kept.length}${flags.prune ? `、清除已修復 ${prunedN}` : ''}、本次新增 ${newlyAdded.length}）`,
    `entries (kept ${kept.length}${flags.prune ? `, pruned fixed ${prunedN}` : ''}, newly added ${newlyAdded.length})`)}\n`);
  const preview = newlyAdded.slice(0, 12);
  for (const a of preview) process.stdout.write(`   ${D('+')} ${a.severity.padEnd(5)} ${a.ruleId}  ${D((a.file ?? '(tokens)'))}\n`);
  if (newlyAdded.length > preview.length) process.stdout.write(`   ${D(pick('… 及另外 ' + (newlyAdded.length - preview.length) + ' 筆新增', '… and ' + (newlyAdded.length - preview.length) + ' more new'))}\n`);
  if (skippedInfo) process.stdout.write(`  ${D(pick(skippedInfo + ' 筆 info 未收——確定要收請加 --all（info 多為非阻斷的提示）。', skippedInfo + ' info not captured — add --all to capture them (info is usually a non-blocking hint).'))}\n`);
  if (!flags.prune && existing.length) process.stdout.write(`  ${D(pick('提示：已修復的舊條目不會自動移除；要單向收緊清掉它們請加 --prune。', 'Hint: fixed old entries are not auto-removed; add --prune to tighten one-way and drop them.'))}\n`);
  // 缺少 count 的相容條目以 Infinity 讀入；--accept 會把掃到的條目改寫為精確 count，
  // 未掃到的殘留條目可由 --prune 清除。
  if (stillLegacy) process.stdout.write(`  ${D(pick(
    stillLegacy + ' 筆為舊格式（無 count 記帳，讀入時視為全部抑制）——執行一次 dk baseline --accept 以升級記帳精度（或 --prune 清除已修復者）。',
    stillLegacy + ' entry(ies) are legacy (no count ledger, treated as suppress-all on read) — run dk baseline --accept once to upgrade counting precision (or --prune to drop fixed ones).'))}\n`);
  // 接受 error 級 finding 時顯式列出筆數與規則。
  if (errorNewly.length) {
    const rules = [...new Set(errorNewly.map((e) => e.ruleId))];
    process.stdout.write(`  ${B(pick('⚠ 本次把 ' + errorNewly.length + ' 筆 error 級 finding 收進 baseline', '⚠ Capturing ' + errorNewly.length + ' error-level finding(s) into the baseline'))}${pick('：', ': ')}${rules.join(', ')}\n`);
    process.stdout.write(`  ${D(pick('  error 級＝真回歸的高風險項——確認這是刻意接受的既有債，而非把新錯誤無聲收下。', '  error-level = high-risk real-regression items — confirm this is deliberately accepted debt, not new errors captured silently.'))}\n`);
  }

  if (!flags.accept) {
    process.stdout.write(`\n  ${D(pick('這是預覽（未寫檔）。確定收下請加：', 'This is a preview (nothing written). To capture, add:'))} ${B('dk baseline --accept')}${D(flags.prune ? pick('（含 --prune）', ' (with --prune)') : '')}\n\n`);
    return EXIT_OK;
  }
  const payload = { version: 1, generatedAt: new Date().toISOString(), tokenHash: result.tokenHash, accepted };
  safeWriteFileSync(cwd, config.baselinePath, JSON.stringify(payload, null, 2) + '\n');
  process.stdout.write(`\n  ${B(pick('✓ 已寫入', '✓ Wrote'))} ${rel(cwd, config.baselinePath)} ${D(pick(
    '· ' + accepted.length + ' 筆已接受' + (flags.prune && prunedN ? '、清除 ' + prunedN + ' 筆已修復' : '') + '；之後 dk verify 只擋新增違規',
    '· ' + accepted.length + ' accepted' + (flags.prune && prunedN ? ', pruned ' + prunedN + ' fixed' : '') + '; dk verify now blocks only new violations'))}\n\n`);
  return EXIT_OK;
}
// 把 Finding 轉為接受清單條目；fingerprint 與 count 都沿用 ledger 的棘輪語意。
function toAcceptedEntry(f, count = 1) {
  return { fingerprint: fingerprint(f), ruleId: f.ruleId, file: f.file, severity: f.severity, message: f.message, count };
}
// 規範化接受清單條目，並容忍裸 fingerprint 字串或缺欄位的相容輸入。
// 只有非負數 count 才保留；缺席時維持缺席，讓讀入端採相容預算並提示重寫。
function normalizeAccepted(accepted) {
  return (accepted ?? []).map((a) => {
    if (typeof a === 'string') return { fingerprint: a, ruleId: '?', file: null, severity: 'warn', message: '' };
    const e = {
      fingerprint: a.fingerprint ?? fingerprint({ ruleId: a.ruleId, file: a.file, message: a.message }),
      ruleId: a.ruleId, file: a.file ?? null, severity: a.severity ?? 'warn', message: a.message ?? '',
    };
    if (Number.isFinite(a.count) && a.count >= 0) e.count = a.count;
    return e;
  });
}

/* ---- doctor ---- */
async function cmdDoctor(args, flags, cwd) {
  process.stdout.write(pick('\ndk doctor — 環境檢查\n\n', '\ndk doctor — environment check\n\n'));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  process.stdout.write(`  ${nodeMajor >= 18 ? '✓' : '✗'} node ${process.versions.node} ${nodeMajor >= 18 ? '(OK)' : pick('(需 >= 18)', '(needs >= 18)')}\n`);
  const optional = [
    [['stylelint', 'stylelint-declaration-strict-value', 'postcss-html'], 'css-strict stack', pick('css-strict 關卡', 'css-strict gate'), 'npm i -D stylelint stylelint-declaration-strict-value@1.10.6 postcss-html'],
    [['@playwright/test'], '@playwright/test', pick('a11y / visual 關卡', 'a11y / visual gates'), 'npm i -D @playwright/test'],
    [['@axe-core/playwright'], '@axe-core/playwright', pick('a11y 關卡', 'a11y gate'), 'npm i -D @axe-core/playwright'],
  ];
  process.stdout.write(pick('\n  選配依賴（--full 的重關卡需要；缺哪個，該關卡會在報告裡明列「跳過」而非假通過）：\n', '\n  Optional deps (needed by --full heavy gates; if missing, the gate is listed as "skipped" in the report, never a fake pass):\n'));
  for (const [packages, label, use, install] of optional) {
    const missing = [];
    for (const pkg of packages) if (!(await hasModule(pkg, cwd))) missing.push(pkg);
    const has = missing.length === 0;
    const missingNote = has ? '' : pick(`（缺 ${missing.join(' / ')}）`, ` (missing ${missing.join(' / ')})`);
    process.stdout.write(`   ${has ? '✓' : '·'} ${label.padEnd(24)} ${use}${missingNote}${has ? '' : `  →  ${install}`}\n`);
  }
  const hasBrowser = await hasPlaywrightChromium(cwd);
  process.stdout.write(`   ${hasBrowser ? '✓' : '·'} ${'Playwright Chromium'.padEnd(24)} ${pick('渲染後 a11y / visual', 'rendered a11y / visual')}${hasBrowser ? '' : '  →  npx playwright install chromium'}\n`);
  const cfg = await loadConfig(cwd).catch(() => null);
  process.stdout.write(pick('\n  設定：\n', '\n  Config:\n'));
  process.stdout.write(`   ${cfg?.configFile ? '✓' : '·'} config${pick('：', ': ')}${cfg?.configFile ?? pick('（無 — 退回 recommended preset）', '(none — falls back to the recommended preset)')}\n`);
  process.stdout.write(`   ${cfg && pathExists(cfg.tokensPath) ? '✓' : '✗'} tokens${pick('：', ': ')}${cfg?.tokensPath ?? '?'}\n`);
  process.stdout.write(pick(
    '\n  零依賴核心（contract · ssot-sync · slop）隨時可跑：dk verify\n  完整管線（+ css-strict · a11y · visual）：dk verify --full（缺依賴的重關卡會明列跳過）\n\n',
    '\n  Zero-dependency core (contract · ssot-sync · slop) runs anytime: dk verify\n  Full pipeline (+ css-strict · a11y · visual): dk verify --full (missing-dep heavy gates are listed as skipped)\n\n'));
  return EXIT_OK;
}

/* ---- helpers ---- */
/* 印 config 健全性錯誤到 stderr。致命錯誤回 true，讓呼叫端回傳 EXIT_USAGE；
   非致命錯誤印出後以 recommended preset 繼續。 */
function reportConfigErrors(config) {
  const errs = config.errors ?? [];
  const fatals = errs.filter((e) => e.meta?.configFatal);
  for (const e of errs) {
    if (e.meta?.configFatal) continue; // 致命者下方以教學紅字統一列出
    process.stderr.write(`config: ${e.message}\n`);
  }
  if (fatals.length) {
    const red = (s) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
    process.stderr.write(red(pick('✗ dk.config 設定錯誤（用法錯誤）：', '✗ dk.config error (usage):')) + '\n');
    for (const e of fatals) {
      process.stderr.write(`   · ${e.message}\n`);
      if (e.fix) process.stderr.write(`     ${e.fix}\n`);
    }
    return true;
  }
  return false;
}
// tokens 值畸形守門（DTCG 2025.10 物件式）：載入 tokens、validateTokens；有畸形時一次列出、
// 供命令層 return EXIT_USAGE），無畸形 → null。畸形物件在此被攔下、絕不 crash 到 gate。JSON 壞/檔缺
// JSON 解析錯誤與缺檔由各命令既有錯誤路徑處理；其他命令在動工前一致攔截畸形值。
function guardTokenValues(tokensPath) {
  let tokens;
  try { tokens = loadTokens(tokensPath); } catch { return null; }
  const errs = validateTokens(tokens);
  return errs.length ? M.tokenValues(errs) : null;
}
function rel(cwd, p) { return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p; }
function gateForCategory(cat) {
  return ({ tokens: 'contract / ssot-sync', slop: 'slop', css: 'css-strict', a11y: 'a11y', visual: 'visual' })[cat] ?? cat;
}
async function hasModule(pkg, cwd) {
  try { await import(join(cwd, 'node_modules', pkg, 'package.json'), { with: { type: 'json' } }); return true; }
  catch {
    try { const { createRequire } = await import('node:module'); createRequire(join(cwd, 'x.js')).resolve(pkg); return true; }
    catch { return false; }
  }
}
async function hasPlaywrightChromium(cwd) {
  try {
    const { createRequire } = await import('node:module');
    const { chromium } = createRequire(join(cwd, 'x.js'))('@playwright/test');
    const executable = chromium?.executablePath?.();
    return Boolean(executable && pathExists(executable));
  } catch { return false; }
}

// 各命令的聚焦 help 段落（dk <cmd> --help 印這段；未列名者退回完整 help）。雙語，依 LANG 選。
const CMD_HELP = {
  'zh-TW': {
    verify: `dk verify [globs] [options] — 跑整條鏈（contract → direction → ssot-sync → slop），輸出教學報告。
  --full          加 css-strict / a11y / visual（需 install；缺依賴會明列 skipped）
  --require-gates 任一道被要求的關卡 skipped 即 exit 1（含尚未建立 visual baseline）
  --gate <id>     只跑單關做緊回饋（未知 id / 掃 0 檔 → exit 2）
  --json          機器可讀輸出（CI）——含逐筆 findings、gates、configErrors
  --summary       緊湊機器表面（< 10KB 級）：counts / per-gate / per-rule top-20 / configErrors，
                    不含逐筆 findings。給 agent / plugin hook 一等消費，避開大 repo 的 8MB 懸崖
  --sarif         SARIF 2.1.0（接 GitHub code scanning；每筆帶 partialFingerprints；需 --out 才寫檔）
  --html [path]   可分享 PR 產物（light+dark 自適應；預設 dk-report.html）
  --out <file>    sarif/html 的輸出路徑；--open 寫檔後開啟
  --all           terminal 展開每規則全部筆數（預設每規則只顯示前 10 筆、其餘折疊成誠實計數行）
  --no-cache      停用 .dk/cache.json per-file 快取，本次走全掃（快取預設開啟）
  ※ 報告落點若落在掃描範圍內（會覆寫來源檔／被掃回污染）→ 拒絕並 exit 2；改用 --out 指到專案內未掃描位置或加 ignore。
  exit：0 通過 · 1 有達 failOn 門檻的 Finding · 2 用法錯誤`,
    baseline: `dk baseline [--accept] [--all] [--prune] — 棘輪式收緊（合併寫入、單向收緊）。
  不加 --accept   只預覽（dry-run，不寫檔）
  --accept        合併「既有接受清單 ＋ 本次可收違規」（fingerprint 去重）——重跑不毀債
  --all           連 info 也收（預設只收 error/warn）
  --prune         清除「已不再出現」（已修復）的既有條目——唯一會移除條目的路徑，單向收緊
  ※ 收進 error 級 finding 時終端顯式警告（列筆數與規則）。`,
    report: `dk report [--html|--sarif|--json] [--out <file>] [--open] — 渲染上一次 run 的帳本（不重跑）。
  render-only：有帳本（.dk/report.json）→ exit 0；無帳本 → exit 2。不重算、不改 verify 的 exit 語意。`,
    build: `dk build [--check] [--format css,js,json] — tokens.json → 產物。
  --check         只驗產物與 SSOT 同步（漂移 → exit 1），不寫檔`,
    fix: `dk fix [--slop] [--dry-run] [globs] — 白名單機械修正（校正既有值，從不作曲）。
  不加旗標    重編 tokens.css（拉回與 SSOT 同步）＋ stylelint --fix（若已安裝）
  --slop      SSOT 精確反查：把 style zone 內「＝某 token 解析值」的寫死 #hex 替換成 var(--token)
                · 只做 exact-match（完全相等）；無法對應者不動、列為「需人工」
                · 三層選擇：優先 semantic；多個 semantic 同值＝歧義，跳過並可見列出（絕不猜）
                · HTML 屬性/非 style 語境、含 dk-ignore 的行、allowlist 檔一律不動
  --dry-run   只列出將修/歧義/需人工清單，不寫檔（與 --slop 併用）
  修完自動重驗改動檔並回報殘餘。冪等：跑第二次零變更。`,
    new: `dk new <dir> [--preset recommended|strict|minimal] — 逐字複製 vetted 範本到新目錄（複製、非生成）。`,
    init: `dk init [--preset recommended|strict|minimal] — 就地寫 dk.config.mjs、自動偵測 targets；不覆蓋既有檔。`,
    design: `dk design <init|check|prompt|lock|history> — portable AI 創意方向契約 + Taste Lock。
  init               在 config.direction.source 建立未完成 draft；不覆蓋既有檔
  check [--json]     驗 compact identity、token bindings、lock 與核准鏈
  prompt             把 approved contract 編譯成短小的跨 agent handoff
  lock [--accept]    預覽／明確接受 direction hash；更新既有 lock 必須加 --reason <原因>
  history [--json]   驗證並顯示 hash-chain 核准時間線（actor／reason／evidence）
  CLI 本身不呼叫模型；$dk-design 只在需要時探索，並檢查真實 pixels。`,
    proof: `dk proof --app <url> [--routes auto|/a,/b] [--json] — 驗證真實 Web App。
  等同 a11y required gate；展開 route × state × viewport × theme 完整矩陣
  state 動作在 config.proof 宣告；任一載入／互動／axe 案例失敗即阻擋
  完整 coverage 與逐案例結果寫入 .dk/proof/app-proof.json。`,
    slop: `dk slop [globs] [--json|--summary|--sarif|--html] — 只跑 anti-AI-slop 關卡。
  這是 dk verify --gate slop 的固定別名；--gate、--full、--require-gates 會明確拒絕並 exit 2
  要選其他／重關卡請使用 dk verify --gate <id> 或 dk verify --full。`,
    studio: `dk studio [dir] [--port 4177] [--open] — 啟動唯讀本機設計工作台。
  查看方向、Taste Lock／核准歷史、gate ledger、App Proof、System Graph、Git diff
  Live Preview 可切 viewport；同源本機 HTML 可用 DOM Inspector 反查 selector／token 線索
  預設只監聽 127.0.0.1；非 loopback 必須明確 --allow-remote
  警告：remote mode 無驗證且會暴露 repository evidence API，僅限可信網路。`,
    system: `dk system [graph] [--json] [--out <path>] — 建立 repository system graph。
  索引 component、story、route、token 與 imports／uses／tokenUses 關係
  每個節點保留 file:line 證據；--include-generated 才納入生成碼。`,
    benchmark: `dk benchmark [--json] [--html [path]] — 十輪真實漂移實測。
  在隔離的 shipped scaffold 注入十種違規；每輪呼叫公開 CLI、要求精確規則，再逐 byte 復原回綠
  不修改目前專案；--keep-workspace 才保留暫存 workspace。`,
    tokens: `dk tokens <list|contrast|coverage|diff|import> [--json] — SSOT 自省與匯入。
  list / contrast / coverage / diff   SSOT 自省（見 dk --help）
  import <file.json|dir> [--out <path>]   把 Tokens Studio 匯出搬運成 dk 的 DTCG token
                · single-file JSON 或 multi-file 目錄皆可（頂層/每檔為 token set，攤平合併）
                · 不支援的 type（typography/boxShadow composite 等）可見列出、原樣跳過——絕不靜默丟失
                · alias {a.b.c} 原樣保留、檢查解析度；未解析者列出
                · 覆寫保護：輸出檔已存在 → 拒絕 exit 2（既有 design/tokens.json 一律受保護）
                · 收尾自檢：對輸出跑 buildManifest；結尾給「轉換數/跳過數/未解析 alias 數」摘要
                · 格式搬運不是生成：不改值、不補值、不發明轉換`,
  },
  en: {
    verify: `dk verify [globs] [options] — run the whole chain (contract → direction → ssot-sync → slop) and print a teaching report.
  --full          add css-strict / a11y / visual (needs install; missing deps are listed as skipped)
  --require-gates exit 1 when any requested gate is skipped (including an uninitialized visual baseline)
  --gate <id>     run a single gate for a tight loop (unknown id / 0 files scanned → exit 2)
  --json          machine-readable output (CI) — includes per-finding findings, gates, configErrors
  --summary       compact machine surface (< 10KB): counts / per-gate / per-rule top-20 / configErrors,
                    without per-finding detail. A first-class surface for agents / plugin hooks, avoiding the 8MB cliff on big repos
  --sarif         SARIF 2.1.0 (GitHub code scanning; each result carries partialFingerprints; needs --out to write a file)
  --html [path]   shareable PR artifact (light+dark adaptive; default dk-report.html)
  --out <file>    output path for sarif/html; --open opens it after writing
  --all           expand every finding per rule in the terminal (default: first 10 per rule, the rest folded into an honest count line)
  --no-cache      disable the .dk/cache.json per-file cache; full scan this run (cache is on by default)
  Note: if the destination falls inside the scan set (would overwrite a source file / be scanned back in) → rejected with exit 2; use --out for an unscanned location inside the project or add it to ignore.
  exit: 0 pass · 1 a finding met the failOn threshold · 2 usage error`,
    baseline: `dk baseline [--accept] [--all] [--prune] — ratchet tightening (merge-write, one-way).
  no --accept     preview only (dry-run, no write)
  --accept        merge "existing accepted set + this run's capturable violations" (deduped by fingerprint) — reruns never destroy debt
  --all           also capture info (default captures only error/warn)
  --prune         drop entries that "no longer appear" (fixed) — the only path that removes entries, one-way tightening
  Note: capturing an error-level finding prints an explicit terminal warning (lists the count and rules).`,
    report: `dk report [--html|--sarif|--json] [--out <file>] [--open] — render the last run's ledger (no re-run).
  render-only: ledger present (.dk/report.json) → exit 0; absent → exit 2. No recompute, no change to verify's exit semantics.`,
    build: `dk build [--check] [--format css,js,json] — tokens.json → artifacts.
  --check         only verify artifacts are in sync with the SSOT (drift → exit 1), no write`,
    fix: `dk fix [--slop] [--dry-run] [globs] — allowlisted mechanical fixes (corrects existing values, never composes).
  (no flag)   recompile tokens.css (back in sync with the SSOT) + stylelint --fix (if installed)
  --slop      exact SSOT reverse-lookup: rewrite a hardcoded #hex that equals a token's resolved value to var(--token)
                · exact-match only; anything without an exact token is left and listed as "needs manual"
                · three-layer choice: prefer semantic; multiple semantics with the same value = ambiguous, skipped and listed (never guesses)
                · HTML attributes / non-style contexts, lines with dk-ignore, and allowlisted files are left untouched
  --dry-run   list the would-fix / ambiguous / needs-manual items without writing (pair with --slop)
  Re-verifies the changed files afterward. Idempotent: a second run changes nothing.`,
    new: `dk new <dir> [--preset recommended|strict|minimal] — copy the vetted scaffold into a new directory verbatim (a copy, not generation).`,
    init: `dk init [--preset recommended|strict|minimal] — write dk.config.mjs in place, auto-detect targets; never overwrites existing files.`,
    design: `dk design <init|check|prompt|lock|history> — a portable AI art-direction contract plus Taste Lock.
  init               create an unfinished draft at config.direction.source; never overwrite
  check [--json]     validate compact identity, token bindings, lock, and approval chain
  prompt             compile an approved contract into a short cross-agent handoff
  lock [--accept]    preview / explicitly accept the direction hash; updating a lock requires --reason <why>
  history [--json]   verify and show the hash-chained approval timeline (actor / reason / evidence)
  The CLI does not call a model; $dk-design explores only when needed and inspects real pixels.`,
    proof: `dk proof --app <url> [--routes auto|/a,/b] [--json] — prove a running Web app.
  Runs the required a11y gate across the complete route × state × viewport × theme matrix
  State actions live in config.proof; any load, interaction, or axe case failure blocks
  Complete coverage and per-case results are written to .dk/proof/app-proof.json.`,
    slop: `dk slop [globs] [--json|--summary|--sarif|--html] — run only the anti-AI-slop gate.
  This is a fixed alias for dk verify --gate slop; --gate, --full, and --require-gates are rejected with exit 2
  Use dk verify --gate <id> or dk verify --full to select other or heavy gates.`,
    studio: `dk studio [dir] [--port 4177] [--open] — start the read-only local design workbench.
  Inspect direction, Taste Lock / approvals, gate ledger, App Proof, System Graph, and Git diff
  Live Preview switches viewports; same-origin local HTML supports DOM selector / token clues
  Binds to 127.0.0.1 by default; non-loopback access requires explicit --allow-remote
  WARNING: remote mode is unauthenticated and exposes repository evidence APIs; use only on a trusted network.`,
    system: `dk system [graph] [--json] [--out <path>] — build the repository system graph.
  Indexes component, story, route, token, and imports / uses / tokenUses relationships
  Every node retains file:line evidence; generated code is excluded unless --include-generated is set.`,
    benchmark: `dk benchmark [--json] [--html [path]] — run the real ten-round drift proof.
  Injects ten defects into an isolated shipped scaffold; each round calls the public CLI, requires the exact rule, then restores clean bytes
  Never edits the current project; --keep-workspace explicitly retains the temporary workspace.`,
    tokens: `dk tokens <list|contrast|coverage|diff|import> [--json] — inspect and import the SSOT.
  list / contrast / coverage / diff   inspect the SSOT (see dk --help)
  import <file.json|dir> [--out <path>]   carry a Tokens Studio export into dk's DTCG tokens
                · single-file JSON or multi-file directory (top-level / each file is a token set, flattened & merged)
                · unsupported types (typography/boxShadow composites, etc.) are listed and skipped verbatim — never silently dropped
                · alias {a.b.c} kept verbatim, resolvability checked; unresolved ones are listed
                · overwrite protection: an existing output file → refused with exit 2 (an existing design/tokens.json is always protected)
                · self-check: runs buildManifest on the output; prints a "converted / skipped / unresolved alias" summary
                · a format carry, not generation: never changes, invents, or fills in values`,
  },
};

// 完整 help（總覽）雙語。
const HELP_OVERVIEW = {
  'zh-TW': `
dk — AI UI 導演 + 可證明的設計品質儀器
AI skill 先探索與建立方向；deterministic core 再量測、解釋、擋下與鎖住飄移。

用法：dk <command> [options]

起手
  new <dir>             逐字複製 vetted 範本到新目錄（tokens.json + 已同步的
                          tokens.css + 誠實樸素、已過關的 index.html + 註解 config）。
                          --preset recommended|strict|minimal   選品味基線
                          這是 scaffold 複製，非 AI 生成、無提示詞；design init/lock 另有顯式寫檔語意。
  init [--preset …]     在既有 repo 就地寫 dk.config.mjs、自動偵測 targets；不覆蓋既有檔。
  design <sub>          init | check | prompt | lock | history —— 把 AI 品味編譯成 portable direction contract，
                          經審查後以 Taste Lock＋hash-chain 核准歷史鎖住；更新 lock 必須留下 --reason
  codex <sub>           status | init | context | prompt | mcp —— 專案範圍、明確呼叫的 Codex CLI／桌面版整合；
                          不寫 ~/.codex、~/.agents、plugin cache 或 marketplace
  claude <sub>          status | init | context | prompt | mcp —— 專案範圍、明確呼叫的 Claude Code CLI／桌面版整合；
                          不寫 ~/.claude、~/.agents、plugin cache 或 marketplace
  intelligence <sub>    catalog | recommend —— 離線九領域知識引擎；從中英文 brief 產生三個有實質差異的技術棧可行方向
  reference <sub>       add | decompose | map | plan | compare | status | validate —— 參考圖到真實程式的五段證據鏈

核心
  verify [globs]        跑整條鏈（token contract → direction → ssot-sync → slop），輸出教學報告
                          --full          加 css-strict / a11y / visual（需 install；缺依賴會明列跳過）
                          --require-gates 任一道被要求的關卡 skipped 即 exit 1
                          --gate <id>     只跑單關做緊回饋（未知 id / 掃 0 檔 → exit 2）
                          --json          機器可讀輸出（CI；含 findings + gates + configErrors）
                          --summary       緊湊機器表面（< 10KB 級；counts/gates/per-rule top-20；agent/hook 用）
                          --sarif         SARIF 2.1.0（接 GitHub code scanning；帶 partialFingerprints）
                          --html [path]   可分享 PR 產物（light+dark 自適應；預設 dk-report.html）
  watch [globs]         真增量監看：存檔只重掃該檔（merge-by-file 帳本＋per-file 快取），
                          印該檔紅綠＋全 repo 摘要；tokens/config 變更則全量重跑
  build [--check]       tokens.json → 產物（css/js/json）；--check 只驗同步
  fix [--slop]          白名單機械修正：重編 tokens.css + stylelint --fix；
                          --slop 用 SSOT 精確反查把寫死色替換成 var(--token)（--dry-run 只列不改）；絕不作曲
  baseline [--accept]   棘輪：合併既有接受清單、之後只擋新增（--all 連 info 也收；--prune 清除已修復條目）
  tokens <sub>          list | contrast | coverage | diff | import  —— SSOT 自省與匯入
                          import <file|dir> [--out]  把 Tokens Studio 匯出搬運成 dk 的 DTCG token（格式搬運、非生成）
  contrast              = tokens contrast（印所有 pair 的比值，淺/深）
  slop [globs]          = verify --gate slop（固定別名；選其他／重關卡請改用 verify）
  proof --app <url>     對真實 Web App 跑 route × state × viewport × theme 無障礙矩陣
                          --routes auto|/a,/b；逐案例證據寫入 .dk/proof/app-proof.json

工作台與證據
  studio [dir]          啟動唯讀本機 Studio：方向／核准／ledger／Connections／App Proof／System Graph／Live Inspector／Git diff
                          --port 4177 · --open；預設只監聽 127.0.0.1；--allow-remote 無驗證且會暴露 repo 證據 API，僅限可信網路
  bridge <sub>          init | catalog | doctor | sync | list | status | inspect | ingest
                          串接外部工具並驗 trust／freshness／commit／artifact／hash-chain；用 bridge help 看完整操作
  system [graph]        索引 component／story／route／token 關係；--json 或 --out <file>
  benchmark             在隔離 scaffold 跑十輪漂移偵測＋逐 byte 復原；--json／--html

自省
  rules [--json]        列出生效規則（id / severity / 來源 / allowlist）
  explain <ruleId>      單一規則的教學卡（是什麼→為什麼→怎麼修）
  report [--html|--sarif|--json] [--out <file>] [--open]   渲染上一次 run 的帳本（render-only：
                          不重跑、不改 exit 語意；有帳本 exit 0、無帳本 exit 2）
  doctor                檢查 node 版本與選配依賴、印出安裝指令
  dk-mcp                另提供 stdio MCP server；唯讀資源與 Bridge dry-run 預檢，不代替顯式 sync／核准

exit code：0 通過 · 1 有達 failOn 門檻的 Finding · 2 用法錯誤

設計：零設定可執行；需要時再由 config 擴充成專案政策。
`,
  en: `
dk — an AI UI director plus a provable design-quality instrument
The AI skill explores and establishes direction; the deterministic core measures, explains, blocks, and locks drift.

Usage: dk <command> [options]

Getting started
  new <dir>             Copy the vetted scaffold into a new directory verbatim (tokens.json + a synced
                          tokens.css + an honestly-plain, already-passing index.html + a commented config).
                          --preset recommended|strict|minimal   pick a taste baseline
                          This scaffold is copied, not AI-generated, with no prompt; design init/lock have separate explicit write semantics.
  init [--preset …]     Write dk.config.mjs in place in an existing repo, auto-detect targets; never overwrites your files.
  design <sub>          init | check | prompt | lock | history — compile AI taste into a portable direction contract,
                          then preserve it with Taste Lock + hash-chained approvals; lock updates require --reason
  codex <sub>           status | init | context | prompt | mcp — repository-scoped, explicit-invocation integration for
                          Codex CLI and desktop; never writes ~/.codex, ~/.agents, plugin caches, or marketplaces
  claude <sub>          status | init | context | prompt | mcp — repository-scoped, explicit-invocation integration for
                          Claude Code CLI and desktop; never writes ~/.claude, ~/.agents, plugin caches, or marketplaces
  intelligence <sub>    catalog | recommend — offline nine-domain knowledge engine; turn a Chinese or English brief into
                          three materially distinct, stack-aware directions
  reference <sub>       add | decompose | map | plan | compare | status | validate — five-stage evidence from authorized references to real code

Core
  verify [globs]        Run the whole chain (token contract → direction → ssot-sync → slop) and print a teaching report
                          --full          add css-strict / a11y / visual (needs install; missing deps are listed as skipped)
                          --require-gates exit 1 when any requested gate is skipped
                          --gate <id>     run a single gate for a tight loop (unknown id / 0 files scanned → exit 2)
                          --json          machine-readable output (CI; includes findings + gates + configErrors)
                          --summary       compact machine surface (< 10KB; counts/gates/per-rule top-20; for agents/hooks)
                          --sarif         SARIF 2.1.0 (GitHub code scanning; carries partialFingerprints)
                          --html [path]   shareable PR artifact (light+dark adaptive; default dk-report.html)
  watch [globs]         True-incremental watch: on save, rescan only that file (merge-by-file ledger + per-file cache),
                          print its red/green + a whole-repo summary; a tokens/config change triggers a full rerun
  build [--check]       tokens.json → artifacts (css/js/json); --check only verifies sync
  fix [--slop]          Allowlisted mechanical fixes: recompile tokens.css + stylelint --fix;
                          --slop rewrites hardcoded colors to var(--token) via exact SSOT reverse-lookup (--dry-run to preview); never composes
  baseline [--accept]   Ratchet: merge the existing accepted set, then block only what's new (--all also captures info; --prune drops fixed entries)
  tokens <sub>          list | contrast | coverage | diff | import  — inspect and import the SSOT
                          import <file|dir> [--out]  carry a Tokens Studio export into dk's DTCG tokens (a format carry, not generation)
  contrast              = tokens contrast (print every pair's ratio, light/dark)
  slop [globs]          = verify --gate slop (fixed alias; use verify for other or heavy gates)
  proof --app <url>     Run the route × state × viewport × theme accessibility matrix against a real Web app
                          --routes auto|/a,/b; per-case evidence is written to .dk/proof/app-proof.json

Workbench and evidence
  studio [dir]          Start the read-only local Studio: direction / approvals / ledger / Connections / App Proof / System Graph / Live Inspector / Git diff
                          --port 4177 · --open; binds to 127.0.0.1 by default; --allow-remote is unauthenticated and trusted-network only
  bridge <sub>          init | catalog | doctor | sync | list | status | inspect | ingest
                          federate external tools and verify trust / freshness / commit / artifacts / hash-chain; see bridge help
  system [graph]        Index component / story / route / token relationships; --json or --out <file>
  benchmark             Run ten isolated drift injections plus byte restoration; --json / --html

Introspection
  rules [--json]        List every rule in effect (id / severity / source / allowlist)
  explain <ruleId>      A teaching card for one rule (what → why → how to fix)
  report [--html|--sarif|--json] [--out <file>] [--open]   Render the last run's ledger (render-only:
                          no re-run, no change to exit semantics; ledger present → exit 0, absent → exit 2)
  doctor                Check node version and optional deps; print install commands
  dk-mcp                Separate stdio MCP server: read-only resources plus Bridge dry-run preflight, never implicit sync or approval

exit code: 0 pass · 1 a finding met the failOn threshold · 2 usage error

Philosophy: low floor (runs with zero config, readable red) · high ceiling (config encodes taste as machine checks).
`,
};

export function printHelp(cmd) {
  if (cmd === 'bridge') { printBridgeHelp(); return; }
  if (cmd === 'codex') { printCodexHelp(); return; }
  if (cmd === 'claude') { printClaudeHelp(); return; }
  if (cmd === 'intelligence') { printIntelligenceHelp(); return; }
  if (cmd === 'reference') { printReferenceHelp(); return; }
  const focused = cmd && CMD_HELP[LANG][cmd];
  if (focused) {
    const full = LANG === 'en' ? 'Full usage: dk --help' : '完整用法：dk --help';
    process.stdout.write(`\n${focused}\n\n${full}\n`);
    return;
  }
  process.stdout.write(HELP_OVERVIEW[LANG]);
}
