#!/usr/bin/env node
/* ============================================================
   dk — CLI 進入點與分派器。刻意薄，零設計邏輯。
   解析 argv → 選子命令 → dispatch → 統一 exit code：
     0 通過 · 1 有達 failOn 門檻的 Finding · 2 用法錯誤。
   ============================================================ */
import { dispatch, printHelp, M } from '../src/commands/index.mjs';

// 管線提早關閉（如 `dk verify | head -1`）時抑制 EPIPE stack trace，但不改寫檢查結果：
//   · run 已完成（runExitCode 已定）→ 保留該碼（違規＝1、通過＝0）；只是抑制後續寫出。
//   · if the pipe closes before completion, exit 2 rather than reporting success.
let runExitCode = null; // main 解析後填入；null＝run 尚未完成。
function onPipeError(err) {
  if (err?.code !== 'EPIPE') return;
  process.exit(runExitCode != null ? runExitCode : 2);
}
process.stdout.on('error', onPipeError);
process.stderr.on('error', onPipeError);

// 需要「值」的旗標（其餘一律當布林）
const VALUE_FLAGS = new Set(['gate', 'html', 'out', 'format', 'preset', 'reason', 'actor', 'app', 'routes', 'port', 'host', 'stack', 'density', 'motion', 'contrast', 'variance', 'source', 'license', 'scope', 'viewport']);
// `--html` deliberately supports a bare boolean form (`--html`) as well as an
// optional destination (`--html report.html`). Every other value flag must
// carry a concrete token. Treating a missing value as boolean true used to
// turn `--reason` into the approval text "true" and `--out` into a file named
// "true", which is both surprising and a governance bypass.
const OPTIONAL_VALUE_FLAGS = new Set(['html']);

const ALIAS = { h: 'help', v: 'version' };

// 旗標白名單：全域＋各命令。未知旗標 → exit 2（與 --gate typo 一致），並建議最相近者。
// 不列名的命令（如未知命令）不做旗標驗證——交給 dispatch 報「未知命令」。
const GLOBAL_FLAGS = ['help', 'version'];
const FLAGS_BY_CMD = {
  new: ['preset'],
  init: ['preset'],
  verify: ['full', 'require-gates', 'gate', 'json', 'summary', 'sarif', 'html', 'out', 'open', 'no-cache', 'all', 'app', 'routes'],
  proof: ['json', 'summary', 'sarif', 'html', 'out', 'open', 'no-cache', 'all', 'app', 'routes'],
  slop: ['json', 'summary', 'sarif', 'html', 'out', 'open', 'no-cache', 'all'],
  watch: ['full', 'require-gates', 'no-cache', 'all'],
  build: ['check', 'format'],
  fix: ['slop', 'dry-run'],
  baseline: ['accept', 'all', 'prune', 'full'],
  design: ['json', 'accept', 'reason', 'actor'],
  tokens: ['json', 'out'],
  contrast: ['json'],
  explain: [],
  rules: ['json'],
  report: ['html', 'sarif', 'json', 'out', 'open', 'all'],
  benchmark: ['json', 'html', 'out', 'keep-workspace'],
  system: ['json', 'out', 'include-generated'],
  studio: ['port', 'host', 'open', 'allow-remote', 'json'],
  bridge: ['json', 'publish', 'require-sinks'],
  codex: ['json', 'trust-project-config'],
  claude: ['json', 'trust-project-config'],
  intelligence: ['json', 'stack', 'density', 'motion', 'contrast', 'variance'],
  reference: ['json', 'source', 'license', 'scope', 'viewport'],
  doctor: [],
  help: [],
};

/** 該命令允許的旗標集合（含全域）；未列名的命令回 null（不驗證）。 */
function allowedFlags(cmd) {
  const per = FLAGS_BY_CMD[cmd];
  if (!per) return null;
  return new Set([...GLOBAL_FLAGS, ...per]);
}

// Damerau-OSA 編輯距離（含相鄰換位＝1，供未知旗標建議最相近者；如 --htlm → --html）。
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      // 相鄰換位（transposition）算 1 步。
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}
/** 從 allowed 找與 key 最相近的旗標（距離夠近或有前綴關係才回，否則 null）。 */
function nearestFlag(key, allowed) {
  let best = null, bestD = Infinity;
  for (const cand of allowed) {
    const dist = editDistance(key, cand);
    if (dist < bestD) { bestD = dist; best = cand; }
    else if (dist === bestD && cand.startsWith(key)) best = cand;
  }
  const threshold = Math.max(2, Math.ceil(Math.max(key.length, best?.length ?? 0) / 2));
  return best && bestD <= threshold ? best : null;
}
/** 驗證 flags 是否都在白名單內。回傳錯誤訊息（含建議）或 null。 */
function checkFlags(cmd, flags) {
  const allowed = allowedFlags(cmd);
  if (!allowed) return null; // 未知命令：不驗旗標，讓 dispatch 報未知命令
  for (const key of Object.keys(flags)) {
    if (allowed.has(key)) continue;
    const sugg = nearestFlag(key, allowed);
    return M.unknownFlag(cmd, key, sugg);
  }
  return null;
}

