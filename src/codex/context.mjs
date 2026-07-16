/* Compact, source-backed context for Codex design tasks. No project JavaScript
   is executed unless the caller explicitly opts into trusted config loading. */
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { findConfigFile, loadConfig } from '../core/config.mjs';
import {
  hashDirection,
  hashDirectionBindings,
  validateDirection,
  validateDirectionLock,
} from '../core/direction.mjs';
import { defaultApprovalHistoryPath, validateApprovalHistory } from '../core/approvals.mjs';
import { buildManifest, resolve as resolveToken } from '../core/tokens.mjs';
import {
  collectFileStats,
  configEvidenceHash,
  sourceEvidenceFingerprint,
} from '../core/ledger.mjs';
import { indexRepository } from '../system/indexer.mjs';
import { createReferenceSystem } from '../reference/index.mjs';
import { CodexIntegrationError, inspectCodexIntegration } from './integration.mjs';

export const CODEX_CONTEXT_SCHEMA = 'axion-codex-context/v1';
export const CODEX_CONTEXT_MAX_BYTES = 12 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

function isInside(root, target) {
  const value = relative(resolvePath(root), resolvePath(target));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function projectPath(root, path) {
  if (!path || !isInside(root, path)) return null;
  return relative(root, path).split(sep).join('/') || '.';
}

function readProjectJson(root, path, maxBytes = MAX_JSON_BYTES) {
  const absolute = resolvePath(path);
  const displayPath = projectPath(root, absolute);
  if (!displayPath) return { status: 'unsafe', path: null, value: null, issue: 'path escapes the repository' };
  let stat;
  try { stat = lstatSync(absolute); }
  catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', path: displayPath, value: null, issue: null };
    return { status: 'invalid', path: displayPath, value: null, issue: error?.message ?? String(error) };
  }
  if (stat.isSymbolicLink()) return { status: 'unsafe', path: displayPath, value: null, issue: 'symbolic-link JSON artifacts are not trusted' };
  if (!stat.isFile()) return { status: 'invalid', path: displayPath, value: null, issue: 'artifact is not a regular file' };
  if (stat.size > maxBytes) return { status: 'too-large', path: displayPath, value: null, issue: `artifact exceeds ${maxBytes} bytes` };
  try {
    const canonicalRoot = realpathSync(root);
    const canonical = realpathSync(absolute);
    if (!isInside(canonicalRoot, canonical)) return { status: 'unsafe', path: displayPath, value: null, issue: 'canonical path escapes the repository' };
    return { status: 'ready', path: displayPath, value: JSON.parse(readFileSync(canonical, 'utf8')), issue: null };
  } catch (error) {
    return { status: 'invalid', path: displayPath, value: null, issue: error?.message ?? String(error) };
  }
}

function defaultContextConfig(root, configFile = null) {
  return {
    cwd: root,
    configFile,
    presetName: 'recommended',
    tokensPath: join(root, 'design', 'tokens.json'),
    directionPath: join(root, 'design', 'direction.json'),
    directionLockPath: join(root, 'design', 'direction.lock.json'),
    directionRequired: false,
    targets: ['**/*.{html,css,scss,less,js,jsx,ts,tsx,vue,svelte,astro}'],
    ignore: ['**/node_modules/**', '**/.dk/**', '**/dist/**', '**/build/**', '**/.git/**', '**/fixtures/**', 'dk-report.html'],
    failOn: 'error',
    failOnSkipped: false,
    requiredTokens: [],
    contrast: { algorithm: 'wcag', modes: ['light', 'dark'], pairs: [] },
    enforce: { spacing: 'off', radius: 'off', type: 'off' },
    slopRules: [],
    fonts: { allow: [], deny: [] },
    severity: {},
    allowlist: {},
    baselinePath: join(root, '.dk', 'baseline.json'),
    gates: {},
    proof: null,
    bridge: {
      enabled: false,
      sourcePath: join(root, 'design', 'bridge.json'),
      connections: [],
    },
    errors: [],
  };
}

