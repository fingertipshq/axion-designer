import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { defaultApprovalHistoryPath, readApprovalHistory } from '../core/approvals.mjs';
import { getRule, ruleFix, ruleTitle, ruleWhy } from '../core/finding.mjs';
import { KNOWN_GATE_IDS } from '../core/ledger.mjs';
import { discoverProofSurfaces, indexRepository } from '../system/indexer.mjs';
import {
  INTELLIGENCE_STACKS,
  loadIntelligenceCatalog,
  recommendDesignDirections,
} from '../intelligence/index.mjs';
import { createReferenceSystem } from '../reference/index.mjs';

export const AXION_MCP_RESOURCE_LIMIT = 1024 * 1024;
export const AXION_MCP_TOOL_LIMIT = 2 * 1024 * 1024;
export const AXION_MCP_TIMEOUT_MS = 120_000;

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_PATH = join(PACKAGE_ROOT, 'bin', 'dk.mjs');
const CONFIG_MODULE_URL = pathToFileURL(join(PACKAGE_ROOT, 'src', 'core', 'config.mjs')).href;
const CODEX_CONTEXT_MODULE_URL = pathToFileURL(join(PACKAGE_ROOT, 'src', 'codex', 'context.mjs')).href;
const PACKAGE_VERSION = readPackageVersion();
const JSON_MIME = 'application/json';
const RESOURCE_SCHEMA = 'axion-mcp-resource/v1';
const TOOL_SCHEMA = 'axion-mcp-tool/v1';
const MAX_CONFIG_PROBE_BYTES = 256 * 1024;
const BRIDGE_MODULE_URLS = [
  new URL('../bridge/index.mjs', import.meta.url),
  new URL('../bridge/core.mjs', import.meta.url),
];

// Config files are executable JavaScript. Resolve them in a child process so
// project console output can never corrupt the MCP server's stdout framing.
const CONFIG_PROBE_SOURCE = `
const root = process.argv[1];
const marker = process.argv[2];
const emit = (value) => process.stdout.write(marker + Buffer.from(JSON.stringify(value)).toString('base64') + '\\n');
try {
  const { loadConfig } = await import(${JSON.stringify(CONFIG_MODULE_URL)});
  const config = await loadConfig(root);
  const fatalIssues = (config.errors ?? [])
    .filter((finding) => finding?.meta?.configFatal === true)
    .slice(0, 50)
    .map((finding) => ({
      code: 'config-error',
      path: String(finding.meta?.configPath ?? finding.file ?? 'dk.config').slice(0, 500),
      message: String(finding.message ?? 'Invalid project configuration.').slice(0, 2000),
      ...(finding.fix ? { fix: String(finding.fix).slice(0, 2000) } : {}),
    }));
  const snapshot = {
    presetName: config.presetName ?? 'recommended',
    configFile: config.configFile ?? null,
    tokensPath: config.tokensPath,
    directionPath: config.directionPath,
    directionLockPath: config.directionLockPath,
    proof: config.proof ? { baseUrl: config.proof.baseUrl ?? null } : null,
    bridge: {
      enabled: config.bridge?.enabled === true || config.gates?.bridge?.enabled === true,
      artifactDir: config.bridge?.artifactDir ?? null,
      timeoutMs: config.bridge?.timeoutMs ?? null,
      freshnessMs: config.bridge?.freshnessMs ?? null,
      connections: (config.bridge?.connections ?? []).slice(0, 100).map((connection) => ({
        id: connection.id ?? null,
        adapter: connection.adapter ?? null,
        role: connection.role ?? 'source',
        enabled: connection.enabled !== false,
        required: connection.required === true,
        trust: connection.trust ?? 'linked',
        customModule: typeof connection.module === 'string' && connection.module.length > 0,
        permissions: Array.isArray(connection.permissions) ? connection.permissions.slice(0, 32) : [],
      })),
    },
  };
  emit({
    ok: fatalIssues.length === 0,
    status: fatalIssues.length ? 'config-error' : 'resolved',
    config: snapshot,
    ...(fatalIssues.length ? {
      error: 'Project configuration contains ' + fatalIssues.length + ' fatal issue(s).',
      issues: fatalIssues,
    } : {}),
  });
} catch (error) {
  emit({ ok: false, status: 'config-error', error: String(error?.message ?? error).slice(0, 2000), issues: [] });
}
`;

// The bounded context builder deliberately does not resolve executable project
// config by default. Keep it in a child anyway so unexpected project/runtime
// output can never corrupt MCP framing.
const CODEX_CONTEXT_PROBE_SOURCE = `
const root = process.argv[1];
const marker = process.argv[2];
const emit = (value) => process.stdout.write(marker + Buffer.from(JSON.stringify(value)).toString('base64') + '\\n');
try {
  const { buildCodexDesignContext } = await import(${JSON.stringify(CODEX_CONTEXT_MODULE_URL)});
  emit({ ok: true, context: await buildCodexDesignContext(root) });
} catch (error) {
  emit({ ok: false, error: String(error?.message ?? error).slice(0, 2000) });
}
`;

/**
 * Create a project-scoped MCP server. The returned server is not connected;
 * callers may attach stdio or another official SDK transport.
 */
