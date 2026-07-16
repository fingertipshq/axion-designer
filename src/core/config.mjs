/* ============================================================
   dk config — 載入、驗證、合併。
   格式：dk.config.mjs（ESM，可寫 test 函式＝天花板）
        或 dk.config.json（靜態＋$schema 補全）。
   合併：內建預設 < 選定 preset < 使用者 config。
   找不到 config -> 退回 'recommended'，讓新專案可零設定執行。
   零依賴。
   ============================================================ */
import { existsSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath, isAbsolute, relative, sep } from 'node:path';
import { makeFinding } from './finding.mjs';
import { fmsg, pick } from './i18n.mjs';
import { validateAppProofConfig } from '../proof/app-proof.mjs';
import { normalizeA11yTags, validateA11yTags } from './a11y-tags.mjs';
import { isCredentialKey, urlCarriesCredentials } from './credential-safety.mjs';

/** identity＋型別輔助：專家在 dk.config.mjs 裡包住自己的設定。 */
export function defineConfig(cfg) {
  return cfg;
}

/* ---- 內建預設（所有 preset 疊在其上）---- */
const BASE_DEFAULTS = {
  tokens: { source: 'design/tokens.json', output: { css: 'styles/tokens.css' } },
  // The direction contract is optional until adopted; once its file exists,
  // every core run validates and fingerprints it.
  direction: {
    source: 'design/direction.json',
    lock: 'design/direction.lock.json',
    required: false,
  },
  // Source + style surfaces understood by the built-in slop scanner. Keep this
  // list in sync with init detection/watch so zero-config verification cannot
  // quietly miss standalone styles or framework/script files.
  targets: ['**/*.{html,css,scss,less,js,jsx,ts,tsx,vue,svelte,astro}'],
  // dk-report.html：dk verify --html 的預設落點。納入預設 ignore，避免報告被 **/*.html
  // 這類 targets 掃回、其 evidence 的 lorem/hex 字樣造成下次 verify findings 連鎖暴增（自我污染）。
  ignore: ['**/node_modules/**', '**/.dk/**', '**/dist/**', '**/build/**', '**/.git/**', '**/fixtures/**', 'dk-report.html'],
  failOn: 'error',
  // When true, an attempted gate that reports `skipped` makes verification
  // non-zero. `--full` also fails on blocking infrastructure skips even when
  // this is false; benign first-run states (for example no visual baseline)
  // stay visible as incomplete without making initial setup impossible.
  failOnSkipped: false,
  tokens_required: [],
  contrast: { algorithm: 'wcag', modes: ['light', 'dark'], pairs: [] },
  // scale 強制把 token 治理延伸到 spacing/type/radius；預設關閉。
  enforce: { spacing: 'off', radius: 'off', type: 'off' },
  slop: { fonts: { allow: [], deny: [] }, rules: [] },
  severity: {},
  allowlist: {},
  gates: {
    cssStrict: { enabled: false },
    a11y: { enabled: false, tags: ['wcag2a', 'wcag2aa'] },
    visual: { enabled: false, viewports: [375, 1024], themes: ['light', 'dark'] },
    bridge: { enabled: false },
  },
  // Axion Bridge is opt-in. Connections remain repository-owned metadata;
  // credentials are referenced by environment-variable name inside adapter
  // options and are never persisted in the bridge ledger.
  bridge: {
    enabled: false,
    source: 'design/bridge.json',
    artifactDir: '.dk/bridge',
    timeoutMs: 30_000,
    maxArtifactBytes: 2 * 1024 * 1024,
    freshnessMs: 24 * 60 * 60 * 1000,
    connections: [],
  },
  baseline: '.dk/baseline.json',
  report: {},
};

/* ---- presets：以資料形式定義品味基線 ---- */
export const PRESETS = {
  // recommended：內建規則全開、對比 WCAG AA、warn 保持 warn。
  recommended: {
    severity: {},
    gates: { cssStrict: { enabled: false }, a11y: { enabled: false }, visual: { enabled: false } },
  },
  // strict：把軟規則升成 error，並啟用 scale 與重關卡。
  strict: {
    failOn: 'error',
    // A strict pipeline is a required pipeline: if an enabled gate cannot run
    // (including an uninitialized visual baseline), verification is incomplete
    // and exits non-zero until the prerequisite is deliberately satisfied.
    failOnSkipped: true,
    enforce: { spacing: 'warn', radius: 'warn', type: 'warn' },
    severity: {
      'slop/gradient-hero': 'error',
      'slop/emoji-heading': 'error',
      'slop/vanity-number': 'error',
    },
    gates: {
      cssStrict: { enabled: true },
      a11y: { enabled: true, tags: ['wcag2a', 'wcag2aa'] },
      visual: { enabled: true, viewports: [375, 1024], themes: ['light', 'dark'] },
    },
  },
  // 最小面：只留硬性 token/契約與寫死色/lorem，其餘關掉。給不想被囉嗦的既有大 repo。
  minimal: {
    severity: {
      'slop/ai-font': 'off',
      'slop/gradient-hero': 'off',
      'slop/emoji-heading': 'off',
      'slop/vanity-number': 'off',
    },
    gates: { cssStrict: { enabled: false }, a11y: { enabled: false }, visual: { enabled: false } },
  },
};

const CONFIG_FILES = ['dk.config.mjs', 'dk.config.js', 'dk.config.json'];

