/* ============================================================
   `dk bridge` — repository-owned integration operations.

   This surface deliberately separates connection setup, evidence collection,
   and evidence inspection. No command can create or update Taste Lock,
   baselines, or approval history.
   ============================================================ */
import { closeSync, openSync, readSync } from 'node:fs';
import { relative } from 'node:path';
import { loadConfig } from '../core/config.mjs';
import {
  auditBridge,
  builtInAdapterCatalog,
  createConnectionAdapter,
  ingestBridgeEnvelope,
  initializeBridgeManifest,
  latestBridgeEnvelope,
  syncBridge,
} from '../bridge/orchestrator.mjs';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const MAX_INGEST_BYTES = 8 * 1024 * 1024;

export async function cmdBridge(args, flags, cwd) {
  const subcommand = args[0] ?? 'status';
  const rest = args.slice(1);
  const invalidFlag = bridgeSubcommandFlagError(subcommand, flags);
  if (invalidFlag) return usage(`Unknown flag --${invalidFlag} for dk bridge ${subcommand}.`, flags);
  if (subcommand === 'help') {
    printBridgeHelp();
    return EXIT_OK;
  }
  if (subcommand === 'catalog') return catalog(flags);

  const config = await loadBridgeConfig(cwd);
  if (printFatalConfigErrors(config, flags.json === true)) return EXIT_USAGE;

  try {
    switch (subcommand) {
      case 'init': return init(config, rest, flags, cwd);
      case 'list': return list(config, rest, flags);
      case 'status': case 'verify': return status(config, rest, flags);
      case 'sync': return await sync(config, rest, flags);
      case 'inspect': return inspect(config, rest, flags);
      case 'ingest': return await ingest(config, rest, flags);
      case 'doctor': return await doctor(config, rest, flags);
      default: return usage(`Unknown Bridge subcommand: ${subcommand}.`, flags);
    }
  } catch (error) {
    const output = errorSurface(error);
    if (flags.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else {
      process.stderr.write(`Bridge ${subcommand} failed: ${output.error.message}\n`);
      if (output.error.details) process.stderr.write(`${JSON.stringify(output.error.details, null, 2)}\n`);
    }
    return isUsageError(error) ? EXIT_USAGE : EXIT_FAIL;
  }
}

async function catalog(flags) {
  const adapters = await builtInAdapterCatalog();
  if (flags.json) process.stdout.write(`${JSON.stringify({ schema: 'axion-bridge-catalog/v1', adapters }, null, 2)}\n`);
  else {
    process.stdout.write('\nAxion Bridge built-in adapters\n\n');
    for (const adapter of adapters) {
      const permissions = [...new Set(Object.values(adapter.permissions).flat())];
      process.stdout.write(`  ${adapter.id.padEnd(11)} ${adapter.kind.padEnd(11)} ${adapter.capabilities.join(', ')}\n`);
      process.stdout.write(`  ${''.padEnd(11)} permissions: ${permissions.length ? permissions.join(', ') : 'none'}\n`);
    }
    process.stdout.write('\n');
  }
  return EXIT_OK;
}

function init(config, args, flags, cwd) {
  if (args.length) return usage('Usage: dk bridge init [--json]', flags);
  const source = config.bridge?.sourcePath ?? 'design/bridge.json';
  const result = initializeBridgeManifest(cwd, source);
  const path = relative(cwd, result.path) || result.path;
  if (flags.json) process.stdout.write(`${JSON.stringify({ schema: 'axion-bridge-init/v1', path, created: true }, null, 2)}\n`);
  else process.stdout.write(`Created ${path}\nNext: add a connection, run \`dk bridge doctor\`, then \`dk bridge sync\`.\n`);
  return EXIT_OK;
}

function list(config, args, flags) {
  if (args.length) return usage('Usage: dk bridge list [--json] [--require-sinks]', flags);
  const result = auditBridge(config, { verifyArtifacts: true, evaluateSinks: flags['require-sinks'] === true });
  if (flags.json) process.stdout.write(`${JSON.stringify({
    schema: 'axion-bridge-list/v1',
    status: result.status,
    generatedAt: result.generatedAt,
    ledger: result.ledger,
    summary: result.summary,
    connections: result.connections,
    issues: result.issues,
  }, null, 2)}\n`);
  else renderConnections(result);
  return result.status === 'failed' ? EXIT_FAIL : EXIT_OK;
}

function status(config, args, flags) {
  if (args.length) return usage('Usage: dk bridge status [--json] [--require-sinks]', flags);
  const result = auditBridge(config, { verifyArtifacts: true, evaluateSinks: flags['require-sinks'] === true });
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    renderConnections(result);
    process.stdout.write(`Ledger: ${result.ledger.missing ? 'not created' : result.ledger.ok ? 'verified' : 'invalid'}\n`);
    process.stdout.write(`Result: ${result.status} · ${result.summary.healthy}/${result.summary.total} healthy\n`);
  }
  return result.status === 'failed' ? EXIT_FAIL : EXIT_OK;
}