async function resolveContextConfig(root, options) {
  const file = findConfigFile(root);
  const display = file ? projectPath(root, file) : null;
  const executable = Boolean(file && !file.endsWith('.json'));
  if (executable && options.trustProjectConfig !== true) {
    return {
      config: defaultContextConfig(root, display),
      surface: {
        status: 'requires-trust',
        file: display,
        executable: true,
        trusted: false,
        errors: ['Executable project config was not loaded. Re-run with --trust-project-config only after trusting this repository.'],
      },
    };
  }
  try {
    const config = await loadConfig(root);
    const errors = (config.errors ?? []).map((error) => error?.message ?? String(error)).slice(0, 8);
    return {
      config,
      surface: {
        status: errors.length ? 'invalid' : executable ? 'trusted-executable' : file ? 'trusted-static' : 'defaults',
        file: config.configFile ? projectPath(root, config.configFile) : display,
        executable,
        trusted: true,
        errors,
      },
    };
  } catch (error) {
    return {
      config: defaultContextConfig(root, display),
      surface: {
        status: 'invalid',
        file: display,
        executable,
        trusted: false,
        errors: [error?.message ?? String(error)],
      },
    };
  }
}

function compactDirection(root, config) {
  const directionRead = readProjectJson(root, config.directionPath);
  const lockRead = readProjectJson(root, config.directionLockPath);
  const historyPath = defaultApprovalHistoryPath(config.directionLockPath);
  const historyRead = readProjectJson(root, historyPath);
  const tokenRead = readProjectJson(root, config.tokensPath, 8 * 1024 * 1024);
  const doc = directionRead.value;
  const lock = lockRead.value;
  let manifest = null;
  let tokenIssue = tokenRead.issue;
  if (tokenRead.status === 'ready') {
    try { manifest = buildManifest(tokenRead.value); }
    catch (error) { tokenIssue = error?.message ?? String(error); }
  }
  const resolver = manifest ? (path, mode) => resolveToken(tokenRead.value, path, mode) : undefined;
  const issues = doc ? validateDirection(doc, { resolveToken: resolver }) : [];
  if (doc && !manifest) issues.push({
    code: 'token-binding', severity: 'error', path: 'bindings',
    message: `Token bindings cannot be resolved: ${tokenIssue ?? tokenRead.status}.`,
  });

  const lockValid = lockRead.status === 'ready' && validateDirectionLock(lock);
  const directionHash = doc ? hashDirection(doc) : null;
  const bindingHash = doc && manifest ? hashDirectionBindings(doc, resolver) : null;
  const directionMatches = Boolean(lockValid && directionHash && lock.directionHash === directionHash);
  const bindingsMatch = bindingHash == null ? null : Boolean(lockValid && lock.bindingHash === bindingHash);

  let approvalStatus = historyRead.status === 'missing' ? 'absent' : historyRead.status === 'ready' ? 'invalid' : historyRead.status;
  let approvalCount = 0;
  let approvalHeadHash = null;
  let latest = null;
  if (historyRead.status === 'ready') {
    const verified = validateApprovalHistory(historyRead.value);
    approvalCount = Array.isArray(historyRead.value?.entries) ? historyRead.value.entries.length : 0;
    approvalHeadHash = verified.headHash;
    latest = historyRead.value?.entries?.at(-1) ?? null;
    if (!verified.ok) approvalStatus = 'invalid';
    else if (!latest) approvalStatus = 'absent';
    else {
      const matchesLock = lockValid
        && latest.directionHash === lock.directionHash
        && latest.bindingHash === lock.bindingHash
        && typeof lock.approvalHeadHash === 'string'
        && lock.approvalHeadHash === verified.headHash;
      approvalStatus = matchesLock ? 'verified' : 'stale';
    }
  }

  let lockStatus = lockRead.status === 'missing' ? 'absent' : lockValid ? 'unresolved' : 'invalid';
  if (lockValid && directionHash && bindingHash) {
    if (!directionMatches || bindingsMatch === false) lockStatus = 'drifted';
    else if (approvalStatus !== 'verified') lockStatus = 'unapproved';
    else lockStatus = 'matched';
  }

  return {
    status: directionRead.status === 'missing' ? 'absent'
      : directionRead.status !== 'ready' || issues.some((issue) => issue.severity === 'error') ? 'invalid'
        : doc.status,
    path: directionRead.path,
    name: doc?.name ?? null,
    context: doc ? {
      register: doc.context?.register ?? null,
      product: doc.context?.product ?? null,
      audience: Array.isArray(doc.context?.audience) ? doc.context.audience.slice(0, 3) : [],
      task: doc.context?.task ?? null,
      action: doc.context?.action ?? null,
      constraints: Array.isArray(doc.context?.constraints) ? doc.context.constraints.slice(0, 4) : [],
    } : null,
    identity: doc ? {
      thesis: doc.identity?.thesis ?? null,
      qualities: Array.isArray(doc.identity?.qualities) ? doc.identity.qualities.slice(0, 5) : [],
      signature: doc.identity?.signature ?? null,
      composition: doc.identity?.composition ?? null,
      responsive: doc.identity?.responsive ?? null,
      avoid: Array.isArray(doc.identity?.avoid) ? doc.identity.avoid.slice(0, 5) : [],
    } : null,
    bindings: doc?.bindings ? Object.fromEntries(Object.entries(doc.bindings).slice(0, 12)) : {},
    current: {
      directionHash,
      bindingHash,
      tokenHash: manifest?.tokenHash ?? null,
    },
    tokens: {
      path: tokenRead.path,
      status: manifest ? 'ready' : tokenRead.status === 'ready' ? 'invalid' : tokenRead.status,
      tokenHash: manifest?.tokenHash ?? null,
      issue: manifest ? null : tokenIssue,
    },
    issues: issues.slice(0, 8).map(({ code, severity, path, message }) => ({ code, severity, path, message })),
    lock: {
      path: lockRead.path,
      status: lockStatus,
      directionHash: lock?.directionHash ?? null,
      bindingHash: lock?.bindingHash ?? null,
      approvalHeadHash: lock?.approvalHeadHash ?? null,
      currentDirectionHash: directionHash,
      currentBindingHash: bindingHash,
      directionMatches,
      bindingsMatch,
      issue: lockRead.issue,
    },
    approvals: {
      path: historyRead.path,
      status: approvalStatus,
      count: approvalCount,
      headHash: approvalHeadHash,
      issue: historyRead.issue,
    },
  };
}

