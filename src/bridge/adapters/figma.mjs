import { resolve } from 'node:path';
import {
  createAdapterEnvelope,
  defineManifest,
  isLoopbackHostname,
  isPlainObject,
  parseJsonBytes,
  readLocalFileSecure,
  runtimeAdapter,
  safeFetch,
  sanitizeArtifactUri,
  sha256,
  validateHttpUrl,
} from './common.mjs';

const OFFICIAL_API_BASE = 'https://api.figma.com/v1/';
const MAX_DISCOVERED_ITEMS = 10_000;

export const capabilities = Object.freeze(['figma.file.read', 'figma.variables.read', 'design.tokens.discover']);

export const manifest = defineManifest({
  id: 'figma',
  version: '1.0.0',
  kind: 'source',
  capabilities,
  permissions: {
    discover: [],
    collect: ['fs:read', 'network:api.figma.com', 'env:FIGMA_ACCESS_TOKEN'],
    publish: [],
  },
});

function safeNamedEntries(value, fields) {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).slice(0, MAX_DISCOVERED_ITEMS).map(([id, item]) => {
    const out = { id };
    if (isPlainObject(item)) {
      for (const field of fields) {
        if (['string', 'number', 'boolean'].includes(typeof item[field])) out[field] = item[field];
      }
    }
    return out;
  }).sort((a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)));
}

