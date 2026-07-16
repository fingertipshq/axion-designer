import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  BRIDGE_LIFECYCLES,
  BridgeValidationError,
  assertAdapterManifest,
  assertIntegrationEnvelope,
  canonicalStringify,
  createAdapterManifest,
  isSafeRelativePath,
} from './contracts.mjs';

export class BridgeRegistryError extends Error {
  constructor(message, code = 'AXION_BRIDGE_REGISTRY', details = null) {
    super(message);
    this.name = 'BridgeRegistryError';
    this.code = code;
    this.details = details;
  }
}

export class AdapterRegistry {
  #byId = new Map();
  #byProvider = new Map();

  constructor(adapters = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter, options = {}) {
    validateAdapter(adapter);
    const { id, provider } = adapter.manifest;
    const existingId = this.#byId.get(id);
    const existingProvider = this.#byProvider.get(provider);
    if (!options.replace && (existingId || existingProvider)) {
      const collision = existingId ? `adapter ${id}` : `provider ${provider}`;
      throw new BridgeRegistryError(`Refusing duplicate ${collision}.`, 'AXION_BRIDGE_DUPLICATE');
    }
    if (options.replace) {
      if (existingId) this.unregister(existingId.manifest.id);
      if (existingProvider && existingProvider !== existingId) this.unregister(existingProvider.manifest.id);
    }
    this.#byId.set(id, adapter);
    this.#byProvider.set(provider, adapter);
    return adapter;
  }

  unregister(id) {
    const adapter = this.#byId.get(id);
    if (!adapter) return false;
    this.#byId.delete(id);
    this.#byProvider.delete(adapter.manifest.provider);
    return true;
  }

