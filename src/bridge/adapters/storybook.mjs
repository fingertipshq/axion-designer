import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createAdapterEnvelope,
  defineManifest,
  isPlainObject,
  parseJsonBytes,
  readLocalFileSecure,
  runtimeAdapter,
  safeFetch,
  sanitizeArtifactUri,
  sha256,
} from './common.mjs';

export const capabilities = Object.freeze(['storybook.index.read', 'ui.component-state.discover']);

export const manifest = defineManifest({
  id: 'storybook',
  version: '1.0.0',
  kind: 'source',
  capabilities,
  permissions: {
    discover: [],
    collect: ['fs:read', 'network:storybook'],
    publish: [],
  },
});

function storyEntries(index) {
  const source = isPlainObject(index.entries) ? index.entries
    : isPlainObject(index.stories) ? index.stories
      : null;
  if (!source) throw new Error('Storybook index must contain an entries or stories object.');
  const output = [];
  for (const [key, raw] of Object.entries(source)) {
    if (!isPlainObject(raw)) continue;
    const type = String(raw.type ?? 'story').toLowerCase();
    if (type === 'docs' || type === 'meta') continue;
    const id = String(raw.id ?? key).trim();
    const component = String(raw.title ?? raw.kind ?? raw.component ?? '').trim();
    const state = String(raw.name ?? raw.story ?? raw.state ?? '').trim();
    if (!id || !component || !state) continue;
    output.push({
      id,
      component,
      state,
      ...(typeof raw.importPath === 'string' ? { importPath: raw.importPath } : {}),
      ...(Array.isArray(raw.tags) ? { tags: [...new Set(raw.tags.filter((tag) => typeof tag === 'string'))].sort() } : {}),
    });
  }
  output.sort((a, b) => a.id.localeCompare(b.id));
  return output;
}

async function readIndex(ctx) {
  const source = ctx.source ?? ctx.index;
  if (typeof source !== 'string' || !source.trim()) {
    throw new TypeError('storybook.collect requires ctx.source pointing to index.json or a Storybook URL.');
  }
  if (/^https?:\/\//i.test(source)) {
    const base = new URL(source);
    const target = /\/index\.json$/i.test(base.pathname)
      ? base
      : new URL(`${base.pathname.replace(/\/$/, '')}/index.json`, base);
    const result = await safeFetch(target.href, {
      timeoutMs: ctx.timeoutMs,
      maxBytes: ctx.maxBytes ?? 10 * 1024 * 1024,
      allowRedirects: ctx.allowRedirects === true,
      maxRedirects: ctx.maxRedirects ?? 0,
      fetchImpl: ctx.fetch,
      signal: ctx.signal,
      validateUrlOptions: { label: 'Storybook index URL', allowHttpLoopback: true },
    });
    if (!result.response.ok) throw new Error(`Storybook index returned HTTP ${result.response.status}.`);
    return {
      parsed: parseJsonBytes(result.bytes, 'Storybook index'),
      bytes: result.bytes,
      uri: result.url.href,
      redirects: result.redirects,
    };
  }
  const root = resolve(ctx.root ?? process.cwd());
  let path = resolve(root, source);
  try {
    if ((await stat(path)).isDirectory()) path = join(path, 'index.json');
  } catch {
    // readLocalFileSecure returns the stable, root-constrained error.
  }
  const local = await readLocalFileSecure(path, { root, maxBytes: ctx.maxBytes ?? 10 * 1024 * 1024 });
  return {
    parsed: parseJsonBytes(local.bytes, 'Storybook index'),
    bytes: local.bytes,
    uri: local.relativePath,
    redirects: 0,
  };
}

export async function collect(ctx = {}) {
  const loaded = await readIndex(ctx);
  const stories = storyEntries(loaded.parsed);
  if (stories.length === 0) throw new Error('Storybook index contains no parseable story states.');
  const components = [...new Set(stories.map((story) => story.component))].sort();
  const states = [...new Set(stories.map((story) => story.state))].sort();
  const digest = sha256(loaded.bytes);
  let digestBound = false;
  if (ctx.expectedSha256 != null) {
    if (typeof ctx.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(ctx.expectedSha256)) {
      throw new TypeError('storybook expectedSha256 must be a 64-character SHA-256 digest.');
    }
    if (ctx.expectedSha256.toLowerCase() !== digest) throw new Error('Storybook index SHA-256 does not match expectedSha256.');
    digestBound = true;
  }
  return createAdapterEnvelope({
    manifest,
    capability: 'ui.component-state.discover',
    trust: digestBound ? 'verified' : 'observed',
    status: 'passed',
    repository: {
      root: ctx.root,
      remote: ctx.repository?.remote,
      commit: ctx.expectedCommit ?? ctx.repository?.commit,
    },
    coverage: {
      complete: true,
      components: components.length,
      stories: stories.length,
      states: states.length,
    },
    artifacts: [{
      kind: 'storybook-index',
      uri: sanitizeArtifactUri(loaded.uri),
      mediaType: 'application/json',
      bytes: loaded.bytes.length,
      digest: `sha256:${digest}`,
    }],
    metadata: {
      indexVersion: Number.isInteger(loaded.parsed.v) ? loaded.parsed.v : null,
      components,
      states,
      stories,
      redirects: loaded.redirects,
      sourceSha256: digest,
      digestBound,
      commitBinding: 'collection-context',
      producerCommitProven: false,
    },
    now: ctx.now,
    maxAgeMs: ctx.maxAgeMs,
    idSeed: { sourceDigest: digest },
  });
}

export default runtimeAdapter({ manifest, collect });