function currentSourceEvidence(root, config, configuration) {
  if (!configuration.trusted || configuration.status === 'invalid') {
    return { status: 'unavailable', fingerprint: null, files: 0, reason: 'project configuration is not trusted and valid' };
  }
  try {
    const files = collectFileStats(root, config.targets, config.ignore);
    return { status: 'ready', fingerprint: sourceEvidenceFingerprint(files), files: files.length, reason: null };
  } catch (error) {
    return { status: 'invalid', fingerprint: null, files: 0, reason: error?.message ?? String(error) };
  }
}

function compactReport(root, direction, config, configuration, sources, integration) {
  const loaded = readProjectJson(root, join(root, '.dk', 'report.json'), 8 * 1024 * 1024);
  if (loaded.status === 'missing') {
    return { status: 'missing', recordedStatus: null, counts: null, gates: [], configErrors: [], freshness: { status: 'missing', reasons: [] } };
  }
  if (loaded.status !== 'ready' || loaded.value?.version !== 2) {
    return {
      status: 'invalid', recordedStatus: null, counts: null, gates: [], configErrors: [],
      freshness: { status: 'invalid', reasons: [loaded.issue ?? 'report schema is invalid'] },
    };
  }
  const report = loaded.value;
  const historical = [];
  const stale = [];
  if (!configuration.trusted || configuration.status === 'invalid') historical.push('current project configuration was not loaded as trusted data');
  if (report.partial === true || report.scope?.files != null) historical.push('the latest report covers only a partial source scope');
  if (!report.runtimeVersion || !report.configHash || !report.sourceFingerprint) {
    historical.push('report predates source-bound Codex evidence; rerun dk verify with this Axion version');
  }
  if (integration.runtime.status !== 'ready') historical.push('matching project-local Axion runtime is unavailable');
  else if (report.runtimeVersion && report.runtimeVersion !== integration.runtime.version) stale.push('Axion runtime version changed');
  if (configuration.trusted && configuration.status !== 'invalid' && report.configHash
      && report.configHash !== configEvidenceHash(config)) stale.push('resolved verification policy changed');
  if (sources.status === 'ready' && report.sourceFingerprint
      && report.sourceFingerprint !== sources.fingerprint) stale.push('configured source files changed');
  if (direction.tokens.status !== 'ready') historical.push('current token hash is unavailable');
  else if (report.tokenHash !== direction.current.tokenHash) stale.push('token SSOT changed');
  if (direction.status !== 'absent' && direction.current.directionHash == null) historical.push('current direction hash is unavailable');
  else if ((report.directionHash ?? null) !== direction.current.directionHash) stale.push('direction identity changed');
  if (direction.status !== 'absent') {
    if (direction.current.bindingHash == null) historical.push('current binding hash is unavailable');
    else if ((report.direction?.bindingHash ?? report.emits?.directionBindingHash ?? null) !== direction.current.bindingHash) stale.push('resolved semantic bindings changed');
  }
  if (direction.approvals.status === 'verified'
      && (report.direction?.approvalHeadHash ?? report.emits?.directionApprovalHeadHash ?? null) !== direction.approvals.headHash) {
    stale.push('approval history head changed');
  }

  const freshnessStatus = stale.length ? 'stale' : historical.length ? 'historical' : 'current';
  const recordedStatus = report.status ?? (report.exitCode === 0 ? 'passed' : 'failed');
  return {
    status: freshnessStatus === 'current' ? recordedStatus : freshnessStatus,
    recordedStatus,
    exitCode: report.exitCode ?? null,
    generatedAt: report.generatedAt ?? null,
    counts: report.counts ?? null,
    filesScanned: report.filesScanned ?? null,
    gates: (report.gates ?? []).slice(0, 12).map(({ id, status, findings, reason }) => ({ id, status, findings: findings ?? 0, ...(reason ? { reason } : {}) })),
    configErrors: (report.configErrors ?? []).slice(0, 6).map((error) => typeof error === 'string' ? error : error.message ?? String(error)),
    freshness: {
      status: freshnessStatus,
      reasons: [...stale, ...historical].slice(0, 8),
      reportSourceFingerprint: report.sourceFingerprint ?? null,
      currentSourceFingerprint: sources.fingerprint,
    },
  };
}