  get(id) { return this.#byId.get(id) ?? null; }
  getByProvider(provider) { return this.#byProvider.get(provider) ?? null; }
  has(id) { return this.#byId.has(id); }
  hasProvider(provider) { return this.#byProvider.has(provider); }
  list(operation = null) {
    if (operation != null && !BRIDGE_LIFECYCLES.includes(operation)) {
      throw new BridgeRegistryError(`Unknown adapter lifecycle ${operation}.`, 'AXION_BRIDGE_LIFECYCLE');
    }
    return [...this.#byId.values()]
      .filter((adapter) => operation == null || adapter.manifest.lifecycle.includes(operation))
      .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }
  manifests(operation = null) { return this.list(operation).map((adapter) => adapter.manifest); }

  requireProviders(providers, operation = null) {
    const found = [];
    for (const provider of [...new Set(providers ?? [])]) {
      const adapter = this.getByProvider(provider);
      if (!adapter) throw new BridgeRegistryError(`Required provider ${provider} is not registered.`, 'AXION_BRIDGE_PROVIDER_MISSING', { provider, operation });
      if (operation && !adapter.manifest.lifecycle.includes(operation)) {
        throw new BridgeRegistryError(`Required provider ${provider} does not implement ${operation}.`, 'AXION_BRIDGE_LIFECYCLE_MISSING', { provider, operation });
      }
      found.push(adapter);
    }
    return found;
  }
}

export function createMemoryEnvelopeAdapter(options = {}) {
  exactOptions(options, ['id', 'provider', 'version', 'envelopes']);
  const id = options.id ?? 'memory';
  const provider = options.provider ?? id;
  const store = new Map();
  for (const envelope of options.envelopes ?? []) {
    assertIntegrationEnvelope(envelope);
    if (store.has(envelope.id)) throw new BridgeRegistryError(`Duplicate initial envelope ${envelope.id}.`, 'AXION_BRIDGE_DUPLICATE');
    store.set(envelope.id, clone(envelope));
  }
  const manifest = createAdapterManifest({
    id, provider, version: options.version ?? '1.0.0',
    lifecycle: ['discover', 'collect', 'publish'],
    permissions: {
      discover: ['memory:read'], collect: ['memory:read'], publish: ['memory:write'],
    },
  });
  return {
    manifest,
    async discover(query = {}, context = {}) {
      exactQuery(query, ['id', 'provider', 'kind']);
      context.signal?.throwIfAborted?.();
      return selectMemory(store, query).map(envelopeDescriptor);
    },
    async collect(query = {}, context = {}) {
      exactQuery(query, ['id', 'provider', 'kind']);
      context.signal?.throwIfAborted?.();
      return selectMemory(store, query).map(clone);
    },
    async publish(input, context = {}) {
      exactQuery(input, ['envelope', 'overwrite']);
      const envelope = input?.envelope;
      assertIntegrationEnvelope(envelope);
      context.signal?.throwIfAborted?.();
      if (store.has(envelope.id) && input.overwrite !== true) {
        throw new BridgeRegistryError(`Envelope ${envelope.id} already exists.`, 'AXION_BRIDGE_EXISTS');
      }
      store.set(envelope.id, clone(envelope));
      return [envelopeDescriptor(envelope)];
    },
  };
}

export function createFileEnvelopeAdapter(options = {}) {
  exactOptions(options, ['id', 'provider', 'version', 'root']);
  if (typeof options.root !== 'string' || !options.root) throw new BridgeRegistryError('File adapter root is required.', 'AXION_BRIDGE_ROOT');
  const root = resolve(options.root);
  mkdirSync(root, { recursive: true });
  assertDirectoryNoSymlink(root);
  const id = options.id ?? 'file';
  const provider = options.provider ?? id;
  const manifest = createAdapterManifest({
    id, provider, version: options.version ?? '1.0.0',
    lifecycle: ['discover', 'collect', 'publish'],
    permissions: {
      discover: ['file:read'], collect: ['file:read'], publish: ['file:write'],
    },
  });
  return {
    manifest,
    async discover(query = {}, context = {}) {
      exactQuery(query, ['path', 'id', 'provider', 'kind']);
      const files = envelopeFiles(root, query.path, context.signal);
      const results = [];
      for (const file of files) {
        context.signal?.throwIfAborted?.();
        const envelope = readEnvelope(root, file);
        if (matches(envelope, query)) results.push({ ...envelopeDescriptor(envelope), path: file });
      }
      return results;
    },
    async collect(query = {}, context = {}) {
      exactQuery(query, ['path', 'id', 'provider', 'kind']);
      const files = envelopeFiles(root, query.path, context.signal);
      const results = [];
      for (const file of files) {
        context.signal?.throwIfAborted?.();
        const envelope = readEnvelope(root, file);
        if (matches(envelope, query)) results.push(envelope);
      }
      return results;
    },
    async publish(input, context = {}) {
      exactQuery(input, ['envelope', 'path', 'overwrite']);
      const envelope = input?.envelope;
      assertIntegrationEnvelope(envelope);
      const file = input.path ?? `${envelope.id}.json`;
      if (!file.endsWith('.json')) throw new BridgeRegistryError('File envelope path must end in .json.', 'AXION_BRIDGE_FILE_TYPE');
      const destination = resolveInsideRoot(root, file, { allowMissing: true });
      if (existsSync(destination) && input.overwrite !== true) throw new BridgeRegistryError(`Envelope file ${file} already exists.`, 'AXION_BRIDGE_EXISTS');
      context.signal?.throwIfAborted?.();
      mkdirSafeParents(root, dirname(destination));
      atomicWrite(destination, `${JSON.stringify(envelope, null, 2)}\n`);
      return [{ ...envelopeDescriptor(envelope), path: slash(relative(root, destination)) }];
    },
  };
}

/** Resolve a portable relative path without following a symlink outside root. */
export function resolveInsideRoot(rootInput, relativePath, options = {}) {
  const root = resolve(rootInput);
  if (!isSafeRelativePath(relativePath)) throw new BridgeRegistryError(`Unsafe relative path ${JSON.stringify(relativePath)}.`, 'AXION_BRIDGE_PATH');
  if (!existsSync(root)) {
    if (!options.allowMissingRoot) throw new BridgeRegistryError(`Root does not exist: ${root}.`, 'AXION_BRIDGE_ROOT');
    mkdirSync(root, { recursive: true });
  }
  assertDirectoryNoSymlink(root);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + sep)) throw new BridgeRegistryError('Path escapes the configured root.', 'AXION_BRIDGE_PATH');
  let cursor = root;
  for (const part of relativePath.split('/')) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) continue;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new BridgeRegistryError(`Symlink traversal is forbidden: ${relativePath}.`, 'AXION_BRIDGE_SYMLINK');
  }
  if (!options.allowMissing && !existsSync(target)) throw new BridgeRegistryError(`Path does not exist: ${relativePath}.`, 'AXION_BRIDGE_MISSING');
  return target;
}

function validateAdapter(adapter) {
  if (!isPlainObject(adapter)) throw new BridgeRegistryError('Adapter must be a plain object.', 'AXION_BRIDGE_ADAPTER');
  const allowed = new Set(['manifest', ...BRIDGE_LIFECYCLES]);
  const unknown = Object.keys(adapter).filter((key) => !allowed.has(key));
  if (unknown.length) throw new BridgeRegistryError(`Unknown adapter fields: ${unknown.join(', ')}.`, 'AXION_BRIDGE_ADAPTER');
  try { assertAdapterManifest(adapter.manifest); }
  catch (error) {
    if (error instanceof BridgeValidationError) throw new BridgeRegistryError(error.message, error.code, error.issues);
    throw error;
  }
  for (const operation of BRIDGE_LIFECYCLES) {
    const declared = adapter.manifest.lifecycle.includes(operation);
    const implemented = typeof adapter[operation] === 'function';
    if (declared !== implemented) {
      throw new BridgeRegistryError(`Adapter ${adapter.manifest.id} must ${declared ? '' : 'not '}implement ${operation}.`, 'AXION_BRIDGE_LIFECYCLE');
    }
  }
}

function selectMemory(store, query) {
  return [...store.values()].filter((envelope) => matches(envelope, query)).sort((a, b) => a.id.localeCompare(b.id));
}
function matches(envelope, query) {
  return (!query.id || envelope.id === query.id)
    && (!query.provider || envelope.provider === query.provider)
    && (!query.kind || envelope.kind === query.kind);
}
function envelopeDescriptor(envelope) {
  return { id: envelope.id, provider: envelope.provider, kind: envelope.kind, createdAt: envelope.createdAt, digest: envelope.digest };
}

function envelopeFiles(root, path, signal) {
  if (path) {
    const absolute = resolveInsideRoot(root, path);
    const stat = lstatSync(absolute);
    if (stat.isFile()) {
      if (!path.endsWith('.json')) throw new BridgeRegistryError('Envelope file must end in .json.', 'AXION_BRIDGE_FILE_TYPE');
      return [slash(relative(root, absolute))];
    }
    if (!stat.isDirectory()) return [];
  }
  const start = path ? resolveInsideRoot(root, path) : root;
  const files = [];
  const stack = [start];
  while (stack.length) {
    signal?.throwIfAborted?.();
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new BridgeRegistryError(`Symlink traversal is forbidden under ${root}.`, 'AXION_BRIDGE_SYMLINK');
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(slash(relative(root, absolute)));
      if (files.length > 10_000) throw new BridgeRegistryError('File adapter envelope limit exceeded.', 'AXION_BRIDGE_LIMIT');
    }
  }
  return files.sort();
}