// Keep runtime validation aligned with dk.schema.json. JSON editors can use the
// schema, but JavaScript configs bypass it entirely; a misspelling such as
// `gates.visaul` must therefore fail at the execution boundary instead of
// silently disabling the intended gate.
const CONFIG_KEYS = new Set([
  '$schema', 'preset', 'tokens', 'direction', 'targets', 'ignore', 'failOn',
  'failOnSkipped', 'tokens_required', 'contrast', 'enforce', 'slop',
  'severity', 'allowlist', 'proof', 'gates', 'bridge', 'baseline', 'report',
]);
const CONFIG_OBJECT_KEYS = {
  tokens: new Set(['source', 'output']),
  direction: new Set(['source', 'lock', 'required']),
  contrast: new Set(['algorithm', 'modes', 'pairs']),
  enforce: new Set(['spacing', 'radius', 'type']),
  slop: new Set(['fonts', 'rules']),
  'slop.fonts': new Set(['allow', 'deny']),
  gates: new Set(['cssStrict', 'a11y', 'visual', 'bridge']),
  'gates.cssStrict': new Set(['enabled']),
  'gates.a11y': new Set(['enabled', 'tags']),
  'gates.visual': new Set(['enabled', 'viewports', 'themes']),
  'gates.bridge': new Set(['enabled']),
  bridge: new Set(['enabled', 'source', 'artifactDir', 'timeoutMs', 'maxArtifactBytes', 'freshnessMs', 'connections']),
};
const BRIDGE_CONNECTION_KEYS = new Set([
  'id', 'adapter', 'role', 'enabled', 'required', 'trust', 'source', 'module',
  'permissions', 'options',
]);
const SLOP_RULE_KEYS = new Set([
  'id', 'zone', 'pattern', 'flags', 'severity', 'message', 'hint', 'fix', 'test',
]);