function checkFlagValues(cmd, flags) {
  for (const key of VALUE_FLAGS) {
    if (!Object.prototype.hasOwnProperty.call(flags, key)) continue;
    if (flags[key] !== true && flags[key] !== '') continue;
    if (flags[key] === true && OPTIONAL_VALUE_FLAGS.has(key)) continue;
    return M.missingFlagValue(cmd ?? '', key);
  }
  return null;
}

function checkFlagCombinations(cmd, flags) {
  if (!['verify', 'proof', 'slop', 'report'].includes(cmd)) return null;
  const selected = ['summary', 'json', 'sarif', 'html'].filter((key) => flags[key] != null && flags[key] !== false);
  return selected.length > 1 ? M.surfaceConflict(selected.map((key) => `--${key}`)) : null;
}

function checkFixedAliasFlags(cmd, flags) {
  if (cmd !== 'slop') return null;
  const rejected = ['gate', 'full', 'require-gates'].filter((key) => Object.prototype.hasOwnProperty.call(flags, key));
  return rejected.length ? M.slopFixedGate(rejected.map((key) => `--${key}`)) : null;
}

/** 解析 argv → { cmd, args, flags }。第一個非旗標 token 當 cmd。 */
export function parse(argv) {
  const args = [];
  const flags = {};
  let cmd;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') { for (i++; i < argv.length; i++) args.push(argv[i]); break; }
    if (tok.startsWith('--')) {
      let key = tok.slice(2), val = true;
      const eq = key.indexOf('=');
      if (eq !== -1) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else if (VALUE_FLAGS.has(key) && argv[i + 1] != null && !argv[i + 1].startsWith('-')) { val = argv[++i]; }
      flags[key] = val;
    } else if (tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok)) {
      for (const ch of tok.slice(1)) flags[ALIAS[ch] ?? ch] = true;
    } else if (cmd === undefined) {
      cmd = tok;
    } else {
      args.push(tok);
    }
  }
  return { cmd, args, flags };
}

export async function main(argv) {
  const { cmd, args, flags } = parse(argv);

  if (flags.version) { await printVersion(); return 0; }
  // --help 一律短路：印 help（可依 cmd 印對應段落）並 exit 0，絕不順手執行命令（如寫 .dk/report.json）。
  if (flags.help) { printHelp(cmd); return 0; }

  // `slop` is a fixed-gate alias. Reject verify-only orchestration flags with
  // a specific usage error before generic unknown-flag suggestions (for
  // example, --full must never be misleadingly suggested as --all).
  const aliasErr = checkFixedAliasFlags(cmd, flags);
  if (aliasErr) { process.stderr.write(aliasErr); return 2; }

  // 未知旗標一律 exit 2，並在距離足夠近時建議合法旗標。
  const flagErr = checkFlags(cmd, flags);
  if (flagErr) { process.stderr.write(flagErr); return 2; }
  const valueErr = checkFlagValues(cmd, flags);
  if (valueErr) { process.stderr.write(valueErr); return 2; }
  const combinationErr = checkFlagCombinations(cmd, flags);
  if (combinationErr) { process.stderr.write(combinationErr); return 2; }

  try {
    const code = await dispatch(cmd, args, flags, { cwd: process.cwd() });
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    // 安全網：畸形 2025.10 物件式 token 若從命令層守門外的路徑下探到引擎（DkTokenError），
    // 在此轉為可操作的 exit 2 訊息；正常路徑由 guardTokenValues 先集中攔截。
    if (err && err.code === 'DK_TOKEN') {
      const red = (s) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
      process.stderr.write(red('✗ tokens 值無法解析：') + (err.message ?? '') + '\n');
      return 2;
    }
    if (err && err.code === 'DK_UNSAFE_WRITE') {
      const red = (s) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
      process.stderr.write(red('✗ 已拒絕不安全的檔案寫入：') + (err.message ?? '') + '\n');
      process.stderr.write('請改用專案目錄內的一般路徑，並移除輸出路徑上的 symbolic link。\n');
      return 2;
    }
    process.stderr.write(M.unexpectedError(err?.stack ?? err));
    return 2;
  }
}

async function printVersion() {
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { join, dirname } = await import('node:path');
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    process.stdout.write(`dk ${pkg.version}\n`);
  } catch { process.stdout.write('dk\n'); }
}

// 作為 CLI 執行時：跑 main 並以其回傳值當 process exit code。
// 同步記住 run 的退出碼（供 EPIPE 處理器保留，見上）——若之後管線斷裂，非零碼不會被翻成 0。
main(process.argv.slice(2)).then((code) => {
  runExitCode = typeof code === 'number' ? code : 0;
  process.exitCode = runExitCode;
});