function compactGraph(root) {
  const graph = indexRepository(root, {
    maxFiles: 2_000,
    maxBytes: 384 * 1024,
    maxTotalBytes: 24 * 1024 * 1024,
  });
  const components = graph.nodes.filter((node) => node.kind === 'component');
  const frameworks = [...new Set(components.map((node) => node.meta?.framework).filter(Boolean))].sort();
  return {
    stats: graph.stats,
    frameworks,
    routes: graph.proof.routes.slice(0, 16).map((route) => ({
      route: route.route,
      file: route.file,
      status: route.status,
      states: route.states.slice(0, 8),
      viewports: route.viewports.slice(0, 6),
      themes: route.themes.slice(0, 6),
    })),
    components: components.slice(0, 16).map((node) => ({ name: node.label, file: node.file, line: node.line })),
    proof: { ...graph.proof.appProof, summary: graph.proof.summary },
    warnings: graph.warnings.slice(0, 6).map(({ kind, file, message }) => ({ kind, file, message })),
  };
}

function compactReferences(root) {
  try {
    return createReferenceSystem(root).inspectStatus();
  } catch (error) {
    return {
      status: 'invalid', manifest: null, references: [],
      issues: [error?.message ?? String(error)],
    };
  }
}

function suggestLane(direction, report, configuration, references) {
  if (configuration.status === 'requires-trust' || configuration.status === 'invalid') {
    return { lane: 'verify', reason: 'Project configuration is not trusted and current evidence cannot be treated as authoritative.' };
  }
  if (references.status === 'invalid') {
    return { lane: 'verify', reason: 'Reference evidence is invalid and must be repaired before reconstruction continues.' };
  }
  if (['failed', 'incomplete', 'stale', 'historical', 'invalid'].includes(report.status)
      || ['drifted', 'invalid', 'unresolved'].includes(direction.lock.status)) {
    return { lane: 'verify', reason: 'Current evidence or the accepted identity needs diagnosis before creative expansion.' };
  }
  if (references.status === 'incomplete' || references.status === 'needs-repair') {
    return { lane: 'reconstruct', reason: 'An authorized reference evidence chain is active and still needs implementation or visual repair.' };
  }
  if (direction.status === 'absent' || direction.status === 'draft' || direction.status === 'invalid') {
    return { lane: 'explore', reason: 'No complete approved direction is available yet.' };
  }
  return { lane: 'refine', reason: 'An approved direction exists; preserve it unless the user explicitly requests a redesign.' };
}