async function sync(config, ids, flags) {
  if (config.bridge?.connections?.length === 0) {
    return usage('No Bridge connections configured. Run `dk bridge init`, then add at least one connection.', flags);
  }
  const result = await syncBridge(config, { ids, publish: flags.publish === true });
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const run of result.runs) {
      const mark = run.status === 'passed' ? '✓' : run.status === 'partial' ? '!' : '✗';
      process.stdout.write(`  ${mark} ${(run.connection ?? '?').padEnd(18)} ${(run.role ?? 'source').padEnd(7)} ${run.status}\n`);
    }
    process.stdout.write(`\nBridge sync: ${result.status} · ${result.envelopes.length} envelope(s) collected\n`);
    if (!flags.publish) process.stdout.write('Sink publishing was not requested; use --publish for configured sinks.\n');
  }
  return result.status === 'failed' ? EXIT_FAIL : EXIT_OK;
}

function inspect(config, args, flags) {
  if (args.length !== 1) return usage('Usage: dk bridge inspect <connection-id> [--json]', flags);
  const envelope = latestBridgeEnvelope(config, args[0]);
  if (!envelope) {
    const error = new Error(`No evidence envelope found for ${args[0]}.`);
    error.code = 'AXION_BRIDGE_NOT_FOUND';
    throw error;
  }
  if (flags.json) process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  else {
    process.stdout.write(`\n${envelope.provider} · ${envelope.payload?.capability ?? envelope.kind}\n`);
    process.stdout.write(`  id       ${envelope.id}\n  trust    ${envelope.trust.level}\n  created  ${envelope.createdAt}\n`);
    process.stdout.write(`  commit   ${envelope.binding.commit ?? '(unbound)'}\n  digest   ${envelope.digest}\n`);
    process.stdout.write(`  status   ${envelope.payload?.status ?? 'unknown'}\n  artifacts ${envelope.artifacts.length}\n\n`);
  }
  return EXIT_OK;
}

async function loadBridgeConfig(cwd) {
  const write = process.stdout.write;
  let suppressedBytes = 0;
  process.stdout.write = function suppressProjectConfigOutput(chunk, encoding, callback) {
    suppressedBytes += Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk),
      typeof encoding === 'string' ? encoding : undefined);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  try {
    return await loadConfig(cwd);
  } finally {
    process.stdout.write = write;
    if (suppressedBytes) {
      process.stderr.write(`Bridge suppressed ${suppressedBytes} byte(s) written by project configuration.\n`);
    }
  }
}

async function ingest(config, args, flags) {
  if (args.length !== 2) return usage('Usage: dk bridge ingest <connection-id> <envelope.json|-> [--json]', flags);
  const [connectionId, file] = args;
  const bytes = readIngestBytes(file);
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    const wrapped = new Error(`Envelope is not valid JSON: ${error.message}`);
    wrapped.code = 'AXION_BRIDGE_INPUT';
    throw wrapped;
  }
  const result = await ingestBridgeEnvelope(config, connectionId, envelope);
  const audit = auditBridge(config, { verifyArtifacts: true });
  const output = {
    schema: 'axion-bridge-ingest/v1', connection: connectionId, envelope: envelope.id,
    ledger: result.path, headHash: result.headHash, status: audit.status,
  };
  if (flags.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(`Ingested ${envelope.id} for ${connectionId}; ledger head ${result.headHash.slice(0, 12)}.\n`);
  return audit.status === 'failed' ? EXIT_FAIL : EXIT_OK;
}