/** 找 config 檔（回傳絕對路徑或 null）。 */
export function findConfigFile(cwd) {
  for (const name of CONFIG_FILES) {
    const p = resolvePath(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 讀取＋驗證＋合併 config，回傳 ResolvedConfig（絕對化路徑、攤平的取用面）。
 * @returns {Promise<ResolvedConfig>}
 */
export async function loadConfig(cwd = process.cwd()) {
  const file = findConfigFile(cwd);
  let raw = {};
  if (file) {
    try {
      if (file.endsWith('.json')) {
        const { readFileSync } = await import('node:fs');
        raw = JSON.parse(readFileSync(file, 'utf8'));
      } else {
        const mod = await import(pathToFileURL(file).href);
        raw = mod.default ?? mod.config ?? {};
      }
    } catch (err) {
      throw new Error(`載入 config 失敗（${file}）：${err.message}`);
    }
  }
  const bridgeConfigIssues = [];
  raw = loadBridgeManifest(raw, cwd, bridgeConfigIssues);
  const { config, errors } = validateConfig(raw);
  for (const issue of bridgeConfigIssues) {
    errors.push(configFatalFinding(issue.path, issue.message, issue.fix, issue.meta));
  }
  const merged = mergeConfig(config);
  const resolved = resolveConfig(merged, cwd, file, errors);
  // clone 會丟掉函式；把使用者原始的程式式 test 規則接回。
  return preserveFunctions(resolved, config);
}

function loadBridgeManifest(rawInput, cwd, issues) {
  if (!isObj(rawInput)) return rawInput;
  const raw = { ...rawInput, ...(isObj(rawInput.bridge) ? { bridge: { ...rawInput.bridge } } : {}) };
  const source = raw.bridge?.source ?? 'design/bridge.json';
  if (typeof source !== 'string' || !source.trim()) return raw;
  const path = isAbsolute(source) ? source : resolvePath(cwd, source);
  if (!isInside(cwd, path) || (existsSync(path) && !isInside(realpathSync(cwd), realpathSync(path)))) {
    issues.push({
      path: 'bridge.source',
      message: pick(`Bridge manifest 必須位於 repository 內（收到 ${source}）。`, `Bridge manifest must stay inside the repository (received ${source}).`),
      fix: pick('把 bridge.source 移到專案內，例如 design/bridge.json。', 'Move bridge.source into the project, for example design/bridge.json.'),
      meta: { bridgeSource: source },
    });
    return raw;
  }
  if (!existsSync(path)) return raw;
  let manifest;
  try {
    const stat = statSync(path);
    if (stat.size > 1024 * 1024) throw new Error('manifest exceeds 1 MiB');
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    issues.push({
      path: 'bridge.source',
      message: pick(`無法讀取 Bridge manifest（${source}）：${error.message}`, `Could not read Bridge manifest (${source}): ${error.message}`),
      fix: pick('修正 JSON，或移除 bridge.source。', 'Fix the JSON or remove bridge.source.'),
      meta: { bridgeSource: source },
    });
    return raw;
  }
  if (!isObj(manifest) || manifest.schema !== 'axion-bridge-config/v1' || !Array.isArray(manifest.connections)) {
    issues.push({
      path: 'bridge.source',
      message: pick(`Bridge manifest ${source} 必須是 axion-bridge-config/v1 且包含 connections array。`, `Bridge manifest ${source} must be axion-bridge-config/v1 with a connections array.`),
      fix: pick('執行 `dk bridge init` 重新建立安全範本。', 'Run `dk bridge init` to create a safe template.'),
      meta: { bridgeSource: source },
    });
    return raw;
  }
  const unknown = Object.keys(manifest).filter((key) => !['$schema', 'schema', 'connections'].includes(key));
  if (unknown.length) {
    issues.push({
      path: `bridge.source.${unknown[0]}`,
      message: pick(`Bridge manifest 有未知欄位：${unknown.join(', ')}`, `Bridge manifest has unknown fields: ${unknown.join(', ')}`),
      fix: pick('移除未知欄位；provider 專屬設定應放在 connection.options。', 'Remove unknown fields; provider-specific data belongs in connection.options.'),
      meta: { bridgeSource: source, unknown },
    });
  }
  reportDuplicateBridgeIds(manifest.connections, 'manifest', source, issues);
  const inlineConnections = Array.isArray(raw.bridge?.connections) ? raw.bridge.connections : [];
  reportDuplicateBridgeIds(inlineConnections, 'inline', source, issues);
  const merged = new Map();
  for (const connection of manifest.connections) {
    const key = isObj(connection) && typeof connection.id === 'string' ? connection.id : `manifest:${merged.size}`;
    merged.set(key, connection);
  }
  // Inline config intentionally wins over the portable manifest by id.
  for (const connection of inlineConnections) {
    const key = isObj(connection) && typeof connection.id === 'string' ? connection.id : `inline:${merged.size}`;
    merged.set(key, connection);
  }
  raw.bridge ??= {};
  raw.bridge.source = source;
  raw.bridge.connections = [...merged.values()];
  return raw;
}

/** 淺驗證 raw config，回傳規範化物件＋errors:Finding[]。 */
export function validateConfig(raw) {
  const errors = [];
  const rawIsObject = isObj(raw);
  const config = rawIsObject ? { ...raw } : {};

  if (!rawIsObject) {
    errors.push(configFatalFinding(
      'dk.config',
      pick('設定檔頂層必須是 object。', 'The top level of the config must be an object.'),
      pick('使用 export default { ... } 或一個 JSON object。', 'Use `export default { ... }` or a JSON object.'),
    ));
  } else {
    for (const issue of runtimeConfigShapeIssues(config)) {
      errors.push(configFatalFinding(issue.path, issue.message, issue.fix, issue.meta));
    }
  }

  const presetName = config.preset ?? 'recommended';
  if (!PRESETS[presetName]) {
    errors.push(makeFinding({
      ruleId: 'tokens/structure', severity: 'error', file: 'dk.config',
      ...fmsg('config.unknownPreset', { preset: presetName, avail: Object.keys(PRESETS).join(' / ') }),
    }));
    config.preset = 'recommended';
  }
  if (config.failOn && !['error', 'warn'].includes(config.failOn)) {
    errors.push(makeFinding({
      ruleId: 'tokens/structure', severity: 'error', file: 'dk.config',
      ...fmsg('config.badFailOn', { got: config.failOn }),
    }));
    delete config.failOn;
  }
  if (config.failOnSkipped != null && typeof config.failOnSkipped !== 'boolean') {
    errors.push(makeFinding({
      ruleId: 'tokens/structure', severity: 'error', file: 'dk.config',
      message: pick(
        `failOnSkipped 必須是 boolean（收到 ${JSON.stringify(config.failOnSkipped)}）`,
        `failOnSkipped must be a boolean (got ${JSON.stringify(config.failOnSkipped)})`),
      fix: pick('把 failOnSkipped 設成 true 或 false。', 'Set failOnSkipped to true or false.'),
      meta: { configFatal: true },
    }));
    delete config.failOnSkipped;
  }
  // Real-app proof is an execution contract, so malformed routes/states must
  // fail during config loading rather than being ignored until a browser run.
  // The same pure validator is used by the runner to keep both boundaries
  // fail-closed even when a caller bypasses loadConfig programmatically.
  if (config.proof != null) {
    for (const issue of validateAppProofConfig(config.proof)) {
      errors.push(makeFinding({
        ruleId: 'config/app-proof', severity: 'error', file: 'dk.config',
        message: pick(`App Proof 設定無效：${issue}`, `Invalid App Proof config: ${issue}`),
        fp: `App Proof 設定無效：${issue}`,
        fix: pick('修正 proof.baseUrl、routes、states、viewports 或 themes；未驗證的矩陣不會被視為通過。',
          'Fix proof.baseUrl, routes, states, viewports, or themes; an unverified matrix is never treated as a pass.'),
        meta: { configFatal: true, proofIssue: issue },
      }));
    }
  }
  if (config.targets && !Array.isArray(config.targets)) {
    errors.push(makeFinding({
      ruleId: 'tokens/structure', severity: 'error', file: 'dk.config',
      ...fmsg('config.badTargets'),
    }));
    delete config.targets;
  }
  if (config.direction != null && (!config.direction || typeof config.direction !== 'object' || Array.isArray(config.direction))) {
    errors.push(makeFinding({
      ruleId: 'direction/contract', severity: 'error', file: 'dk.config',
      message: pick('direction 必須是 object。', 'direction must be an object.'),
      fix: pick('使用 direction: { source, lock, required }。', 'Use direction: { source, lock, required }.'),
      meta: { configFatal: true },
    }));
    delete config.direction;
  } else if (config.direction) {
    if (config.direction.source != null && typeof config.direction.source !== 'string') {
      errors.push(makeFinding({
        ruleId: 'direction/contract', severity: 'error', file: 'dk.config',
        message: pick('direction.source 必須是字串路徑。', 'direction.source must be a string path.'),
        fix: pick("例如 'design/direction.json'。", "For example, 'design/direction.json'."),
        meta: { configFatal: true },
      }));
      delete config.direction.source;
    }
    if (config.direction.lock != null && typeof config.direction.lock !== 'string') {
      errors.push(makeFinding({
        ruleId: 'direction/contract', severity: 'error', file: 'dk.config',
        message: pick('direction.lock 必須是字串路徑。', 'direction.lock must be a string path.'),
        fix: pick("例如 'design/direction.lock.json'。", "For example, 'design/direction.lock.json'."),
        meta: { configFatal: true },
      }));
      delete config.direction.lock;
    }
    if (config.direction.required != null && typeof config.direction.required !== 'boolean') {
      errors.push(makeFinding({
        ruleId: 'direction/contract', severity: 'error', file: 'dk.config',
        message: pick('direction.required 必須是 boolean。', 'direction.required must be a boolean.'),
        fix: pick('設成 true 或 false。', 'Set it to true or false.'),
        meta: { configFatal: true },
      }));
      delete config.direction.required;
    }
  }
  const algo = config.contrast?.algorithm;
  if (algo && !['wcag', 'apca'].includes(algo)) {
    errors.push(makeFinding({
      ruleId: 'tokens/contrast', severity: 'error', file: 'dk.config',
      ...fmsg('config.badAlgorithm', { got: algo }),
    }));
  }
  // severity 只接受 error/warn/info/off；非法值會讓門檻與 counts 失去定義，因此視為致命
  // config 錯誤並刪除該覆寫，確保後續路徑仍退回規則預設。
  if (config.severity && typeof config.severity === 'object' && !Array.isArray(config.severity)) {
    const VALID = ['error', 'warn', 'info', 'off'];
    for (const [ruleId, val] of Object.entries(config.severity)) {
      if (VALID.includes(val)) continue;
      errors.push(makeFinding({
        ruleId: 'tokens/structure', severity: 'error', file: 'dk.config',
        message: pick(
          `severity['${ruleId}'] 必須是 ${VALID.join(' / ')} 其中之一（收到 ${JSON.stringify(val)}）`,
          `severity['${ruleId}'] must be one of ${VALID.join(' / ')} (got ${JSON.stringify(val)})`),
        fix: pick(`把 severity['${ruleId}'] 改成 ${VALID.join(' / ')} 其中之一。`,
                  `Set severity['${ruleId}'] to one of ${VALID.join(' / ')}.`),
        meta: { configFatal: true },
      }));
      delete config.severity[ruleId];
    }
  }
  return { config, errors };
}

function runtimeConfigShapeIssues(config) {
  const issues = [];
  rejectRuntimeUnknown(config, CONFIG_KEYS, 'dk.config', issues);

  for (const [path, keys] of Object.entries(CONFIG_OBJECT_KEYS)) {
    const value = getConfigPath(config, path);
    if (value == null) continue;
    if (!isObj(value)) {
      issues.push(shapeIssue(path, `${path} must be an object`));
      deleteConfigPath(config, path);
      continue;
    }
    rejectRuntimeUnknown(value, keys, path, issues);
  }

  if (config.tokens?.source != null && (typeof config.tokens.source !== 'string' || !config.tokens.source.trim())) {
    issues.push(shapeIssue('tokens.source', 'tokens.source must be a non-empty path string'));
    delete config.tokens.source;
  }
  if (config.tokens?.output != null && !isObj(config.tokens.output)) {
    issues.push(shapeIssue('tokens.output', 'tokens.output must be an object of path strings'));
    delete config.tokens.output;
  } else if (isObj(config.tokens?.output)) {
    for (const [format, target] of Object.entries(config.tokens.output)) {
      if (typeof target !== 'string' || !target.trim()) {
        issues.push(shapeIssue(`tokens.output.${format}`, `tokens.output.${format} must be a non-empty path string`));
        delete config.tokens.output[format];
      }
    }
  }

  const arrayFields = [
    ['ignore', config.ignore], ['tokens_required', config.tokens_required],
    ['contrast.modes', config.contrast?.modes], ['contrast.pairs', config.contrast?.pairs],
    ['slop.fonts.allow', config.slop?.fonts?.allow], ['slop.fonts.deny', config.slop?.fonts?.deny],
    ['slop.rules', config.slop?.rules], ['gates.a11y.tags', config.gates?.a11y?.tags],
    ['gates.visual.viewports', config.gates?.visual?.viewports],
    ['gates.visual.themes', config.gates?.visual?.themes],
    ['bridge.connections', config.bridge?.connections],
  ];
  for (const [path, value] of arrayFields) {
    if (value != null && !Array.isArray(value)) {
      issues.push(shapeIssue(path, `${path} must be an array`));
      deleteConfigPath(config, path);
    }
  }

  const stringArrays = [
    ['targets', config.targets], ['ignore', config.ignore], ['tokens_required', config.tokens_required],
    ['contrast.modes', config.contrast?.modes], ['slop.fonts.allow', config.slop?.fonts?.allow],
    ['slop.fonts.deny', config.slop?.fonts?.deny],
    ['gates.visual.themes', config.gates?.visual?.themes],
  ];
  for (const [path, value] of stringArrays) {
    if (Array.isArray(value) && !value.every((entry) => typeof entry === 'string' && entry.trim())) {
      issues.push(shapeIssue(path, `${path} must contain only non-empty strings`));
      deleteConfigPath(config, path);
    }
  }
  if (Array.isArray(config.gates?.a11y?.tags)) {
    const tagIssues = validateA11yTags(config.gates.a11y.tags);
    for (const issue of tagIssues) issues.push(shapeIssue(issue.path, issue.message));
    if (tagIssues.length) delete config.gates.a11y.tags;
    else config.gates.a11y.tags = normalizeA11yTags(config.gates.a11y.tags);
  }
  const viewportValues = config.gates?.visual?.viewports;
  if (Array.isArray(viewportValues) && !viewportValues.every((width) => Number.isInteger(width) && width > 0 && width <= 10000)) {
    issues.push(shapeIssue('gates.visual.viewports', 'gates.visual.viewports must contain positive integer widths'));
    delete config.gates.visual.viewports;
  }
  if (Array.isArray(config.contrast?.modes)
      && !config.contrast.modes.every((mode) => mode === 'light' || mode === 'dark')) {
    issues.push(shapeIssue('contrast.modes', 'contrast.modes may contain only light and dark'));
    delete config.contrast.modes;
  }
  if (Array.isArray(config.contrast?.pairs)
      && !config.contrast.pairs.every((pair) => Array.isArray(pair) && pair.length === 3
        && typeof pair[0] === 'string' && typeof pair[1] === 'string'
        && typeof pair[2] === 'number' && Number.isFinite(pair[2]) && pair[2] > 0)) {
    issues.push(shapeIssue('contrast.pairs', 'contrast.pairs must contain [foreground, background, positive minimum] tuples'));
    delete config.contrast.pairs;
  }
  for (const role of ['spacing', 'radius', 'type']) {
    const value = config.enforce?.[role];
    if (value != null && !['off', 'warn', 'error', true, false].includes(value)) {
      issues.push(shapeIssue(`enforce.${role}`, `enforce.${role} must be off, warn, error, true, or false`));
      delete config.enforce[role];
    }
  }

  for (const path of ['gates.cssStrict.enabled', 'gates.a11y.enabled', 'gates.visual.enabled', 'gates.bridge.enabled', 'bridge.enabled']) {
    const value = getConfigPath(config, path);
    if (value != null && typeof value !== 'boolean') {
      issues.push(shapeIssue(path, `${path} must be a boolean`));
      deleteConfigPath(config, path);
    }
  }

  if (config.bridge != null) {
    const bridge = config.bridge;
    if (bridge.source != null && (typeof bridge.source !== 'string' || !bridge.source.trim())) {
      issues.push(shapeIssue('bridge.source', 'bridge.source must be a non-empty path string'));
    }
    if (bridge.artifactDir != null && (typeof bridge.artifactDir !== 'string' || !bridge.artifactDir.trim())) {
      issues.push(shapeIssue('bridge.artifactDir', 'bridge.artifactDir must be a non-empty path string'));
    }
    for (const [field, min, max] of [
      ['timeoutMs', 100, 120_000],
      ['maxArtifactBytes', 1_024, 64 * 1024 * 1024],
      ['freshnessMs', 1_000, 365 * 24 * 60 * 60 * 1000],
    ]) {
      const value = bridge[field];
      if (value != null && (!Number.isInteger(value) || value < min || value > max)) {
        issues.push(shapeIssue(`bridge.${field}`, `bridge.${field} must be an integer from ${min} to ${max}`));
      }
    }
    if (Array.isArray(bridge.connections)) {
      if (bridge.connections.length > 100) {
        issues.push(shapeIssue('bridge.connections', 'bridge.connections may contain at most 100 entries'));
      }
      const ids = new Set();
      bridge.connections.forEach((connection, index) => {
        const path = `bridge.connections[${index}]`;
        if (!isObj(connection)) { issues.push(shapeIssue(path, `${path} must be an object`)); return; }
        rejectRuntimeUnknown(connection, BRIDGE_CONNECTION_KEYS, path, issues);
        if (typeof connection.id !== 'string' || connection.id.length > 64
          || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(connection.id)) {
          issues.push(shapeIssue(`${path}.id`, `${path}.id must be a 1-64 character portable identifier`));
        } else if (ids.has(connection.id)) {
          issues.push(shapeIssue(`${path}.id`, `${path}.id must be unique`));
        } else ids.add(connection.id);
        if (typeof connection.adapter !== 'string' || !connection.adapter.trim()) {
          issues.push(shapeIssue(`${path}.adapter`, `${path}.adapter must be a non-empty built-in adapter id`));
        }
        if (connection.role != null && !['source', 'sink', 'both'].includes(connection.role)) {
          issues.push(shapeIssue(`${path}.role`, `${path}.role must be source, sink, or both`));
        }
        for (const field of ['enabled', 'required']) {
          if (connection[field] != null && typeof connection[field] !== 'boolean') {
            issues.push(shapeIssue(`${path}.${field}`, `${path}.${field} must be a boolean`));
          }
        }
        if (connection.trust != null && !['untrusted', 'linked', 'verified'].includes(connection.trust)) {
          issues.push(shapeIssue(`${path}.trust`, `${path}.trust must be untrusted, linked, or verified`));
        }
        for (const field of ['source', 'module']) {
          if (connection[field] != null && (typeof connection[field] !== 'string' || !connection[field].trim())) {
            issues.push(shapeIssue(`${path}.${field}`, `${path}.${field} must be a non-empty string`));
          }
        }
        if (typeof connection.source === 'string' && unsafeCredentialUrl(connection.source)) {
          issues.push(shapeIssue(`${path}.source`, `${path}.source must not contain URL credentials or secret query parameters`));
        }
        if (connection.permissions != null && (!Array.isArray(connection.permissions)
          || !connection.permissions.every((permission) => typeof permission === 'string' && permission.trim())
          || new Set(connection.permissions).size !== connection.permissions.length)) {
          issues.push(shapeIssue(`${path}.permissions`, `${path}.permissions must contain unique non-empty strings`));
        }
        if (connection.options != null && !isObj(connection.options)) {
          issues.push(shapeIssue(`${path}.options`, `${path}.options must be an object`));
        } else if (isObj(connection.options)) {
          const invalidEnv = findInvalidEnvReference(connection.options);
          if (invalidEnv) {
            issues.push(shapeIssue(
              `${path}.options.${invalidEnv}`,
              'environment references must be variable names matching [A-Za-z_][A-Za-z0-9_]* and at most 128 characters',
            ));
          }
          const exposed = findInlineSecret(connection.options);
          if (exposed) {
            issues.push(shapeIssue(`${path}.options.${exposed}`, 'credentials must be referenced by environment-variable name, never stored inline'));
          }
        }
      });
    }
  }

  if (Array.isArray(config.slop?.rules)) {
    config.slop.rules.forEach((rule, index) => {
      const path = `slop.rules[${index}]`;
      if (!isObj(rule)) { issues.push(shapeIssue(path, `${path} must be an object`)); return; }
      rejectRuntimeUnknown(rule, SLOP_RULE_KEYS, path, issues);
      if (typeof rule.id !== 'string' || !rule.id.trim()) issues.push(shapeIssue(`${path}.id`, `${path}.id must be a non-empty string`));
      if (rule.zone != null && !['style', 'all'].includes(rule.zone)) issues.push(shapeIssue(`${path}.zone`, `${path}.zone must be style or all`));
      const hasPattern = typeof rule.pattern === 'string';
      const hasTest = typeof rule.test === 'function';
      if (rule.pattern != null && !hasPattern) {
        issues.push(shapeIssue(`${path}.pattern`, `${path}.pattern must be a string`));
      }
      if (!hasPattern && !hasTest) {
        issues.push(shapeIssue(path, `${path} must provide a string pattern or JavaScript test function`));
      }
      let flagsValid = true;
      if (rule.flags != null && typeof rule.flags !== 'string') {
        flagsValid = false;
        issues.push(shapeIssue(`${path}.flags`, `${path}.flags must be a regular-expression flag string`));
      } else if (typeof rule.flags === 'string') {
        try { new RegExp('', rule.flags); }
        catch (error) {
          flagsValid = false;
          issues.push(shapeIssue(`${path}.flags`, `${path}.flags is not valid: ${error.message}`));
        }
      }
      if (hasPattern && flagsValid) {
        try { new RegExp(rule.pattern, rule.flags ?? 'g'); }
        catch (error) {
          issues.push(shapeIssue(`${path}.pattern`, `${path}.pattern is not a valid regular expression: ${error.message}`));
        }
      }
      if (rule.severity != null && !['error', 'warn', 'info'].includes(rule.severity)) {
        issues.push(shapeIssue(`${path}.severity`, `${path}.severity must be error, warn, or info`));
      }
      for (const field of ['message', 'hint', 'fix']) {
        if (rule[field] != null && typeof rule[field] !== 'string') {
          issues.push(shapeIssue(`${path}.${field}`, `${path}.${field} must be a string`));
        }
      }
    });
  }

  if (isObj(config.allowlist)) {
    for (const [ruleId, globs] of Object.entries(config.allowlist)) {
      if (!Array.isArray(globs) || !globs.every((glob) => typeof glob === 'string' && glob.trim())) {
        issues.push(shapeIssue(`allowlist.${ruleId}`, `allowlist.${ruleId} must be an array of non-empty glob strings`));
        delete config.allowlist[ruleId];
      }
    }
  }

  for (const path of ['severity', 'allowlist', 'report']) {
    const value = config[path];
    if (value != null && !isObj(value)) {
      issues.push(shapeIssue(path, `${path} must be an object`));
      delete config[path];
    }
  }
  if (config.baseline != null && (typeof config.baseline !== 'string' || !config.baseline.trim())) {
    issues.push(shapeIssue('baseline', 'baseline must be a non-empty path string'));
    delete config.baseline;
  }
  return issues;
}

function reportDuplicateBridgeIds(connections, origin, source, issues) {
  const seen = new Map();
  connections.forEach((connection, index) => {
    if (!isObj(connection) || typeof connection.id !== 'string') return;
    if (!seen.has(connection.id)) {
      seen.set(connection.id, index);
      return;
    }
    const first = seen.get(connection.id);
    issues.push({
      path: origin === 'manifest' ? `bridge.source.connections[${index}].id` : `bridge.connections[${index}].id`,
      message: pick(
        `Bridge ${origin} 的 connection.id ${connection.id} 重複（索引 ${first}、${index}）。`,
        `Bridge ${origin} repeats connection.id ${connection.id} at indexes ${first} and ${index}.`,
      ),
      fix: pick('同一來源內每個 connection.id 必須唯一。', 'Make every connection.id unique within the same source.'),
      meta: { bridgeSource: source, duplicateId: connection.id, origin },
    });
  });
}

function rejectRuntimeUnknown(value, allowed, path, issues) {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    const suggestion = nearestConfigKey(key, allowed);
    issues.push({
      path: `${path}.${key}`,
      message: pick(
        `不支援設定鍵 ${path}.${key}${suggestion ? `；是不是要寫 ${path}.${suggestion}？` : '。'}`,
        `Unsupported config key ${path}.${key}${suggestion ? `; did you mean ${path}.${suggestion}?` : '.'}`,
      ),
      fix: pick('修正拼字或移除這個鍵；未知設定不會被靜默忽略。', 'Fix the spelling or remove this key; unknown config is never silently ignored.'),
      meta: { unknownKey: key, suggestion: suggestion ?? null },
    });
  }
}

function shapeIssue(path, english) {
  return {
    path,
    message: pick(`設定 ${path} 的型別或值無效。`, `Invalid config at ${path}: ${english}.`),
    fix: pick('依 dk.schema.json 修正這個設定。', 'Correct this setting according to dk.schema.json.'),
    meta: { shapeIssue: english },
  };
}

function unsafeCredentialUrl(value) {
  return urlCarriesCredentials(value);
}

function findInlineSecret(value, prefix = '') {
  if (typeof value === 'string') return unsafeCredentialUrl(value) ? (prefix || '(value)') : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findInlineSecret(value[index], `${prefix}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isObj(value)) return null;
  for (const [key, nested] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    // `tokenEnv`, `secretEnv`, etc. contain a validated variable name rather
    // than the credential itself. Every other credential-shaped key is fatal.
    if (secretOptionKey(key) && !/env$/i.test(key)) return path;
    if (isObj(nested) || Array.isArray(nested) || typeof nested === 'string') {
      const found = findInlineSecret(nested, path);
      if (found) return found;
    }
  }
  return null;
}

function findInvalidEnvReference(value, prefix = '') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findInvalidEnvReference(value[index], `${prefix}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isObj(value)) return null;
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (/env$/i.test(key)
      && (typeof nested !== 'string' || nested.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(nested))) return path;
    if (isObj(nested) || Array.isArray(nested)) {
      const found = findInvalidEnvReference(nested, path);
      if (found) return found;
    }
  }
  return null;
}

function secretOptionKey(key) {
  return isCredentialKey(key);
}

function configFatalFinding(path, message, fix, meta = {}) {
  return makeFinding({
    ruleId: 'tokens/structure', severity: 'error', file: 'dk.config',
    message, fp: message, fix,
    meta: { configFatal: true, configPath: path, ...meta },
  });
}

function getConfigPath(root, path) {
  return path.split('.').reduce((value, key) => value?.[key], root);
}

function deleteConfigPath(root, path) {
  const parts = path.split('.');
  const key = parts.pop();
  const parent = parts.reduce((value, part) => value?.[part], root);
  if (parent && typeof parent === 'object') delete parent[key];
}

function nearestConfigKey(input, allowed) {
  let best = null;
  let score = Infinity;
  for (const candidate of allowed) {
    const distance = editDistance(input, candidate);
    if (distance < score) { best = candidate; score = distance; }
  }
  const threshold = Math.max(2, Math.ceil(Math.max(input.length, best?.length ?? 0) / 3));
  return best && score <= threshold ? best : null;
}

function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

/** 內建預設 < 選定 preset < 使用者 config。 */
function mergeConfig(user) {
  const presetName = PRESETS[user.preset] ? user.preset : 'recommended';
  const preset = PRESETS[presetName];
  const merged = deepMerge(deepMerge(clone(BASE_DEFAULTS), clone(preset)), clone(user));
  merged.preset = presetName;
  return merged;
}

/** 攤平成關卡好取用的形狀，並把路徑絕對化。 */
function resolveConfig(m, cwd, file, errors) {
  const abs = (p) => (p == null ? null : isAbsolute(p) ? p : resolvePath(cwd, p));
  const tokensPath = abs(m.tokens?.source ?? 'design/tokens.json');
  const output = {};
  for (const [k, v] of Object.entries(m.tokens?.output ?? {})) output[k] = abs(v);

  // 自訂 slop 規則：合併 preset/config 的宣告式與程式式規則。
  const slopRules = (m.slop?.rules ?? []).map(normalizeSlopRule);

  const bridgeSourcePath = abs(m.bridge?.source ?? 'design/bridge.json');
  const bridgeArtifactDir = abs(m.bridge?.artifactDir ?? '.dk/bridge');
  for (const [field, value] of [['source', bridgeSourcePath], ['artifactDir', bridgeArtifactDir]]) {
    if (!isInside(cwd, value) || (existsSync(value) && !isInside(realpathSync(cwd), realpathSync(value)))) {
      errors.push(configFatalFinding(`bridge.${field}`,
        `bridge.${field} must stay inside the repository`,
        `Use a repository-relative path such as ${field === 'source' ? 'design/bridge.json' : '.dk/bridge'}.`));
    }
  }

  return {
    cwd,
    configFile: file ? relative(cwd, file) : null,
    presetName: m.preset,
    tokensPath,
    directionPath: abs(m.direction?.source ?? 'design/direction.json'),
    directionLockPath: abs(m.direction?.lock ?? 'design/direction.lock.json'),
    directionRequired: m.direction?.required === true,
    output,
    formats: Object.keys(output),
    targets: m.targets ?? BASE_DEFAULTS.targets,
    // 保護性 ignore 永遠附加：預設報告與 tokens.output.* 不得被掃回來源集合。
    // 使用者可覆蓋一般 ignore，但不能移除這些由 dk 自己產生的落點。
    ignore: mergeProtectiveIgnore(m.ignore ?? BASE_DEFAULTS.ignore, m),
    failOn: m.failOn ?? 'error',
    failOnSkipped: m.failOnSkipped ?? false,
    requiredTokens: m.tokens_required ?? [],
    contrast: {
      algorithm: m.contrast?.algorithm ?? 'wcag',
      modes: m.contrast?.modes ?? ['light', 'dark'],
      pairs: m.contrast?.pairs ?? [],
    },
    enforce: {
      spacing: normLevel(m.enforce?.spacing),
      radius: normLevel(m.enforce?.radius),
      type: normLevel(m.enforce?.type),
    },
    slopRules,
    fonts: { allow: m.slop?.fonts?.allow ?? [], deny: m.slop?.fonts?.deny ?? [] },
    severity: m.severity ?? {},
    allowlist: m.allowlist ?? {},
    baselinePath: abs(m.baseline ?? '.dk/baseline.json'),
    gates: m.gates ?? BASE_DEFAULTS.gates,
    bridge: {
      enabled: m.bridge?.enabled === true,
      sourcePath: bridgeSourcePath,
      artifactDir: bridgeArtifactDir,
      timeoutMs: m.bridge?.timeoutMs ?? 30_000,
      maxArtifactBytes: m.bridge?.maxArtifactBytes ?? 2 * 1024 * 1024,
      freshnessMs: m.bridge?.freshnessMs ?? 24 * 60 * 60 * 1000,
      connections: (m.bridge?.connections ?? []).map((connection) => ({
        role: 'source', enabled: true, required: false, trust: 'linked',
        permissions: [], options: {}, ...connection,
        ...(connection.module && { module: abs(connection.module) }),
      })),
    },
    // Keep the public declarative shape; a11yGate/runner normalize it at their
    // own trust boundaries and CLI overrides can layer on top without mutation.
    proof: m.proof ?? null,
    report: m.report ?? {},
    errors,
  };
}

function isInside(root, target) {
  const rel = relative(resolvePath(root), resolvePath(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/* 保護性 ignore：dk 產物落點恆附加（合併去重），不受使用者 ignore 覆蓋語意影響。
   ── dk-report.html：`dk verify --html` 的預設落點。
   ── tokens.output.*（如 styles/tokens.css）：宣告的建構輸出——由 dk 生成、不該被掃回。
   相對化為 repo-root 相對 glob；落在 root 外者略過（不列 ignore）。 */
function mergeProtectiveIgnore(userIgnore, m) {
  const protective = ['dk-report.html'];
  for (const out of Object.values(m.tokens?.output ?? {})) {
    if (typeof out === 'string' && out.trim() && !isAbsolute(out) && !out.startsWith('..')) {
      protective.push(out.split('\\').join('/'));
    }
  }
  const out = [...(userIgnore ?? [])];
  for (const p of protective) if (!out.includes(p)) out.push(p);
  return out;
}

// enforce 值規範化：true -> 'warn'；'error'/'warn' 原樣；其餘（含 false/undefined）-> 'off'。
function normLevel(v) {
  if (v === true) return 'warn';
  if (v === 'error' || v === 'warn') return v;
  return 'off';
}

function normalizeSlopRule(r) {
  const out = { ...r };
  if (typeof r.pattern === 'string') {
    try { out.regex = new RegExp(r.pattern, r.flags ?? 'g'); }
    catch { out.regex = null; out._patternError = r.pattern; }
  }
  out.severity = r.severity ?? 'warn';
  out.zone = r.zone ?? 'style';
  return out;
}

/* ---- 小工具 ---- */
function clone(o) { return JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'function' ? undefined : v))); }
function isObj(o) { return o && typeof o === 'object' && !Array.isArray(o); }
function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

// clone 會丟掉函式（自訂規則的 test）。為了保住 .mjs 的程式式規則，
// 我們在 merge 後把使用者原始的 slop.rules 直接接回（不經 clone）。
export function preserveFunctions(resolved, rawUser) {
  const userRules = rawUser?.slop?.rules;
  if (Array.isArray(userRules)) {
    // 以 id 對齊，把原始 test 函式接回 normalize 後的規則。
    const byId = new Map(userRules.map((r) => [r.id, r]));
    for (const r of resolved.slopRules) {
      const orig = byId.get(r.id);
      if (orig && typeof orig.test === 'function') r.test = orig.test;
    }
  }
  return resolved;
}

/** 供外部判斷 tokens 檔存在性（doctor / friendly errors）。 */
export function tokensExist(config) {
  try { return statSync(config.tokensPath).isFile(); } catch { return false; }
}