function nextCommands(direction, report, graph, config, configuration, references, host = 'codex') {
  const commands = [];
  if (configuration.status === 'requires-trust') commands.push(`dk ${host} context --json --trust-project-config`);
  if (!configuration.file) commands.push('dk init');
  if (references.status === 'invalid') commands.push('dk reference validate --json');
  if (references.status === 'incomplete' || references.status === 'needs-repair') commands.push('dk reference status --json');
  if (direction.status === 'absent') commands.push('dk design init');
  if (direction.status !== 'absent') commands.push('dk design check');
  commands.push('dk verify --summary');
  if (config?.proof && graph.proof.status !== 'complete') commands.push('dk proof --app <url> --routes auto');
  if (report.status === 'passed') commands.push('dk verify --full --require-gates');
  return [...new Set(commands)].slice(0, 6);
}

function bridgeSummary(root, config, configuration) {
  const bridge = config?.bridge;
  if (!bridge || !configuration.trusted) return { configured: false, trustedConfigRequired: Boolean(configuration.executable), connections: [] };
  const sourcePath = bridge.sourcePath ?? join(root, 'design', 'bridge.json');
  return {
    configured: bridge.enabled || bridge.connections.length > 0 || existsSync(sourcePath),
    manifest: projectPath(root, sourcePath),
    connections: bridge.connections.slice(0, 12).map(({ id, adapter, role, enabled, required, trust }) => ({ id, adapter, role, enabled, required, trust })),
  };
}

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const suffix = '…';
  const suffixBytes = Buffer.byteLength(suffix);
  if (maxBytes <= suffixBytes) return '';
  const bytes = Buffer.from(text);
  let end = maxBytes - suffixBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString('utf8')}${suffix}`;
}

function boundStrings(value, maxBytes) {
  if (typeof value === 'string') return truncateUtf8(value, maxBytes);
  if (Array.isArray(value)) return value.map((item) => boundStrings(item, maxBytes));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundStrings(item, maxBytes)]));
  return value;
}

function minimalContext(context) {
  const compactReferenceEvidence = {
    ...context.evidence.references,
    references: context.evidence.references.references.slice(0, 3).map((reference) => ({
      id: reference.id,
      licence: reference.licence,
      stages: reference.stages,
      comparison: reference.comparison ? { status: reference.comparison.status } : null,
    })),
    issues: context.evidence.references.issues.slice(0, 2),
  };
  return {
    ...context,
    repository: {
      stats: context.repository.stats,
      frameworks: context.repository.frameworks.slice(0, 4),
      routes: [], components: [],
      proof: context.repository.proof,
      warnings: [],
    },
    direction: {
      ...context.direction,
      bindings: Object.fromEntries(Object.entries(context.direction.bindings).slice(0, 4)),
      issues: context.direction.issues.slice(0, 2),
    },
    evidence: {
      ...context.evidence,
      report: { ...context.evidence.report, gates: context.evidence.report.gates.slice(0, 4), configErrors: context.evidence.report.configErrors.slice(0, 2) },
      bridge: { ...context.evidence.bridge, connections: context.evidence.bridge.connections.slice(0, 3) },
      references: compactReferenceEvidence,
    },
    contextTruncated: true,
  };
}

function stampContextBytes(context) {
  context.contextBudget = CODEX_CONTEXT_MAX_BYTES;
  context.contextBytes = 0;
  for (let pass = 0; pass < 8; pass++) {
    const bytes = Buffer.byteLength(JSON.stringify(context));
    if (context.contextBytes === bytes) return bytes;
    context.contextBytes = bytes;
  }
  return Buffer.byteLength(JSON.stringify(context));
}

function finalizeContext(value) {
  let context = boundStrings(value, 512);
  let bytes = stampContextBytes(context);
  if (bytes > CODEX_CONTEXT_MAX_BYTES) {
    context.repository.components = context.repository.components.slice(0, 6);
    context.repository.routes = context.repository.routes.slice(0, 6);
    context.repository.warnings = context.repository.warnings.slice(0, 2);
    context.direction.issues = context.direction.issues.slice(0, 3);
    context.evidence.report.gates = context.evidence.report.gates.slice(0, 6);
    context.evidence.report.configErrors = context.evidence.report.configErrors.slice(0, 2);
    context.evidence.bridge.connections = context.evidence.bridge.connections.slice(0, 4);
    context.evidence.references.references = context.evidence.references.references.slice(0, 3);
    context.evidence.references.issues = context.evidence.references.issues.slice(0, 3);
    context.configuration.errors = context.configuration.errors.slice(0, 3);
    context = boundStrings(context, 256);
    bytes = stampContextBytes(context);
  }
  if (bytes > CODEX_CONTEXT_MAX_BYTES) {
    context = boundStrings(minimalContext(context), 192);
    bytes = stampContextBytes(context);
  }
  if (bytes > CODEX_CONTEXT_MAX_BYTES) throw new Error(`Codex context could not be bounded to ${CODEX_CONTEXT_MAX_BYTES} bytes.`);
  return context;
}

/** Build a bounded context pack. Executable config is opt-in and explicit. */
export async function buildCodexDesignContext(root = process.cwd(), options = {}) {
  const host = options.host === 'claude' ? 'claude' : 'codex';
  let projectRoot;
  try { projectRoot = realpathSync(resolvePath(root)); }
  catch { projectRoot = resolvePath(root); }
  const codex = inspectCodexIntegration(projectRoot);
  if (codex.scopeGuard.status !== 'ready') {
    throw new CodexIntegrationError(`Refusing global ${host === 'claude' ? 'Claude Code' : 'Codex'} context: ${codex.scopeGuard.issue}.`, 'DK_CODEX_SCOPE');
  }
  const { config, surface: configuration } = await resolveContextConfig(projectRoot, options);
  const direction = compactDirection(projectRoot, config);
  const sources = currentSourceEvidence(projectRoot, config, configuration);
  const report = compactReport(projectRoot, direction, config, configuration, sources, codex);
  const repository = compactGraph(projectRoot);
  const references = compactReferences(projectRoot);
  const suggestion = suggestLane(direction, report, configuration, references);
  const context = {
    schema: CODEX_CONTEXT_SCHEMA,
    host,
    project: basename(projectRoot),
    codex,
    suggestedLane: suggestion,
    repository,
    direction,
    evidence: {
      report,
      appProof: repository.proof,
      source: sources,
      bridge: bridgeSummary(projectRoot, config, configuration),
      references,
    },
    configuration,
    authority: {
      singleWriter: host === 'claude'
        ? 'Only the main Claude Code agent may edit product source; exploration and critique subagents remain read-only.'
        : 'Only the main Codex agent may edit product source; exploration and critique agents remain read-only.',
      requiresExplicitUserApproval: ['Taste Lock acceptance or update', 'visual baseline replacement', 'policy weakening', 'debt acceptance', 'Bridge publish', 'executable project config'],
      forbiddenGlobalWrites: host === 'claude'
        ? ['~/.claude', '~/.agents', 'plugin caches', 'personal marketplace']
        : ['~/.codex', '~/.agents', 'Codex plugin cache', 'personal marketplace'],
    },
    nextCommands: nextCommands(direction, report, repository, config, configuration, references, host),
  };
  return finalizeContext(context);
}