async function doctor(config, args, flags) {
  if (args.length) return usage('Usage: dk bridge doctor [--json]', flags);
  const checks = [];
  for (const connection of config.bridge?.connections ?? []) {
    if (connection.enabled === false) {
      checks.push({ id: connection.id, status: 'disabled', issues: [] });
      continue;
    }
    const issues = [];
    try {
      const adapter = await createConnectionAdapter(connection, { root: config.cwd });
      const expectedOperations = lifecycleForRole(connection.role);
      const missingOperations = expectedOperations.filter((operation) => !adapter.manifest.lifecycle.includes(operation));
      for (const operation of missingOperations) {
        issues.push({ code: 'lifecycle-missing', operation, message: `Adapter does not implement ${operation}, required by role ${connection.role ?? 'source'}.` });
      }
      for (const operation of expectedOperations.filter((name) => adapter.manifest.lifecycle.includes(name))) {
        const required = adapter.manifest.permissions[operation] ?? [];
        const missing = required.filter((permission) => !hasGrant(connection.permissions ?? [], permission));
        if (missing.length) issues.push({ code: 'permission-missing', operation, values: missing });
      }
      for (const [key, value] of Object.entries(connection.options ?? {})) {
        if (/Env$/.test(key) && typeof value === 'string' && !process.env[value]) {
          issues.push({ code: 'environment-missing', key, variable: value });
        }
      }
    } catch (error) {
      issues.push({ code: error.code ?? 'adapter-invalid', message: String(error.message ?? error) });
    }
    checks.push({ id: connection.id, adapter: connection.adapter, required: connection.required === true, status: issues.length ? 'failed' : 'ready', issues });
  }
  const failed = checks.filter((check) => check.status === 'failed');
  const requiredFailed = failed.some((check) => check.required);
  const result = {
    schema: 'axion-bridge-doctor/v1',
    status: requiredFailed ? 'failed' : failed.length ? 'incomplete' : 'passed',
    artifactDir: config.bridge?.artifactDir,
    checks,
  };
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write('\nAxion Bridge doctor\n\n');
    if (!checks.length) process.stdout.write('  · no connections configured\n');
    for (const check of checks) {
      process.stdout.write(`  ${check.status === 'ready' ? '✓' : check.status === 'disabled' ? '·' : '✗'} ${check.id} — ${check.status}\n`);
      for (const issue of check.issues) process.stdout.write(`      ${issue.code}: ${issue.message ?? issue.values?.join(', ') ?? issue.variable}\n`);
    }
    process.stdout.write('\n');
  }
  return requiredFailed ? EXIT_FAIL : EXIT_OK;
}

function renderConnections(result) {
  process.stdout.write('\nAxion Bridge connections\n\n');
  if (!result.connections.length) process.stdout.write('  · no connections configured\n');
  for (const connection of result.connections) {
    const mark = connection.status === 'healthy' ? '✓' : connection.status === 'disabled' ? '·' : connection.status === 'failed' ? '✗' : '!';
    const required = connection.required ? 'required' : 'optional';
    process.stdout.write(`  ${mark} ${connection.id.padEnd(18)} ${String(connection.adapter).padEnd(11)} ${required.padEnd(8)} ${connection.status}\n`);
    for (const issue of connection.issues ?? []) process.stdout.write(`      ${issue.code}: ${issue.message}\n`);
  }
  const globalIssues = (result.issues ?? []).filter((issue) => !issue.connection);
  if (globalIssues.length) {
    process.stdout.write('\n  Global ledger issues\n');
    for (const issue of globalIssues) process.stdout.write(`      ${issue.code}: ${issue.message}\n`);
  }
  process.stdout.write('\n');
}

function readIngestBytes(file) {
  if (file === '-') return readBoundedDescriptor(0);
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    return readBoundedDescriptor(descriptor);
  } catch (error) {
    if (error?.code === 'AXION_BRIDGE_INPUT') throw error;
    const wrapped = new Error(`Could not read envelope input: ${String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 1000)}`);
    wrapped.code = 'AXION_BRIDGE_INPUT';
    throw wrapped;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readBoundedDescriptor(descriptor) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  while (true) {
    const count = readSync(descriptor, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_INGEST_BYTES) throw sizeError();
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks, total);
}

function hasGrant(grants, required) {
  const set = new Set(grants);
  return set.has('*') || set.has(required) || set.has(`${required.split(':')[0]}:*`);
}

function lifecycleForRole(role = 'source') {
  return role === 'sink' ? ['publish'] : role === 'both' ? ['collect', 'publish'] : ['collect'];
}

