/* `dk codex` — project-scoped Codex integration. Never writes global state. */
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pick } from '../core/i18n.mjs';
import {
  CodexIntegrationError,
  buildCodexDesignContext,
  codexStarterPrompt,
  inspectCodexIntegration,
  installCodexIntegration,
} from '../codex/index.mjs';

const EXIT_OK = 0, EXIT_USAGE = 2;

export async function cmdCodex(args, flags, cwd) {
  const subcommand = args[0] ?? 'status';
  const rest = args.slice(1);
  if (subcommand === 'help') { printCodexHelp(); return EXIT_OK; }
  try {
    if (subcommand === 'status' || subcommand === 'doctor') {
      if (rest.length) return usage(`dk codex ${subcommand}`, flags);
      return printStatus(inspectCodexIntegration(cwd), flags);
    }
    if (subcommand === 'init') {
      if (rest.length) return usage('dk codex init', flags);
      return printInstall(installCodexIntegration(cwd), flags);
    }
    if (subcommand === 'context') {
      if (rest.length) return usage('dk codex context', flags);
      const context = await buildCodexDesignContext(cwd, {
        trustProjectConfig: flags['trust-project-config'] === true,
      });
      if (flags.json) process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
      else printContext(context);
      return EXIT_OK;
    }
    if (subcommand === 'prompt') {
      if (rest.length > 1) return usage('dk codex prompt [auto|explore|refine|reconstruct|reimagine|verify]', flags);
      const lane = String(rest[0] ?? 'auto').toLowerCase();
      const prompt = codexStarterPrompt(lane);
      if (flags.json) process.stdout.write(`${JSON.stringify({ schema: 'axion-codex-prompt/v1', lane, prompt }, null, 2)}\n`);
      else process.stdout.write(`${prompt}\n`);
      return EXIT_OK;
    }
    if (subcommand === 'mcp') {
      if (rest.length) return usage('dk codex mcp', flags);
      return printMcpSpec(cwd, flags);
    }
    process.stderr.write(pick(
      `未知 Codex 子命令：${subcommand}\n執行 dk codex help 看完整用法。\n`,
      `Unknown Codex subcommand: ${subcommand}\nRun dk codex help for usage.\n`,
    ));
    return EXIT_USAGE;
  } catch (error) {
    const code = error instanceof CodexIntegrationError ? error.code : 'DK_CODEX_CONTEXT';
    const message = error?.message ?? String(error);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({
        schema: 'axion-codex-error/v1',
        code,
        error: message,
      })}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    return EXIT_USAGE;
  }
}

function printStatus(status, flags) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return status.status === 'ready' ? EXIT_OK : EXIT_USAGE;
  }
  const mark = status.status === 'ready' ? '✓' : status.status === 'missing' ? '○' : '✗';
  process.stdout.write([
    '',
    `${mark} Axion for Codex · ${status.status}`,
    `  ${pick('範圍', 'scope')}       repository only`,
    `  ${pick('啟用', 'activation')}  explicit $dk-design`,
    `  skill       ${status.skill.path} (${status.skill.kind})`,
    `  runtime     ${status.runtime.status} (${status.runtime.kind})`,
    `  CLI         ${status.surfaces.cli}`,
    `  Desktop     ${status.surfaces.desktop}`,
    `  ${pick('全域寫入', 'global writes')}  none`,
    ...(status.scopeGuard.issue ? [`  ${pick('問題', 'issue')}       ${status.scopeGuard.issue}`]
      : status.skill.issue ? [`  ${pick('問題', 'issue')}       ${status.skill.issue}`]
      : status.runtime.issue ? [`  ${pick('問題', 'issue')}       ${status.runtime.issue}`] : []),
    '',
    status.status === 'ready'
      ? pick('下一步：在 Codex CLI 或桌面版明確輸入 `$dk-design`。', 'Next: explicitly invoke `$dk-design` in Codex CLI or the desktop app.')
      : status.runtime.status !== 'ready'
        ? pick(
          '下一步：先把相同版本 axion-designer 安裝成專案 dependency，再用該專案的 local `dk codex init`。',
          'Next: install this axion-designer version as a project dependency, then run its local `dk codex init`.',
        )
        : status.status !== 'missing'
          ? pick(
            '下一步：先審查、還原或明確移除既有 repo skill；`dk codex init` 不會覆寫 stale／invalid 內容。',
            'Next: review, restore, or explicitly remove the existing repo skill; `dk codex init` will not overwrite stale/invalid content.',
          )
          : pick('下一步：執行 `dk codex init`；只會寫入目前 repository。', 'Next: run `dk codex init`; it writes only inside this repository.'),
    '',
  ].join('\n'));
  return status.status === 'ready' ? EXIT_OK : EXIT_USAGE;
}

