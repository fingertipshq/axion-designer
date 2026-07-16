/* `dk claude` — project-scoped Claude Code integration. Never writes global state. */
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pick } from '../core/i18n.mjs';
import {
  ClaudeIntegrationError,
  claudeStarterPrompt,
  inspectClaudeIntegration,
  installClaudeIntegration,
} from '../claude/index.mjs';
import { buildCodexDesignContext } from '../codex/index.mjs';

const EXIT_OK = 0, EXIT_USAGE = 2;

export async function cmdClaude(args, flags, cwd) {
  const subcommand = args[0] ?? 'status';
  const rest = args.slice(1);
  if (subcommand === 'help') { printClaudeHelp(); return EXIT_OK; }
  try {
    if (subcommand === 'status' || subcommand === 'doctor') {
      if (rest.length) return usage(`dk claude ${subcommand}`, flags);
      return printStatus(inspectClaudeIntegration(cwd), flags);
    }
    if (subcommand === 'init') {
      if (rest.length) return usage('dk claude init', flags);
      return printInstall(installClaudeIntegration(cwd), flags);
    }
    if (subcommand === 'context') {
      if (rest.length) return usage('dk claude context', flags);
      const context = await buildCodexDesignContext(cwd, {
        host: 'claude',
        trustProjectConfig: flags['trust-project-config'] === true,
      });
      if (flags.json) process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
      else printContext(context);
      return EXIT_OK;
    }
    if (subcommand === 'prompt') {
      if (rest.length > 1) return usage('dk claude prompt [auto|explore|refine|reconstruct|reimagine|verify]', flags);
      const lane = String(rest[0] ?? 'auto').toLowerCase();
      const prompt = claudeStarterPrompt(lane);
      if (flags.json) process.stdout.write(`${JSON.stringify({ schema: 'axion-claude-prompt/v1', lane, prompt }, null, 2)}\n`);
      else process.stdout.write(`${prompt}\n`);
      return EXIT_OK;
    }
    if (subcommand === 'mcp') {
      if (rest.length) return usage('dk claude mcp', flags);
      return printMcpSpec(cwd, flags);
    }
    process.stderr.write(pick(
      `未知 Claude 子命令：${subcommand}\n執行 dk claude help 看完整用法。\n`,
      `Unknown Claude subcommand: ${subcommand}\nRun dk claude help for usage.\n`,
    ));
    return EXIT_USAGE;
  } catch (error) {
    const code = error instanceof ClaudeIntegrationError ? error.code : 'DK_CLAUDE_CONTEXT';
    const message = error?.message ?? String(error);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({
        schema: 'axion-claude-error/v1',
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
    `${mark} Axion for Claude Code · ${status.status}`,
    `  ${pick('範圍', 'scope')}       repository only`,
    `  ${pick('啟用', 'activation')}  explicit /dk-design`,
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
      ? pick('下一步：在 Claude Code CLI 或桌面版明確輸入 `/dk-design`，或指名 dk-design skill。', 'Next: explicitly invoke `/dk-design` (or name the dk-design skill) in Claude Code CLI or the desktop app.')
      : status.runtime.status !== 'ready'
        ? pick(
          '下一步：先把相同版本 axion-designer 安裝成專案 dependency，再用該專案的 local `dk claude init`。',
          'Next: install this axion-designer version as a project dependency, then run its local `dk claude init`.',
        )
        : status.status !== 'missing'
          ? pick(
            '下一步：先審查、還原或明確移除既有 repo skill；`dk claude init` 不會覆寫 stale／invalid 內容。',
            'Next: review, restore, or explicitly remove the existing repo skill; `dk claude init` will not overwrite stale/invalid content.',
          )
          : pick('下一步：執行 `dk claude init`；只會寫入目前 repository。', 'Next: run `dk claude init`; it writes only inside this repository.'),
    '',
  ].join('\n'));
  return status.status === 'ready' ? EXIT_OK : EXIT_USAGE;
}

function printInstall(result, flags) {
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write([
    '',
    result.changed ? '✓ Axion for Claude Code installed' : '✓ Axion for Claude Code already ready',
    `  ${result.skill.path}`,
    `  ${pick('啟用方式', 'activation')}  explicit /dk-design`,
    `  ${pick('全域設定', 'global config')}  untouched`,
    '',
    pick('請開一個新的 Claude Code session，或讓目前 client 重新載入 skills。', 'Start a new Claude Code session, or let the current client refresh its skills.'),
    '',
  ].join('\n'));
  return EXIT_OK;
}

function printContext(context) {
  const report = context.evidence.report;
  const proof = context.evidence.appProof;
  process.stdout.write([
    '',
    `Axion Claude Context · ${context.project}`,
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
    pick('完整機器 context：dk claude context --json', 'Full machine context: dk claude context --json'),
    '',
  ].join('\n'));
}

function printMcpSpec(cwd, flags) {
  const root = resolvePath(cwd);
  const integration = inspectClaudeIntegration(root);
  if (integration.scopeGuard.status !== 'ready') {
    throw new ClaudeIntegrationError(`Refusing global Claude Code MCP scope: ${integration.scopeGuard.issue}.`, 'DK_CLAUDE_SCOPE');
  }
  const entry = fileURLToPath(new URL('../../bin/dk-mcp.mjs', import.meta.url));
  const spec = {
    schema: 'axion-claude-mcp-launch/v1',
    scope: 'repository',
    command: process.execPath,
    args: [entry, '--root', root],
    cwd: root,
    fixedRoot: true,
    writesConfig: false,
    primaryResource: 'axion://codex/context',
    authority: 'read evidence and run bounded verification; never accept locks, baselines, or Bridge publish',
    projectMcpJson: {
      mcpServers: {
        'axion-designer': {
          command: process.execPath,
          args: [entry, '--root', root],
        },
      },
    },
  };
  if (flags.json) process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
  else process.stdout.write([
    '',
    'Axion MCP · project-bound launch specification for Claude Code',
    `  command = ${JSON.stringify(spec.command)}`,
    `  args    = ${JSON.stringify(spec.args)}`,
    '',
    pick(
      '把 projectMcpJson 片段貼進目標 repo 的 .mcp.json 即可讓 Claude Code 讀取；這個命令本身不寫任何設定、不啟動常駐程序。',
      'Paste the projectMcpJson fragment into the target repo\'s .mcp.json for Claude Code to pick up; this command itself writes no config and starts no daemon.',
    ),
    '',
  ].join('\n'));
  return EXIT_OK;
}

function usage(form, flags) {
  const message = pick(`用法：${form} [--json]\n`, `Usage: ${form} [--json]\n`);
  if (flags.json) process.stdout.write(`${JSON.stringify({ schema: 'axion-claude-error/v1', error: message.trim() })}\n`);
  else process.stderr.write(message);
  return EXIT_USAGE;
}

export function printClaudeHelp() {
  process.stdout.write(pick(`
dk claude — 將 Axion Designer 安全地特化到 Claude Code CLI 與桌面版

  dk claude status [--json]     唯讀檢查 repo skill、明確啟用與隔離狀態
  dk claude init [--json]       以相同版本 local runtime，只在 .claude/skills/dk-design 安裝；絕不覆寫
  dk claude context [--json]    建立 <12KB、source-backed 的設計任務 context；預設不執行 JS config
      [--trust-project-config]  明確信任後才載入 dk.config.mjs／js
  dk claude prompt [lane]       產生 auto／explore／refine／reconstruct／reimagine／verify 起手 prompt
  dk claude mcp [--json]        只列出綁定目前 repo 的 MCP 啟動規格（含 .mcp.json 片段），不寫設定

安全邊界：不寫 ~/.claude、~/.agents、CLAUDE_CONFIG_DIR、plugin cache 或 marketplace；skill 只能以 /dk-design 明確啟用。
`, `
dk claude — specialize Axion Designer for Claude Code CLI and the desktop app

  dk claude status [--json]     inspect repo skill, explicit activation, and isolation
  dk claude init [--json]       use the matching local runtime; install only at .claude/skills/dk-design; never overwrite
  dk claude context [--json]    build a <12KB source-backed context; never execute JS config by default
      [--trust-project-config]  load dk.config.mjs/js only after explicit trust
  dk claude prompt [lane]       emit an auto/explore/refine/reconstruct/reimagine/verify starter prompt
  dk claude mcp [--json]        print a current-repo MCP launch spec (with an .mcp.json fragment) without writing config

Boundary: never writes ~/.claude, ~/.agents, CLAUDE_CONFIG_DIR, plugin caches, or marketplaces; only explicit /dk-design invocation activates the skill.
`));
}