function variablesFromPayload(payload) {
  const variables = isPlainObject(payload?.meta?.variables) ? payload.meta.variables
    : isPlainObject(payload?.variables) ? payload.variables
      : {};
  return Object.entries(variables).slice(0, MAX_DISCOVERED_ITEMS).map(([id, variable]) => ({
    id,
    name: String(variable?.name ?? id),
    type: String(variable?.resolvedType ?? variable?.type ?? 'UNKNOWN'),
    ...(typeof variable?.variableCollectionId === 'string' ? { collectionId: variable.variableCollectionId } : {}),
    ...(isPlainObject(variable?.valuesByMode) ? { valuesByMode: variable.valuesByMode } : {}),
    remote: variable?.remote === true,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function flattenDtcg(value, prefix = [], output = []) {
  if (output.length >= MAX_DISCOVERED_ITEMS || !isPlainObject(value)) return output;
  if (Object.hasOwn(value, '$value')) {
    output.push({
      name: prefix.join('.'),
      type: typeof value.$type === 'string' ? value.$type : 'unknown',
      value: value.$value,
    });
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$')) continue;
    flattenDtcg(child, [...prefix, key], output);
    if (output.length >= MAX_DISCOVERED_ITEMS) break;
  }
  return output;
}

function extract(payloads) {
  const components = [];
  const componentSets = [];
  const styles = [];
  const variables = [];
  const dtcgTokens = [];
  for (const payload of payloads) {
    if (!isPlainObject(payload)) continue;
    components.push(...safeNamedEntries(payload.components, ['name', 'description', 'key', 'componentSetId']));
    componentSets.push(...safeNamedEntries(payload.componentSets, ['name', 'description', 'key']));
    styles.push(...safeNamedEntries(payload.styles, ['name', 'description', 'key', 'styleType']));
    variables.push(...variablesFromPayload(payload));
    flattenDtcg(payload, [], dtcgTokens);
  }
  const unique = (items, key) => [...new Map(items.map((item) => [item[key] ?? JSON.stringify(item), item])).values()];
  return {
    components: unique(components, 'id').slice(0, MAX_DISCOVERED_ITEMS),
    componentSets: unique(componentSets, 'id').slice(0, MAX_DISCOVERED_ITEMS),
    styles: unique(styles, 'id').slice(0, MAX_DISCOVERED_ITEMS),
    variables: unique(variables, 'id').slice(0, MAX_DISCOVERED_ITEMS),
    dtcgTokens: unique(dtcgTokens, 'name').slice(0, MAX_DISCOVERED_ITEMS),
  };
}

function apiBase(ctx) {
  if (!ctx.apiBaseUrl) return new URL(OFFICIAL_API_BASE);
  const candidate = validateHttpUrl(ctx.apiBaseUrl, { label: 'Figma API base URL', allowHttpLoopback: true });
  const official = candidate.origin === 'https://api.figma.com';
  if (!official && !(ctx.testMode === true && isLoopbackHostname(candidate.hostname))) {
    throw new Error('Figma REST requests are restricted to api.figma.com (loopback overrides require explicit testMode).');
  }
  return new URL(candidate.href.endsWith('/') ? candidate.href : `${candidate.href}/`);
}

async function readLocal(ctx) {
  const root = resolve(ctx.root ?? process.cwd());
  const local = await readLocalFileSecure(ctx.source, { root, maxBytes: ctx.maxBytes ?? 20 * 1024 * 1024 });
  return {
    payloads: [parseJsonBytes(local.bytes, 'Figma export')],
    artifacts: [{
      kind: 'figma-export',
      uri: local.relativePath,
      mediaType: 'application/json',
      bytes: local.bytes.length,
      digest: `sha256:${sha256(local.bytes)}`,
    }],
    findings: [],
    sourceDigest: sha256(local.bytes),
    authenticatedSource: false,
  };
}

async function fetchEndpoint(url, token, ctx, kind) {
  const result = await safeFetch(url.href, {
    headers: {
      'X-Figma-Token': token,
      Accept: 'application/json',
    },
    timeoutMs: ctx.timeoutMs,
    maxBytes: ctx.maxBytes ?? 20 * 1024 * 1024,
    fetchImpl: ctx.fetch,
    signal: ctx.signal,
    validateUrlOptions: {
      label: 'Figma REST URL',
      allowHttpLoopback: ctx.testMode === true,
      allowedHosts: ctx.testMode === true ? [url.hostname] : ['api.figma.com'],
    },
  });
  if (!result.response.ok) throw new Error(`${kind} returned HTTP ${result.response.status}.`);
  return {
    payload: parseJsonBytes(result.bytes, kind),
    artifact: {
      kind,
      uri: sanitizeArtifactUri(result.url.href),
      mediaType: 'application/json',
      bytes: result.bytes.length,
      digest: `sha256:${sha256(result.bytes)}`,
    },
    bytes: result.bytes,
  };
}

async function readRest(ctx) {
  if (ctx.token !== undefined || ctx.accessToken !== undefined) {
    throw new Error('Figma credentials must be supplied only through the FIGMA_ACCESS_TOKEN environment variable.');
  }
  const env = isPlainObject(ctx.env) ? ctx.env : process.env;
  const token = env.FIGMA_ACCESS_TOKEN;
  if (typeof token !== 'string' || !token) throw new Error('FIGMA_ACCESS_TOKEN is required for Figma REST access.');
  if (typeof ctx.fileKey !== 'string' || !/^[A-Za-z0-9_-]{2,256}$/.test(ctx.fileKey)) {
    throw new TypeError('A valid Figma fileKey is required.');
  }
  const base = apiBase(ctx);
  const fileUrl = new URL(`files/${encodeURIComponent(ctx.fileKey)}`, base);
  const file = await fetchEndpoint(fileUrl, token, ctx, 'figma-file');
  const payloads = [file.payload];
  const artifacts = [file.artifact];
  const bytes = [file.bytes];
  const findings = [];
  if (ctx.includeVariables !== false) {
    try {
      const variablesUrl = new URL(`files/${encodeURIComponent(ctx.fileKey)}/variables/local`, base);
      const variables = await fetchEndpoint(variablesUrl, token, ctx, 'figma-variables');
      payloads.push(variables.payload);
      artifacts.push(variables.artifact);
      bytes.push(variables.bytes);
    } catch (error) {
      if (ctx.variablesRequired === true) throw error;
      findings.push({
        ruleId: 'figma/variables-unavailable',
        severity: 'warning',
        message: `Figma file data was read, but local variables were unavailable: ${error.message}`,
      });
    }
  }
  return {
    payloads,
    artifacts,
    findings,
    sourceDigest: sha256(Buffer.concat(bytes)),
    authenticatedSource: true,
  };
}

export async function collect(ctx = {}) {
  const loaded = typeof ctx.source === 'string' && !/^https?:\/\//i.test(ctx.source)
    ? await readLocal(ctx)
    : await readRest(ctx);
  const discovered = extract(loaded.payloads);
  const count = discovered.components.length + discovered.componentSets.length + discovered.styles.length
    + discovered.variables.length + discovered.dtcgTokens.length;
  if (count === 0) {
    loaded.findings.push({
      ruleId: 'figma/no-design-assets',
      severity: 'warning',
      message: 'The Figma payload was valid JSON but contained no components, styles, variables, or DTCG tokens.',
    });
  }
  let digestBound = false;
  if (ctx.expectedSha256 != null) {
    if (typeof ctx.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(ctx.expectedSha256)) {
      throw new TypeError('figma expectedSha256 must be a 64-character SHA-256 digest.');
    }
    if (ctx.expectedSha256.toLowerCase() !== loaded.sourceDigest) throw new Error('Figma evidence SHA-256 does not match expectedSha256.');
    digestBound = true;
  }
  return createAdapterEnvelope({
    manifest,
    capability: 'design.tokens.discover',
    trust: loaded.authenticatedSource || digestBound ? 'verified' : 'observed',
    status: loaded.findings.length > 0 ? 'partial' : 'passed',
    repository: {
      root: ctx.root,
      remote: ctx.repository?.remote,
      commit: ctx.expectedCommit ?? ctx.repository?.commit,
    },
    coverage: {
      complete: loaded.findings.length === 0,
      components: discovered.components.length,
      componentSets: discovered.componentSets.length,
      styles: discovered.styles.length,
      variables: discovered.variables.length,
      tokens: discovered.variables.length + discovered.dtcgTokens.length,
    },
    artifacts: loaded.artifacts,
    findings: loaded.findings,
    metadata: {
      components: discovered.components,
      componentSets: discovered.componentSets,
      styles: discovered.styles,
      variables: discovered.variables,
      dtcgTokens: discovered.dtcgTokens,
      credentialsPersisted: false,
      sourceSha256: loaded.sourceDigest,
      digestBound,
      authenticatedSource: loaded.authenticatedSource,
      commitBinding: 'collection-context',
      producerCommitProven: false,
    },
    now: ctx.now,
    maxAgeMs: ctx.maxAgeMs,
    idSeed: { sourceDigest: loaded.sourceDigest },
  });
}

export default runtimeAdapter({ manifest, collect });