function printInstall(result, flags) {
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write([
    '',
    result.changed ? '✓ Axion for Codex installed' : '✓ Axion for Codex already ready',
    `  ${result.skill.path}`,
    `  ${pick('啟用方式', 'activation')}  explicit $dk-design`,
    `  ${pick('全域設定', 'global config')}  untouched`,
    '',
    pick('請開一個新的 Codex task，或讓目前 client 重新載入 skills。', 'Start a new Codex task, or let the current client refresh its skills.'),
    '',
  ].join('\n'));
  return EXIT_OK;
}

function printContext(context) {
  const report = context.evidence.report;
  const proof = context.evidence.appProof;
  process.stdout.write([
    '',
    `Axion Codex Context · ${context.project}`,
    `  ${pick('建議 lane', 'suggested lane')}  ${context.suggestedLane.lane} — ${context.suggestedLane.reason}`,
    `  direction       ${context.direction.status} · lock ${context.direction.lock.status}`,
    `  evidence        ${report.status} · ${report.counts?.error ?? 0} error · ${report.counts?.warn ?? 0} warn`,
    `  App Proof       ${proof.status} · ${proof.summary?.provenCases ?? 0} proven cases`,
    `  config          ${context.configuration.status}${context.configuration.executable ? ' · executable' : ''}`,
    `  graph           ${context.repository.stats?.nodes ?? 0} nodes · ${context.repository.routes.length} routes in context`,
    `  context         ${context.contextBytes}/${context.contextBudget} bytes`,
    '',
    `${pick('下一個最窄命令', 'Narrow next commands')}:`,
    ...context.nextCommands.map((command) => `  ${command}`),
    '',
    pick('完整機器 context：dk codex context --json', 'Full machine context: dk codex context --json'),
    '',
  ].join('\n'));
}

function printMcpSpec(cwd, flags) {
  const root = resolvePath(cwd);
  const integration = inspectCodexIntegration(root);
  if (integration.scopeGuard.status !== 'ready') {
    throw new CodexIntegrationError(`Refusing global Codex MCP scope: ${integration.scopeGuard.issue}.`, 'DK_CODEX_SCOPE');
  }
  const entry = fileURLToPath(new URL('../../bin/dk-mcp.mjs', import.meta.url));
  const spec = {
    schema: 'axion-codex-mcp-launch/v1',
    scope: 'repository',
    command: process.execPath,
    args: [entry, '--root', root],
    cwd: root,
    fixedRoot: true,
    writesConfig: false,
    primaryResource: 'axion://codex/context',
    authority: 'read evidence and run bounded verification; never accept locks, baselines, or Bridge publish',
  };
  if (flags.json) process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
  else process.stdout.write([
    '',
    'Axion MCP · project-bound launch specification',
    `  command = ${JSON.stringify(spec.command)}`,
    `  args    = ${JSON.stringify(spec.args)}`,
    '',
    pick('這個命令只列出規格，不會修改任何 Codex 設定或啟動常駐程序。', 'This command only prints the spec; it changes no Codex config and starts no daemon.'),
    '',
  ].join('\n'));
  return EXIT_OK;
}

function usage(form, flags) {
  const message = pick(`用法：${form} [--json]\n`, `Usage: ${form} [--json]\n`);
  if (flags.json) process.stdout.write(`${JSON.stringify({ schema: 'axion-codex-error/v1', error: message.trim() })}\n`);
  else process.stderr.write(message);
  return EXIT_USAGE;
}

export function printCodexHelp() {
  process.stdout.write(pick(`
dk codex — 將 Axion Designer 安全地特化到 Codex CLI 與桌面版

  dk codex status [--json]      唯讀檢查 repo skill、明確啟用與隔離狀態
  dk codex init [--json]        以相同版本 local runtime，只在 .agents/skills/dk-design 安裝；絕不覆寫
  dk codex context [--json]     建立 <12KB、source-backed 的設計任務 context；預設不執行 JS config
      [--trust-project-config]  明確信任後才載入 dk.config.mjs／js
  dk codex prompt [lane]        產生 auto／explore／refine／reconstruct／reimagine／verify 起手 prompt
  dk codex mcp [--json]         只列出綁定目前 repo 的 MCP 啟動規格，不寫設定

安全邊界：不寫 ~/.codex、~/.agents、plugin cache 或 marketplace；skill 只能以 $dk-design 明確啟用。
`, `
dk codex — specialize Axion Designer for Codex CLI and the desktop app

  dk codex status [--json]      inspect repo skill, explicit activation, and isolation
  dk codex init [--json]        use the matching local runtime; install only at .agents/skills/dk-design; never overwrite
  dk codex context [--json]     build a <12KB source-backed context; never execute JS config by default
      [--trust-project-config]  load dk.config.mjs/js only after explicit trust
  dk codex prompt [lane]        emit an auto/explore/refine/reconstruct/reimagine/verify starter prompt
  dk codex mcp [--json]         print a current-repo MCP launch spec without writing config

Boundary: never writes ~/.codex, ~/.agents, plugin caches, or marketplaces; only explicit $dk-design invocation activates the skill.
`));
}