function readEnvelope(root, file) {
  const absolute = resolveInsideRoot(root, file);
  let parsed;
  try { parsed = JSON.parse(readFileSync(absolute, 'utf8')); }
  catch (error) { throw new BridgeRegistryError(`Cannot parse envelope ${file}: ${error.message}`, 'AXION_BRIDGE_PARSE'); }
  assertIntegrationEnvelope(parsed);
  return clone(parsed);
}

function mkdirSafeParents(root, targetDirectory) {
  const rel = slash(relative(root, targetDirectory));
  if (!rel || rel === '.') return;
  let cursor = root;
  for (const part of rel.split('/')) {
    cursor = join(cursor, part);
    if (existsSync(cursor)) {
      if (lstatSync(cursor).isSymbolicLink()) throw new BridgeRegistryError(`Symlink traversal is forbidden: ${rel}.`, 'AXION_BRIDGE_SYMLINK');
      continue;
    }
    mkdirSync(cursor);
  }
}

function atomicWrite(destination, content) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, destination);
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort */ }
  }
}

function assertDirectoryNoSymlink(root) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BridgeRegistryError(`Bridge root must be a real directory: ${root}.`, 'AXION_BRIDGE_ROOT');
  realpathSync(root);
}

function exactOptions(value, allowed) {
  if (!isPlainObject(value)) throw new BridgeRegistryError('Adapter options must be an object.', 'AXION_BRIDGE_OPTIONS');
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new BridgeRegistryError(`Unknown adapter options: ${unknown.join(', ')}.`, 'AXION_BRIDGE_OPTIONS');
}
function exactQuery(value, allowed) {
  if (!isPlainObject(value)) throw new BridgeRegistryError('Adapter input must be an object.', 'AXION_BRIDGE_INPUT');
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new BridgeRegistryError(`Unknown adapter input: ${unknown.join(', ')}.`, 'AXION_BRIDGE_INPUT');
}
function clone(value) { return JSON.parse(canonicalStringify(value)); }
function slash(value) { return value.split(sep).join('/'); }
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
