#!/usr/bin/env node
import { startAxionMcpStdio } from '../src/mcp/index.mjs';

function usage() {
  return [
    'Usage: dk-mcp [--root <dir>] [--timeout-ms <ms>] [--max-resource-bytes <n>] [--max-tool-bytes <n>] [--allow-remote-proof] [--intelligence-only]',
    '',
    'The process speaks MCP over stdio. stdout is reserved exclusively for protocol messages.',
    '',
  ].join('\n');
}

function parse(argv) {
  const options = {};
  const valueFlags = new Map([
    ['--root', 'root'],
    ['--timeout-ms', 'timeoutMs'],
    ['--max-resource-bytes', 'maxResourceBytes'],
    ['--max-tool-bytes', 'maxToolBytes'],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return { help: true };
    if (token === '--allow-remote-proof') {
      options.allowRemoteProof = true;
      continue;
    }
    if (token === '--intelligence-only') {
      options.intelligenceOnly = true;
      continue;
    }
    const key = valueFlags.get(token);
    if (!key) throw new Error(`Unknown option: ${token}`);
    const value = argv[++index];
    if (value == null || value.startsWith('--')) throw new Error(`${token} requires a value.`);
    options[key] = key === 'root' ? value : Number(value);
  }
  return { options };
}

try {
  const parsed = parse(process.argv.slice(2));
  if (parsed.help) {
    process.stderr.write(usage());
    process.exitCode = 0;
  } else {
    await startAxionMcpStdio(parsed.options);
  }
} catch (error) {
  // MCP stdout must remain clean even during startup failures.
  process.stderr.write(`dk-mcp: ${error?.message ?? error}\n`);
  process.exitCode = 2;
}