export function createAxionMcpServer(options = {}) {
  const context = normalizeOptions(options);
  const server = new McpServer({
    name: 'axion-designer',
    version: PACKAGE_VERSION,
  }, {
    instructions: context.intelligenceOnly
      ? 'Axion exposes deterministic offline design intelligence. It has no project or network authority and performs no writes.'
      : [
        'Axion exposes bounded design evidence and verification for one fixed project root.',
        'No tool can accept a cwd/root override or write source, Taste Locks, baselines, or approvals.',
        'Use resources for current evidence; use verify/proof to refresh machine evidence.',
      ].join(' '),
  });

  if (!context.intelligenceOnly) registerResources(server, context);
  registerIntelligenceResources(server, context);
  if (!context.intelligenceOnly) registerTools(server, context);
  registerIntelligenceTools(server, context);
  return server;
}

/** Start the official MCP stdio transport. stdout is reserved for MCP only. */
export async function startAxionMcpStdio(options = {}) {
  const server = createAxionMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

function registerResources(server, context) {
  registerJsonResource(server, context, {
    name: 'codex_context',
    uri: 'axion://codex/context',
    title: 'Axion Codex design context',
    description: 'A compact, source-backed, read-only task context for Codex CLI and the desktop app.',
    load: async () => ({
      schema: RESOURCE_SCHEMA,
      resource: 'codex_context',
      available: true,
      data: await loadCodexContext(context),
    }),
  });

  registerJsonResource(server, context, {
    name: 'direction',
    uri: 'axion://direction',
    title: 'Axion design direction',
    description: 'The configured UI direction contract, without the mutable Taste Lock.',
    load: async () => {
      const resolved = await resolveConfigSnapshot(context);
      return artifactResource(context, 'direction', resolved.config.directionPath, resolved);
    },
  });

  registerJsonResource(server, context, {
    name: 'tokens',
    uri: 'axion://tokens',
    title: 'Axion design tokens',
    description: 'The configured design-token SSOT.',
    load: async () => {
      const resolved = await resolveConfigSnapshot(context);
      return artifactResource(context, 'tokens', resolved.config.tokensPath, resolved);
    },
  });

  registerJsonResource(server, context, {
    name: 'system_graph',
    uri: 'axion://system-graph',
    title: 'Axion system graph',
    description: 'A bounded, source-backed component, route, token, and relation graph.',
    load: async () => ({
      schema: RESOURCE_SCHEMA,
      resource: 'system_graph',
      available: true,
      data: indexRepository(context.root, graphLimits()),
    }),
  });

  registerJsonResource(server, context, {
    name: 'proof',
    uri: 'axion://proof',
    title: 'Axion proof evidence',
    description: 'Latest browser proof artifact plus bounded source-discovered proof surfaces.',
    load: async () => ({
      schema: RESOURCE_SCHEMA,
      resource: 'proof',
      available: true,
      artifact: readJsonArtifact(context, join(context.root, '.dk', 'proof', 'app-proof.json'), 'proof artifact'),
      surfaces: discoverProofSurfaces(context.root, graphLimits()),
    }),
  });

  registerJsonResource(server, context, {
    name: 'latest_report',
    uri: 'axion://report/latest',
    title: 'Latest Axion verification report',
    description: 'The latest machine-readable verification ledger at .dk/report.json.',
    load: async () => ({
      schema: RESOURCE_SCHEMA,
      resource: 'latest_report',
      ...readJsonArtifact(context, join(context.root, '.dk', 'report.json'), 'latest report'),
    }),
  });

  registerJsonResource(server, context, {
    name: 'approval_history',
    uri: 'axion://approval-history',
    title: 'Axion approval history',
    description: 'Validated, append-only direction approval history. This resource cannot approve changes.',
    load: async () => {
      const resolved = await resolveConfigSnapshot(context);
      const approvalPath = defaultApprovalHistoryPath(resolved.config.directionLockPath);
      const bounded = checkReadableArtifact(context, approvalPath, 'approval history');
      if (!bounded.available && bounded.status !== 'missing') {
        return { schema: RESOURCE_SCHEMA, resource: 'approval_history', ...bounded };
      }
      const loaded = readApprovalHistory(approvalPath);
      return {
        schema: RESOURCE_SCHEMA,
        resource: 'approval_history',
        available: !loaded.missing,
        status: loaded.missing ? 'missing' : loaded.ok ? 'valid' : 'invalid',
        path: projectRelative(context.root, approvalPath),
        ok: loaded.ok,
        missing: loaded.missing,
        headHash: loaded.headHash,
        issues: loaded.issues,
        data: loaded.history,
        config: configMetadata(resolved),
      };
    },
  });

  registerJsonResource(server, context, {
    name: 'bridge_status',
    uri: 'axion://bridge/status',
    title: 'Axion Bridge status',
    description: 'Read-only Bridge capability and connection status, with an explicit fallback when no core is installed.',
    load: async () => ({
      schema: RESOURCE_SCHEMA,
      resource: 'bridge_status',
      available: true,
      data: await bridgeStatus(context),
    }),
  });

  registerJsonResource(server, context, {
    name: 'reference_status',
    uri: 'axion://reference/status',
    title: 'Axion Reference-to-Code status',
    description: 'Validated progress for the project-bound reference manifest, decomposition, component mapping, reconstruction plan, and comparison evidence.',
    load: async () => ({
      schema: RESOURCE_SCHEMA,
      resource: 'reference_status',
      available: true,
      data: referenceStatus(context),
    }),
  });
}

function registerIntelligenceResources(server, context) {
  registerJsonResource(server, context, {
    name: 'design_intelligence',
    uri: 'axion://intelligence/catalog',
    title: 'Axion offline design intelligence',
    description: 'The bounded nine-domain relationship corpus, supported stacks, and deterministic controls. No external code or assets.',
    load: async () => ({
      schema: RESOURCE_SCHEMA,
      resource: 'design_intelligence',
      available: true,
      data: loadIntelligenceCatalog(),
    }),
  });
}

async function loadCodexContext(context) {
  const marker = `__AXION_MCP_CODEX_CONTEXT_${randomUUID()}__`;
  const execution = await runNodeProcess(context.root, [
    '--input-type=module',
    '-e',
    CODEX_CONTEXT_PROBE_SOURCE,
    context.root,
    marker,
  ], {
    timeoutMs: context.timeoutMs,
    maxStdoutBytes: MAX_CONFIG_PROBE_BYTES,
    maxStderrBytes: 64 * 1024,
  });
  if (execution.timedOut) throw new Error(`Codex context timed out after ${context.timeoutMs}ms.`);
  if (execution.outputLimitExceeded) throw new Error('Codex context exceeded its bounded subprocess output limit.');
  if (execution.spawnError) throw new Error(`Codex context could not start: ${execution.spawnError}`);
  const markerIndex = execution.stdout.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error('Codex context subprocess returned no trusted payload.');
  const encoded = execution.stdout.slice(markerIndex + marker.length).split(/\r?\n/, 1)[0].trim();
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
  catch { throw new Error('Codex context subprocess returned an invalid payload.'); }
  if (!payload?.ok || !payload.context) throw new Error(payload?.error ?? 'Codex context could not be built.');
  return payload.context;
}

function registerTools(server, context) {
  const verifyInput = z.object({
    gate: z.enum(KNOWN_GATE_IDS).optional().describe('Run one named verification gate and its dependencies.'),
    full: z.boolean().optional().default(false).describe('Include configured heavy gates.'),
    noCache: z.boolean().optional().default(true).describe('Recompute evidence instead of reusing the cache.'),
  }).strict();

  server.registerTool('verify', {
    title: 'Verify UI quality',
    description: 'Run Axion verification in the fixed project root. It may refresh .dk evidence but never edits source, locks, baselines, or approvals.',
    inputSchema: verifyInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, (input) => safeTool(context, 'verify', async () => {
    if (input.gate && input.full) throw new Error('Choose either gate or full, not both.');
    const args = ['verify', '--json'];
    if (input.gate) args.push('--gate', input.gate);
    if (input.full) args.push('--full');
    if (input.noCache !== false) args.push('--no-cache');
    return cliToolResult(context, 'verify', args);
  }));

  const proofInput = z.object({
    app: z.string().url().max(2048).optional().describe('Optional http(s) app URL. Remote hosts require server opt-in.'),
    routes: z.union([
      z.literal('auto'),
      z.array(z.string().min(1).max(512)).min(1).max(50),
    ]).optional().describe('Auto-discover routes or provide an explicit route list.'),
    noCache: z.boolean().optional().default(true),
  }).strict();

  server.registerTool('proof', {
    title: 'Run browser-backed App Proof',
    description: 'Run the configured real-app proof matrix with a hard subprocess timeout and bounded output.',
    inputSchema: proofInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, (input) => safeTool(context, 'proof', async () => {
    await assertProofNetworkPolicy(context, input.app);
    const args = ['proof', '--json'];
    if (input.app) args.push('--app', input.app);
    if (input.routes) args.push('--routes', input.routes === 'auto' ? 'auto' : input.routes.join(','));
    if (input.noCache !== false) args.push('--no-cache');
    return cliToolResult(context, 'proof', args);
  }));

  server.registerTool('system_graph', {
    title: 'Build the system graph',
    description: 'Build a fresh machine-readable system graph in a bounded subprocess.',
    inputSchema: z.object({
      includeGenerated: z.boolean().optional().default(false),
    }).strict(),
    annotations: readOnlyAnnotations(false),
  }, (input) => safeTool(context, 'system_graph', async () => {
    const args = ['system', '--json'];
    if (input.includeGenerated) args.push('--include-generated');
    return cliToolResult(context, 'system_graph', args);
  }));

  server.registerTool('explain_findings', {
    title: 'Explain verification findings',
    description: 'Explain requested rule IDs, or the unique rules in the latest report, with concrete repair guidance.',
    inputSchema: z.object({
      ruleIds: z.array(z.string().min(3).max(160)).max(25).optional(),
      limit: z.number().int().min(1).max(25).optional().default(12),
    }).strict(),
    annotations: readOnlyAnnotations(false),
  }, (input) => safeTool(context, 'explain_findings', async () => {
    const report = readJsonArtifact(context, join(context.root, '.dk', 'report.json'), 'latest report');
    const findings = Array.isArray(report.data?.findings) ? report.data.findings : [];
    const requested = input.ruleIds?.length
      ? input.ruleIds
      : findings.map((finding) => finding?.ruleId).filter(Boolean);
    const ruleIds = [...new Set(requested)].slice(0, input.limit ?? 12);
    const byRule = new Map();
    for (const finding of findings) if (finding?.ruleId && !byRule.has(finding.ruleId)) byRule.set(finding.ruleId, finding);
    return {
      schema: TOOL_SCHEMA,
      tool: 'explain_findings',
      status: ruleIds.length ? 'ok' : report.available ? 'no-findings' : 'report-missing',
      report: { available: report.available, status: report.status, path: report.path },
      explanations: ruleIds.map((ruleId) => explainRule(ruleId, byRule.get(ruleId))),
    };
  }));

  server.registerTool('bridge_status', {
    title: 'Inspect Bridge status',
    description: 'Read Bridge capability and sanitized connection status. No synchronization is performed.',
    inputSchema: z.object({}).strict(),
    annotations: readOnlyAnnotations(true),
  }, () => safeTool(context, 'bridge_status', async () => ({
    schema: TOOL_SCHEMA,
    tool: 'bridge_status',
    status: 'ok',
    bridge: await bridgeStatus(context),
  })));

  server.registerTool('bridge_sync', {
    title: 'Plan a Bridge sync',
    description: 'Preflight a built-in Bridge sync without network calls or writes. Executable custom adapters require explicit CLI review.',
    inputSchema: z.object({
      dryRun: z.literal(true).optional().default(true),
    }).strict(),
    annotations: readOnlyAnnotations(true),
  }, () => safeTool(context, 'bridge_sync', async () => bridgeSyncDryRun(context)));

  server.registerTool('reference_status', {
    title: 'Inspect Reference-to-Code evidence',
    description: 'Validate the five-stage reference evidence chain and content-addressed image assets in the fixed project root.',
    inputSchema: z.object({}).strict(),
    annotations: readOnlyAnnotations(false),
  }, () => safeTool(context, 'reference_status', async () => ({
    schema: TOOL_SCHEMA,
    tool: 'reference_status',
    status: 'ok',
    data: referenceStatus(context),
  })));

  server.registerTool('reference_compare', {
    title: 'Compare a candidate image with a registered reference',
    description: 'Write bounded comparison evidence under .dk/reference. Only the original screenshot path from a current, complete, ledger-attested App Proof case can reach match/complete; other project-local images remain advisory review evidence.',
    inputSchema: z.object({
      referenceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
      candidate: z.string().min(1).max(1024).describe('Project-relative PNG, JPEG, or WebP candidate. Use the deterministic App Proof screenshot path for capture attestation.'),
      implementationFiles: z.array(z.string().min(1).max(1024)).min(1).max(200)
        .describe('Every implementation file declared by the validated reconstruction plan.'),
      regionFindings: z.array(z.object({
        id: z.string().min(1).max(128),
        regionId: z.string().min(1).max(128).nullable().optional(),
        type: z.string().min(1).max(128),
        severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
        score: z.number().min(0).max(1),
        summary: z.string().min(1).max(2000),
        evidence: z.array(z.string().min(1).max(1000)).max(20).optional().default([]),
      }).strict()).max(100).optional().default([]),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, (input) => safeTool(context, 'reference_compare', async () => {
    const result = createReferenceSystem(context.root).compareReference({
      referenceId: input.referenceId,
      candidatePath: input.candidate,
      implementationFiles: input.implementationFiles,
      regionFindings: input.regionFindings,
    });
    return {
      schema: TOOL_SCHEMA,
      tool: 'reference_compare',
      status: result.artifact.status,
      data: result.artifact,
      artifact: { path: result.path, sha256: result.sha256, bytes: result.bytes },
    };
  }));
}

function referenceStatus(context) {
  return createReferenceSystem(context.root).inspectStatus();
}

function registerIntelligenceTools(server, context) {
  server.registerTool('design_recommend', {
    title: 'Recommend three UI directions',
    description: 'Normalize a Chinese or English product brief and return three materially distinct, stack-aware recipes from Axion\'s offline corpus. Under-specified briefs fail closed with clarification needs.',
    inputSchema: z.object({
      brief: z.string().min(1).max(4000),
      stack: z.enum(INTELLIGENCE_STACKS).optional().default('react'),
      density: z.enum(['compact', 'balanced', 'airy']).optional().default('balanced'),
      motion: z.enum(['none', 'subtle', 'expressive']).optional().default('subtle'),
      contrast: z.enum(['standard', 'high']).optional().default('standard'),
      variance: z.number().min(0).max(100).optional().default(55),
    }).strict(),
    annotations: readOnlyAnnotations(false),
  }, (input) => safeTool(context, 'design_recommend', async () => {
    const { brief, ...options } = input;
    return {
      schema: TOOL_SCHEMA,
      tool: 'design_recommend',
      status: 'ok',
      data: recommendDesignDirections(brief, options),
    };
  }));
}

function registerJsonResource(server, context, definition) {
  server.registerResource(definition.name, definition.uri, {
    title: definition.title,
    description: definition.description,
    mimeType: JSON_MIME,
    annotations: { audience: ['user', 'assistant'], priority: 0.8 },
  }, async (uri) => {
    let payload;
    try {
      payload = await definition.load();
    } catch (error) {
      payload = {
        schema: RESOURCE_SCHEMA,
        resource: definition.name,
        available: false,
        status: 'error',
        error: errorMessage(error),
      };
    }
    return {
      contents: [{
        uri: uri.href,
        mimeType: JSON_MIME,
        text: serializeBounded(payload, context.maxResourceBytes),
      }],
    };
  });
}

async function safeTool(context, name, callback) {
  try {
    const payload = await callback();
    if (payload?.content) return payload;
    return toolContent(context, payload, false);
  } catch (error) {
    return toolContent(context, {
      schema: TOOL_SCHEMA,
      tool: name,
      status: 'error',
      error: errorMessage(error),
    }, true);
  }
}

function toolContent(context, payload, isError) {
  return {
    content: [{ type: 'text', text: serializeBounded(payload, context.maxToolBytes) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function cliToolResult(context, tool, args) {
  const execution = await runNodeProcess(context.root, [CLI_PATH, ...args], {
    timeoutMs: context.timeoutMs,
    maxStdoutBytes: Math.max(8 * 1024, context.maxToolBytes - 64 * 1024),
    maxStderrBytes: Math.min(128 * 1024, Math.max(8 * 1024, Math.floor(context.maxToolBytes / 8))),
  });
  let data = null;
  let raw = null;
  if (execution.stdout.trim()) {
    try { data = JSON.parse(execution.stdout); }
    catch { raw = execution.stdout; }
  }
  const infrastructureError = execution.timedOut
    || execution.outputLimitExceeded
    || !!execution.spawnError
    || execution.exitCode == null
    || execution.exitCode === 2;
  const status = execution.timedOut ? 'timeout'
    : execution.outputLimitExceeded ? 'output-limit'
      : execution.spawnError ? 'spawn-error'
        : execution.exitCode === 0 ? 'passed'
          : execution.exitCode === 1 ? 'findings'
            : 'error';
  const payload = {
    schema: TOOL_SCHEMA,
    tool,
    status,
    exitCode: execution.exitCode,
    durationMs: execution.durationMs,
    ...(data != null ? { data } : {}),
    ...(raw != null ? { output: raw } : {}),
    ...(execution.stderr.trim() ? { diagnostics: execution.stderr } : {}),
    ...(execution.timedOut ? { timeoutMs: context.timeoutMs } : {}),
    ...(execution.outputLimitExceeded ? { outputLimitBytes: context.maxToolBytes } : {}),
    ...(execution.spawnError ? { error: execution.spawnError } : {}),
  };
  return toolContent(context, payload, infrastructureError);
}

async function resolveConfigSnapshot(context) {
  const marker = `__AXION_MCP_CONFIG_${randomUUID()}__`;
  const execution = await runNodeProcess(context.root, [
    '--input-type=module',
    '--eval',
    CONFIG_PROBE_SOURCE,
    context.root,
    marker,
  ], {
    timeoutMs: Math.min(context.timeoutMs, 15_000),
    maxStdoutBytes: MAX_CONFIG_PROBE_BYTES,
    maxStderrBytes: 64 * 1024,
  });
  const fallback = defaultConfigSnapshot(context.root);
  if (execution.timedOut || execution.outputLimitExceeded || execution.spawnError) {
    return {
      ok: false,
      status: execution.timedOut ? 'timeout' : execution.outputLimitExceeded ? 'output-limit' : 'spawn-error',
      error: execution.spawnError ?? execution.stderr.trim() ?? 'Config probe failed.',
      config: fallback,
    };
  }
  const encoded = execution.stdout.split('\n')
    .filter((line) => line.startsWith(marker))
    .at(-1)?.slice(marker.length);
  if (!encoded) {
    return { ok: false, status: 'invalid-output', error: 'Config probe returned no trusted result.', config: fallback };
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (parsed.status === 'config-error') {
      const config = parsed.config ? normalizeConfigSnapshot(context, parsed.config) : fallback;
      const issues = Array.isArray(parsed.issues) ? parsed.issues.slice(0, 50).map((issue) => ({
        code: 'config-error',
        path: typeof issue?.path === 'string' ? issue.path.slice(0, 500) : 'dk.config',
        message: String(issue?.message ?? 'Invalid project configuration.').slice(0, 2000),
        ...(issue?.fix ? { fix: String(issue.fix).slice(0, 2000) } : {}),
      })) : [];
      return {
        ok: false,
        status: 'config-error',
        error: String(parsed.error ?? 'Project configuration is invalid.').slice(0, 2000),
        issues,
        config,
      };
    }
    if (!parsed.ok || !parsed.config) {
      return { ok: false, status: 'config-error', error: parsed.error ?? 'Config could not be loaded.', config: fallback };
    }
    return { ok: true, status: 'resolved', config: normalizeConfigSnapshot(context, parsed.config) };
  } catch (error) {
    return { ok: false, status: 'invalid-output', error: errorMessage(error), config: fallback };
  }
}

function normalizeConfigSnapshot(context, config) {
  const fallback = defaultConfigSnapshot(context.root);
  return {
    presetName: typeof config.presetName === 'string' ? config.presetName : fallback.presetName,
    configFile: typeof config.configFile === 'string' ? config.configFile : null,
    tokensPath: normalizeCandidatePath(context, config.tokensPath, fallback.tokensPath),
    directionPath: normalizeCandidatePath(context, config.directionPath, fallback.directionPath),
    directionLockPath: normalizeCandidatePath(context, config.directionLockPath, fallback.directionLockPath),
    proof: config.proof && typeof config.proof.baseUrl === 'string' ? { baseUrl: config.proof.baseUrl } : null,
    bridge: {
      enabled: config.bridge?.enabled === true,
      artifactDir: normalizeCandidatePath(context, config.bridge?.artifactDir, fallback.bridge.artifactDir),
      timeoutMs: finiteInteger(config.bridge?.timeoutMs, null),
      freshnessMs: finiteInteger(config.bridge?.freshnessMs, null),
      connections: Array.isArray(config.bridge?.connections) ? config.bridge.connections.slice(0, 100) : [],
    },
  };
}

function defaultConfigSnapshot(root) {
  return {
    presetName: 'recommended',
    configFile: null,
    tokensPath: join(root, 'design', 'tokens.json'),
    directionPath: join(root, 'design', 'direction.json'),
    directionLockPath: join(root, 'design', 'direction.lock.json'),
    proof: null,
    bridge: {
      enabled: false,
      artifactDir: join(root, '.dk', 'bridge'),
      timeoutMs: null,
      freshnessMs: null,
      connections: [],
    },
  };
}

function normalizeCandidatePath(context, candidate, fallback) {
  if (typeof candidate !== 'string' || !candidate) return fallback;
  const absolute = isAbsolute(candidate) ? resolvePath(candidate) : resolvePath(context.root, candidate);
  assertInsideRoot(context.root, absolute);
  return absolute;
}

function artifactResource(context, kind, path, config) {
  return {
    schema: RESOURCE_SCHEMA,
    resource: kind,
    ...readJsonArtifact(context, path, kind),
    config: configMetadata(config),
  };
}

function readJsonArtifact(context, path, label) {
  const checked = checkReadableArtifact(context, path, label);
  if (!checked.available) return checked;
  try {
    return {
      available: true,
      status: 'ok',
      path: checked.path,
      bytes: checked.bytes,
      data: JSON.parse(readFileSync(checked.absolute, 'utf8')),
    };
  } catch (error) {
    return {
      available: false,
      status: 'invalid-json',
      path: checked.path,
      bytes: checked.bytes,
      error: `${label}: ${errorMessage(error)}`,
    };
  }
}

function checkReadableArtifact(context, path, label) {
  let absolute;
  try {
    absolute = resolvePath(path);
    assertInsideRoot(context.root, absolute);
  } catch (error) {
    return { available: false, status: 'outside-root', path: null, error: `${label}: ${errorMessage(error)}` };
  }
  const display = projectRelative(context.root, absolute);
  if (!existsSync(absolute)) return { available: false, status: 'missing', path: display };
  try {
    const canonical = realpathSync(absolute);
    assertInsideRoot(context.root, canonical);
    const stat = statSync(canonical);
    if (!stat.isFile()) return { available: false, status: 'not-file', path: display };
    if (stat.size > context.maxResourceBytes) {
      return {
        available: false,
        status: 'too-large',
        path: display,
        bytes: stat.size,
        limitBytes: context.maxResourceBytes,
      };
    }
    return { available: true, status: 'ok', path: display, absolute: canonical, bytes: stat.size };
  } catch (error) {
    return { available: false, status: 'read-error', path: display, error: `${label}: ${errorMessage(error)}` };
  }
}

async function assertProofNetworkPolicy(context, explicitApp) {
  let candidate = explicitApp ?? null;
  if (!candidate) {
    const resolved = await resolveConfigSnapshot(context);
    candidate = resolved.config.proof?.baseUrl ?? null;
    if (!resolved.ok && !context.allowRemoteProof) {
      throw new Error('Proof config could not be safely resolved. Pass an explicit loopback app URL or start dk-mcp with --allow-remote-proof.');
    }
  }
  if (!candidate) return;
  let url;
  try { url = new URL(candidate); }
  catch { throw new Error('Proof app must be a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Proof app must use http or https.');
  if (url.username || url.password) throw new Error('Proof app URLs cannot contain credentials.');
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|api[-_]?key|authorization/i.test(key)) {
      throw new Error('Proof app URLs cannot carry credentials in query parameters.');
    }
  }
  if (!context.allowRemoteProof && !isLoopbackHost(url.hostname)) {
    throw new Error('Remote App Proof is disabled. Use a loopback URL or start dk-mcp with --allow-remote-proof.');
  }
}

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return !!match && match.slice(1).every((part) => Number(part) <= 255);
}

function explainRule(ruleId, finding) {
  const rule = getRule(ruleId);
  if (!rule) {
    return {
      ruleId,
      registered: false,
      severity: finding?.severity ?? null,
      message: finding?.message ?? 'No registered teaching card is available for this rule.',
      fix: finding?.fix ?? null,
      evidence: finding?.evidence ?? null,
    };
  }
  return {
    ruleId,
    registered: true,
    title: ruleTitle(rule),
    category: rule.category,
    zone: rule.zone ?? null,
    severity: finding?.severity ?? rule.severity,
    why: ruleWhy(rule),
    fix: finding?.fix ?? ruleFix(rule),
    finding: finding ? {
      file: finding.file ?? null,
      line: finding.line ?? null,
      message: finding.message ?? null,
      evidence: finding.evidence ?? null,
    } : null,
  };
}

let bridgeCorePromise;
async function loadBridgeCore() {
  if (!bridgeCorePromise) {
    bridgeCorePromise = (async () => {
      for (const url of BRIDGE_MODULE_URLS) {
        if (!existsSync(fileURLToPath(url))) continue;
        try { return { available: true, module: await import(url.href), moduleUrl: url.href }; }
        catch (error) { return { available: false, reason: 'load-failed', error: errorMessage(error) }; }
      }
      return { available: false, reason: 'core-not-installed' };
    })();
  }
  return bridgeCorePromise;
}

async function bridgeStatus(context) {
  const [core, resolved] = await Promise.all([loadBridgeCore(), resolveConfigSnapshot(context)]);
  const base = {
    schema: 'axion-bridge-status/v1',
    available: core.available,
    configured: resolved.config.bridge.enabled,
    configStatus: resolved.status,
    connections: resolved.config.bridge.connections,
    ...(core.reason ? { reason: core.reason } : {}),
    ...(core.error ? { error: core.error } : {}),
  };
  if (resolved.status === 'config-error') return bridgeConfigErrorSurface(base, resolved);
  if (!core.available) return base;
  // Execute through the CLI in a bounded child: project config is executable
  // JavaScript and may print to stdout, which must never corrupt MCP framing.
  const cli = await runBridgeJson(context, ['bridge', 'status', '--json']);
  if (cli.exitCode === 2) {
    return bridgeConfigErrorSurface(base, {
      ...resolved,
      status: 'config-error',
      error: 'Bridge CLI rejected the project configuration.',
    });
  }
  if (cli.data) {
    const ledgerReason = cli.data.ledger?.missing ? 'not-synced'
      : cli.data.ledger?.ok === true ? 'ledger-valid'
        : cli.data.ledger?.ok === false ? 'ledger-invalid' : 'status-failed';
    return {
      ...base,
      reason: ledgerReason,
      policyStatus: cli.data.status ?? null,
      status: cli.data,
    };
  }
  // Never downgrade to a raw-ledger read when policy evaluation failed. A
  // syntactically valid ledger is not proof that current trust, freshness,
  // repository, commit, and contract policies passed.
  return {
    ...base,
    reason: cli.reason ?? 'status-failed',
    policyStatus: 'failed',
    error: 'Bridge policy status could not be obtained from trusted JSON output.',
  };
}

function bridgeConfigErrorSurface(base, resolved) {
  const issues = Array.isArray(resolved.issues) ? resolved.issues : [];
  const connections = (base.connections ?? []).map((connection) => ({
    ...connection,
    status: 'config-error',
    issues,
  }));
  const requiredFailed = connections.filter((connection) => connection.required === true).length;
  return {
    ...base,
    configStatus: 'config-error',
    reason: 'config-error',
    policyStatus: 'config-error',
    configIssues: issues,
    error: resolved.error ?? 'Project configuration is invalid.',
    connections,
    status: {
      schema: 'axion-bridge-status/v1',
      status: 'config-error',
      ledger: null,
      summary: {
        total: connections.length,
        healthy: 0,
        failed: connections.length,
        incomplete: 0,
        requiredFailed,
      },
      connections,
      issues,
    },
  };
}

async function bridgeSyncDryRun(context) {
  const core = await loadBridgeCore();
  if (!core.available) {
    return {
      schema: TOOL_SCHEMA,
      tool: 'bridge_sync',
      status: 'unavailable',
      dryRun: true,
      changed: false,
      reason: core.reason,
      ...(core.error ? { error: core.error } : {}),
    };
  }
  const resolved = await resolveConfigSnapshot(context);
  if (resolved.status === 'config-error') {
    return {
      schema: TOOL_SCHEMA,
      tool: 'bridge_sync',
      status: 'config-error',
      dryRun: true,
      changed: false,
      reason: 'config-error',
      error: resolved.error ?? 'Project configuration is invalid.',
      issues: resolved.issues ?? [],
    };
  }
  const customConnections = resolved.config.bridge.connections
    .filter((connection) => connection.enabled !== false && connection.customModule === true)
    .map((connection) => connection.id);
  if (customConnections.length) {
    return {
      schema: TOOL_SCHEMA,
      tool: 'bridge_sync',
      status: 'manual-review-required',
      dryRun: true,
      changed: false,
      reason: 'custom-adapter-executable',
      connections: customConnections,
      guidance: 'Review repository-local custom adapter code, then run `dk bridge doctor` explicitly. MCP will not import executable adapters during a read-only preflight.',
    };
  }
  // `bridge doctor` is the explicit no-network/no-write preflight surface.
  // Running it in a child also quarantines arbitrary project config output.
  const execution = await runBridgeJson(context, ['bridge', 'doctor', '--json']);
  const doctorStatus = execution.data?.status ?? null;
  const status = !execution.data ? 'unavailable'
    : execution.exitCode !== 0 || doctorStatus === 'failed' ? 'preflight-failed'
      : doctorStatus === 'incomplete' ? 'planned-with-warnings' : 'planned';
  return {
    schema: TOOL_SCHEMA,
    tool: 'bridge_sync',
    status,
    dryRun: true,
    changed: false,
    ...(execution.data
      ? { plan: execution.data, ...(status === 'preflight-failed' ? { reason: 'doctor-failed' } : {}) }
      : { reason: execution.reason ?? 'dry-run-failed' }),
  };
}

async function runBridgeJson(context, args) {
  const execution = await runNodeProcess(context.root, [CLI_PATH, ...args], {
    timeoutMs: Math.min(context.timeoutMs, 30_000),
    maxStdoutBytes: Math.max(8 * 1024, context.maxToolBytes - 64 * 1024),
    maxStderrBytes: 64 * 1024,
  });
  let data = null;
  if (execution.stdout.trim()) {
    try { data = JSON.parse(execution.stdout); } catch { /* untrusted config output */ }
  }
  return {
    data,
    exitCode: execution.exitCode,
    reason: execution.timedOut ? 'timeout'
      : execution.outputLimitExceeded ? 'output-limit'
        : execution.spawnError ? 'spawn-error'
          : data ? null : 'invalid-output',
  };
}

function runNodeProcess(root, args, limits) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError = null;
    let settled = false;
    const detached = process.platform !== 'win32';
    const child = spawn(process.execPath, args, {
      cwd: root,
      detached,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const kill = () => {
      if (!child.pid) return;
      try {
        if (detached) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }
    };

    const collect = (bucket, chunk, current, max) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, max - current);
      if (remaining) bucket.push(buffer.subarray(0, remaining));
      if (buffer.length > remaining) {
        outputLimitExceeded = true;
        kill();
      }
      return current + Math.min(buffer.length, remaining);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes, limits.maxStdoutBytes);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes, limits.maxStderrBytes);
    });
    child.once('error', (error) => { spawnError = errorMessage(error); });

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, limits.timeoutMs);

    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdoutBytes,
        stderrBytes,
        timedOut,
        outputLimitExceeded,
        spawnError,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function normalizeOptions(options) {
  const root = canonicalDirectory(options.root ?? process.cwd());
  return {
    root,
    timeoutMs: boundedInteger(options.timeoutMs, AXION_MCP_TIMEOUT_MS, 1, 10 * 60_000, 'timeoutMs'),
    maxResourceBytes: boundedInteger(options.maxResourceBytes, AXION_MCP_RESOURCE_LIMIT, 4 * 1024, 8 * 1024 * 1024, 'maxResourceBytes'),
    maxToolBytes: boundedInteger(options.maxToolBytes, AXION_MCP_TOOL_LIMIT, 8 * 1024, 16 * 1024 * 1024, 'maxToolBytes'),
    allowRemoteProof: options.allowRemoteProof === true,
    intelligenceOnly: options.intelligenceOnly === true,
  };
}

function canonicalDirectory(input) {
  const target = resolvePath(String(input));
  const stat = statSync(target);
  if (!stat.isDirectory()) throw new Error(`Project root is not a directory: ${target}`);
  return realpathSync(target);
}

function assertInsideRoot(root, candidate) {
  const rel = relative(root, resolvePath(candidate));
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return;
  throw new Error('Path escapes the fixed MCP project root.');
}

function projectRelative(root, target) {
  assertInsideRoot(root, target);
  return relative(root, target).split(sep).join('/') || '.';
}

function graphLimits() {
  return {
    maxFiles: 2000,
    maxBytes: 512 * 1024,
    maxTotalBytes: 24 * 1024 * 1024,
  };
}

function configMetadata(resolved) {
  return {
    status: resolved.status,
    preset: resolved.config.presetName,
    file: resolved.config.configFile,
    ...(resolved.error ? { error: String(resolved.error).slice(0, 1000) } : {}),
  };
}

function readOnlyAnnotations(openWorldHint) {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint,
  };
}

function serializeBounded(value, maxBytes) {
  const text = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return text;
  const fallback = {
    schema: 'axion-mcp-truncated/v1',
    truncated: true,
    originalBytes: bytes,
    limitBytes: maxBytes,
    sha256: createHash('sha256').update(text).digest('hex'),
    summary: summarizeValue(value),
  };
  const fallbackText = JSON.stringify(fallback, null, 2);
  if (Buffer.byteLength(fallbackText) <= maxBytes) return fallbackText;
  // User-controlled object keys can make even a summary unexpectedly large.
  // The minimal envelope is fixed-size, so the cap remains an invariant.
  return JSON.stringify({
    schema: fallback.schema,
    truncated: true,
    originalBytes: bytes,
    limitBytes: maxBytes,
    sha256: fallback.sha256,
  });
}

function summarizeValue(value) {
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (!value || typeof value !== 'object') return { type: typeof value, value: String(value).slice(0, 500) };
  const summary = { type: 'object', keys: Object.keys(value).slice(0, 40).map((key) => key.slice(0, 120)) };
  for (const key of ['schema', 'resource', 'tool', 'status', 'available', 'generatedAt', 'stats', 'counts']) {
    if (value[key] == null) continue;
    const candidate = value[key];
    if (candidate && typeof candidate === 'object') {
      const encoded = JSON.stringify(candidate);
      summary[key] = encoded.length <= 4000
        ? candidate
        : { truncated: true, bytes: Buffer.byteLength(encoded), type: Array.isArray(candidate) ? 'array' : 'object' };
    } else {
      summary[key] = candidate;
    }
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (Array.isArray(candidate)) summary[`${key}Count`] = candidate.length;
  }
  return summary;
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function boundedInteger(value, fallback, min, max, label) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function finiteInteger(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

function errorMessage(error) {
  return String(error?.message ?? error ?? 'Unknown error').slice(0, 4000);
}

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}