function printFatalConfigErrors(config, json = false) {
  const fatal = (config.errors ?? []).filter((item) => item.meta?.configFatal);
  if (!fatal.length) return false;
  if (json) {
    process.stdout.write(`${JSON.stringify({
      schema: 'axion-bridge-error/v1',
      status: 'failed',
      error: {
        code: 'AXION_BRIDGE_CONFIG',
        message: 'Bridge config is invalid.',
        issues: fatal.map((issue) => ({
          path: issue.meta?.configPath ?? issue.file ?? 'bridge',
          message: issue.message,
          ...(issue.fix ? { fix: issue.fix } : {}),
        })),
      },
    }, null, 2)}\n`);
    return true;
  }
  process.stderr.write('Bridge config is invalid:\n');
  for (const issue of fatal) process.stderr.write(`  · ${issue.message}${issue.fix ? `\n    ${issue.fix}` : ''}\n`);
  return true;
}

function errorSurface(error) {
  return {
    schema: 'axion-bridge-error/v1',
    status: 'failed',
    error: {
      code: error?.code ?? 'AXION_BRIDGE_ERROR',
      message: String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 2000),
      ...(error?.details != null ? { details: error.details } : {}),
      ...(error?.issues != null ? { issues: error.issues } : {}),
      ...(error?.bridgeRuns != null ? { runs: error.bridgeRuns } : {}),
    },
  };
}

function isUsageError(error) {
  return ['AXION_BRIDGE_CONNECTION', 'AXION_BRIDGE_PATH', 'AXION_BRIDGE_MODULE', 'AXION_BRIDGE_ADAPTER', 'AXION_BRIDGE_PERMISSION', 'AXION_BRIDGE_EXISTS', 'AXION_BRIDGE_INPUT', 'AXION_BRIDGE_PUBLISH_INPUT']
    .includes(error?.code);
}

function sizeError() {
  const error = new Error(`Envelope exceeds the ${MAX_INGEST_BYTES} byte ingest limit.`);
  error.code = 'AXION_BRIDGE_INPUT';
  return error;
}

function usage(message, flags = {}) {
  const fullMessage = `${message} Run \`dk bridge help\` for all subcommands.`;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      schema: 'axion-bridge-error/v1', status: 'failed',
      error: { code: 'AXION_BRIDGE_USAGE', message: fullMessage },
    }, null, 2)}\n`);
  } else process.stderr.write(`${message}\nRun \`dk bridge help\` for all subcommands.\n`);
  return EXIT_USAGE;
}

function bridgeSubcommandFlagError(subcommand, flags) {
  const allowed = {
    help: [], catalog: ['json'], init: ['json'], list: ['json', 'require-sinks'],
    status: ['json', 'require-sinks'], verify: ['json', 'require-sinks'], sync: ['json', 'publish'],
    inspect: ['json'], ingest: ['json'], doctor: ['json'],
  }[subcommand];
  if (!allowed) return null;
  return Object.keys(flags).find((flag) => !allowed.includes(flag)) ?? null;
}

export function printBridgeHelp() {
  process.stdout.write(`
dk bridge — federate external design and delivery evidence

Usage:
  dk bridge init                         create design/bridge.json (never overwrite)
  dk bridge catalog [--json]             list built-in adapters and permissions
  dk bridge doctor [--json]              preflight role-specific grants and named env references
  dk bridge list [--json] [--require-sinks]
                                            list configured connections and latest state
  dk bridge sync [id ...] [--publish]     collect evidence; optionally publish to sinks
  dk bridge status [--json] [--require-sinks]
                                            verify status, trust, freshness, repo/commit, artifacts, ledger
  dk bridge inspect <id> [--json]         read the latest ledger-validated envelope
  dk bridge ingest <id> <file|-> [--json] validate and append an offline envelope

--require-sinks audits required sink receipts without publishing. Unattempted pure
sinks otherwise stay deferred; an explicit sync --publish is always fail-closed.
When ids are supplied with --publish, select at least one source and one sink;
omit ids to collect all enabled sources and publish to all enabled sinks.

Trust: untrusted < linked/self-attested < verified. External evidence never grants
Taste Lock, baseline, or approval authority. Required connections fail closed.

Exit: 0 passed/optional incomplete · 1 required provider/policy/ledger failure · 2 usage/config

`);
}
