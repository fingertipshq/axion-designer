/* ============================================================
   App Proof plan — 真實 Web app 的可重現驗證矩陣。

   這個模組刻意保持零瀏覽器依賴：
     · config / CLI override 正規化與 fail-closed 驗證；
     · route × state × viewport × theme 矩陣展開；
     · 給 Playwright runner 與未來 Studio/CLI 共用的穩定資料形狀。

   任意 JavaScript evaluate 不屬於 declarative state contract。互動只允許
   一組有界 Playwright actions，讓 config 可審查、可序列化，也不會把驗證
   設定變成隱藏的程式執行入口。
   ============================================================ */

import { createHash } from 'node:crypto';
import { normalizeA11yTags } from '../core/a11y-tags.mjs';

const DEFAULT_VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1440, height: 900 },
];
const DEFAULT_THEMES = ['light', 'dark'];
const ACTION_TYPES = new Set(['click', 'fill', 'check', 'uncheck', 'select', 'press', 'waitFor']);
const WAIT_STATES = new Set(['attached', 'detached', 'visible', 'hidden']);
const COLOR_SCHEMES = new Set(['light', 'dark', 'no-preference']);
const PROOF_KEYS = new Set(['baseUrl', 'routes', 'states', 'viewports', 'themes', 'timeoutMs', 'maxRoutes', 'maxCases']);
const ROUTE_KEYS = new Set(['name', 'path', 'waitFor', 'states']);
const STATE_KEYS = new Set(['name', 'actions', 'waitFor']);
const ACTION_KEYS = new Set(['type', 'selector', 'value', 'key', 'state', 'timeoutMs']);
const VIEWPORT_KEYS = new Set(['name', 'width', 'height']);
const THEME_KEYS = new Set(['name', 'colorScheme', 'attributes', 'classes']);

export class AppProofConfigError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [String(issues)];
    super(`Invalid app proof configuration:\n- ${list.join('\n- ')}`);
    this.name = 'AppProofConfigError';
    this.code = 'DK_PROOF_CONFIG';
    this.issues = list;
  }
}

/**
 * Validate and normalize a top-level `proof` config.
 * @param {unknown} input
 */
export function normalizeAppProofConfig(input) {
  const issues = [];
  if (!isRecord(input)) {
    throw new AppProofConfigError(['proof must be an object']);
  }
  rejectUnknown(input, PROOF_KEYS, 'proof', issues);

  const baseUrl = normalizeBaseUrl(input.baseUrl, issues);
  const timeoutMs = boundedInt(input.timeoutMs, 15_000, 1_000, 120_000, 'proof.timeoutMs', issues);
  const maxRoutes = boundedInt(input.maxRoutes, 50, 1, 200, 'proof.maxRoutes', issues);
  const maxCases = boundedInt(input.maxCases, 200, 1, 2_000, 'proof.maxCases', issues);
  const states = normalizeStates(input.states ?? ['default'], 'proof.states', issues);
  const viewports = normalizeViewports(input.viewports ?? DEFAULT_VIEWPORTS, issues);
  const themes = normalizeThemes(input.themes ?? DEFAULT_THEMES, issues);
  const routes = normalizeRoutes(input.routes ?? ['/'], baseUrl, 'proof.routes', issues);

  if (issues.length) throw new AppProofConfigError(issues);
  const normalized = { baseUrl, routes, states, viewports, themes, timeoutMs, maxRoutes, maxCases };

  // Static route plans can be bounded before a browser starts. Auto discovery is
  // checked again after the concrete same-origin route set is known.
  if (routes !== 'auto') assertMatrixBound(normalized, routes);
  return normalized;
}

/** Return human-readable issues without throwing (for config validation UIs). */
export function validateAppProofConfig(input) {
  try { normalizeAppProofConfig(input); return []; }
  catch (error) {
    if (error instanceof AppProofConfigError) return [...error.issues];
    return [String(error?.message ?? error)];
  }
}

/**
 * Expand the complete verification matrix. Auto-discovery plans must provide
 * the concrete routes returned by `normalizeDiscoveredRoutes`.
 */
export function buildAppProofMatrix(plan, concreteRoutes) {
  const routes = concreteRoutes ?? plan.routes;
  if (routes === 'auto') {
    throw new AppProofConfigError(['proof.routes="auto" must be discovered in a browser before building the matrix']);
  }
  if (!Array.isArray(routes) || !routes.length) {
    throw new AppProofConfigError(['proof route matrix is empty']);
  }
  assertMatrixBound(plan, routes);

  const cases = [];
  for (const route of routes) {
    const states = route.states ?? plan.states;
    for (const state of states) {
      for (const viewport of plan.viewports) {
        for (const theme of plan.themes) {
          const matrix = {
            route: route.name,
            state: state.name,
            viewport: viewport.name,
            theme: theme.name,
          };
          const label = appProofTargetLabel(route, state, viewport, theme);
          cases.push({
            id: appProofCaseId(matrix), label, url: route.url,
            route, state, viewport, theme, matrix,
          });
        }
      }
    }
  }
  return cases;
}

/** Normalize same-origin URLs found by the runner's link crawler. */
export function normalizeDiscoveredRoutes(plan, hrefs) {
  if (!plan?.baseUrl) throw new AppProofConfigError(['proof.baseUrl is required for route discovery']);
  const base = new URL(plan.baseUrl);
  const unique = new Map();
  // The entry URL is always covered, including SPAs with no anchors.
  unique.set(canonicalUrl(base), routeFromUrl(base, base));
  for (const raw of hrefs ?? []) {
    let url;
    try { url = new URL(String(raw), base); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin) continue;
    url.hash = '';
    unique.set(canonicalUrl(url), routeFromUrl(url, base));
  }
  const routes = [...unique.values()].sort((a, b) => a.url.localeCompare(b.url));
  const usedNames = new Set();
  for (const route of routes) {
    if (usedNames.has(route.name)) {
      route.name = `${route.name}-${createHash('sha256').update(route.url).digest('hex').slice(0, 8)}`;
    }
    usedNames.add(route.name);
  }
  if (routes.length > plan.maxRoutes) {
    throw new AppProofConfigError([
      `auto route discovery found ${routes.length} same-origin routes, exceeding proof.maxRoutes=${plan.maxRoutes}; raise the explicit limit or list routes intentionally`,
    ]);
  }
  assertMatrixBound(plan, routes);
  return routes;
}

/**
 * Small, side-effect-free integration helper for CLI surfaces. It understands
 * `--app <url>` and `--routes auto|/one,/two`; callers remain responsible for
 * declaring those flags in their command parser.
 */
export function applyAppProofCliOverrides(config, flags = {}) {
  if (flags.app == null && flags.routes == null) return config;
  if (flags.app === true || flags.routes === true) {
    throw new AppProofConfigError(['--app and --routes require values']);
  }
  const current = isRecord(config?.proof) ? config.proof : {};
  const proof = { ...current };
  if (flags.app != null) proof.baseUrl = String(flags.app);
  if (flags.routes != null) proof.routes = parseRoutesFlag(flags.routes);
  // Validate before the CLI starts the expensive ledger/browser path, but keep
  // the declarative public shape on ResolvedConfig rather than leaking internals.
  normalizeAppProofConfig(proof);
  return { ...config, proof };
}

export function appProofTargetLabel(route, state, viewport, theme) {
  let path = route.path || '/';
  try {
    const u = new URL(route.url);
    path = `${u.pathname}${u.search}` || '/';
  } catch { /* route.path is already display-safe data */ }
  return `app:${path} [state=${state.name}, viewport=${viewport.name}, theme=${theme.name}]`;
}

function parseRoutesFlag(value) {
  const text = String(value).trim();
  if (!text) throw new AppProofConfigError(['--routes cannot be empty']);
  if (text === 'auto') return 'auto';
  const routes = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (!routes.length) throw new AppProofConfigError(['--routes must be "auto" or a comma-separated route list']);
  return routes;
}

function normalizeBaseUrl(value, issues) {
  if (value == null || String(value).trim() === '') {
    issues.push('proof.baseUrl is required and must be an http(s) URL');
    return null;
  }
  let url;
  try { url = new URL(String(value)); }
  catch { issues.push('proof.baseUrl must be a valid absolute URL'); return null; }
  if (!['http:', 'https:'].includes(url.protocol)) issues.push('proof.baseUrl must use http: or https:');
  if (url.username || url.password) issues.push('proof.baseUrl must not contain credentials');
  url.hash = '';
  return url.href;
}

function normalizeRoutes(value, baseUrl, at, issues) {
  if (value === 'auto') return 'auto';
  if (!Array.isArray(value) || !value.length) {
    issues.push(`${at} must be "auto" or a non-empty array`);
    return [];
  }
  const out = [];
  const names = new Set();
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    const here = `${at}[${i}]`;
    const obj = typeof raw === 'string' ? { path: raw } : raw;
    if (!isRecord(obj)) { issues.push(`${here} must be a route string or object`); continue; }
    rejectUnknown(obj, ROUTE_KEYS, here, issues);
    if (typeof obj.path !== 'string' || !obj.path.trim()) { issues.push(`${here}.path must be a non-empty string`); continue; }
    let url = null;
    try {
      url = baseUrl ? new URL(obj.path, baseUrl) : new URL(obj.path);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
      if (baseUrl && url.origin !== new URL(baseUrl).origin) {
        issues.push(`${here}.path must remain on the proof.baseUrl origin`);
      }
      url.hash = '';
    } catch {
      if (baseUrl) issues.push(`${here}.path is not a valid route URL`);
      else issues.push(`${here}.path cannot be resolved without a valid proof.baseUrl`);
    }
    const name = obj.name == null ? displayRouteName(obj.path) : obj.name;
    if (typeof name !== 'string' || !name.trim()) issues.push(`${here}.name must be a non-empty string`);
    const cleanName = String(name || `route-${i}`).trim();
    if (names.has(cleanName)) issues.push(`${here}.name duplicates another route: ${cleanName}`);
    names.add(cleanName);
    const waitFor = optionalSelector(obj.waitFor, `${here}.waitFor`, issues);
    const states = obj.states == null ? null : normalizeStates(obj.states, `${here}.states`, issues);
    out.push({ name: cleanName, path: obj.path, url: url?.href ?? obj.path, waitFor, states });
  }
  return out;
}

function normalizeStates(value, at, issues) {
  if (!Array.isArray(value) || !value.length) { issues.push(`${at} must be a non-empty array`); return []; }
  const out = [];
  const names = new Set();
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    const here = `${at}[${i}]`;
    if (typeof raw === 'string') {
      if (raw !== 'default') {
        issues.push(`${here} may only be the string "default"; named states require a declarative action object`);
        continue;
      }
      if (names.has('default')) issues.push(`${here} duplicates state "default"`);
      names.add('default'); out.push({ name: 'default', actions: [], waitFor: null }); continue;
    }
    if (!isRecord(raw)) { issues.push(`${here} must be "default" or a state object`); continue; }
    rejectUnknown(raw, STATE_KEYS, here, issues);
    if (typeof raw.name !== 'string' || !raw.name.trim()) { issues.push(`${here}.name must be a non-empty string`); continue; }
    const name = raw.name.trim();
    if (names.has(name)) issues.push(`${here}.name duplicates another state: ${name}`);
    names.add(name);
    const actions = normalizeActions(raw.actions ?? [], `${here}.actions`, issues);
    const waitFor = optionalSelector(raw.waitFor, `${here}.waitFor`, issues);
    if (name !== 'default' && !actions.length && !waitFor) {
      issues.push(`${here} must declare actions or waitFor; otherwise state "${name}" cannot be proven`);
    }
    out.push({ name, actions, waitFor });
  }
  return out;
}

function normalizeActions(value, at, issues) {
  if (!Array.isArray(value)) { issues.push(`${at} must be an array`); return []; }
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    const here = `${at}[${i}]`;
    if (!isRecord(raw)) { issues.push(`${here} must be an action object`); continue; }
    rejectUnknown(raw, ACTION_KEYS, here, issues);
    if (!ACTION_TYPES.has(raw.type)) { issues.push(`${here}.type must be one of ${[...ACTION_TYPES].join(', ')}`); continue; }
    const selector = optionalSelector(raw.selector, `${here}.selector`, issues);
    if (!selector) issues.push(`${here}.selector is required for ${raw.type}`);
    const action = { type: raw.type, selector };
    if (raw.type === 'fill') {
      if (typeof raw.value !== 'string') issues.push(`${here}.value must be a string for fill`);
      else action.value = raw.value;
    } else if (raw.type === 'select') {
      if (!(typeof raw.value === 'string' || (Array.isArray(raw.value) && raw.value.length && raw.value.every((v) => typeof v === 'string')))) {
        issues.push(`${here}.value must be a string or non-empty string array for select`);
      } else action.value = raw.value;
    } else if (raw.type === 'press') {
      if (typeof raw.key !== 'string' || !raw.key.trim()) issues.push(`${here}.key must be a non-empty string for press`);
      else action.key = raw.key;
    } else if (raw.type === 'waitFor') {
      if (raw.state != null && !WAIT_STATES.has(raw.state)) issues.push(`${here}.state must be attached, detached, visible, or hidden`);
      action.state = raw.state ?? 'visible';
    }
    if (raw.timeoutMs != null) action.timeoutMs = boundedInt(raw.timeoutMs, null, 100, 120_000, `${here}.timeoutMs`, issues);
    out.push(action);
  }
  return out;
}

function normalizeViewports(value, issues) {
  if (!Array.isArray(value) || !value.length) { issues.push('proof.viewports must be a non-empty array'); return []; }
  const out = [], names = new Set();
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    const here = `proof.viewports[${i}]`;
    const obj = Number.isInteger(raw) ? { width: raw, height: 900, name: `w${raw}` } : raw;
    if (!isRecord(obj)) { issues.push(`${here} must be an integer width or viewport object`); continue; }
    rejectUnknown(obj, VIEWPORT_KEYS, here, issues);
    const width = boundedInt(obj.width, null, 240, 7_680, `${here}.width`, issues);
    const height = boundedInt(obj.height, null, 240, 4_320, `${here}.height`, issues);
    const name = obj.name == null ? `${width}x${height}` : obj.name;
    if (typeof name !== 'string' || !name.trim()) issues.push(`${here}.name must be a non-empty string`);
    const cleanName = String(name || `viewport-${i}`).trim();
    if (names.has(cleanName)) issues.push(`${here}.name duplicates another viewport: ${cleanName}`);
    names.add(cleanName);
    out.push({ name: cleanName, width, height });
  }
  return out;
}

function normalizeThemes(value, issues) {
  if (!Array.isArray(value) || !value.length) { issues.push('proof.themes must be a non-empty array'); return []; }
  const out = [], names = new Set();
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    const here = `proof.themes[${i}]`;
    const obj = typeof raw === 'string'
      ? { name: raw, colorScheme: COLOR_SCHEMES.has(raw) ? raw : 'no-preference', attributes: { 'data-theme': raw }, classes: [raw] }
      : raw;
    if (!isRecord(obj)) { issues.push(`${here} must be a theme name or object`); continue; }
    rejectUnknown(obj, THEME_KEYS, here, issues);
    if (typeof obj.name !== 'string' || !obj.name.trim()) { issues.push(`${here}.name must be a non-empty string`); continue; }
    const name = obj.name.trim();
    if (names.has(name)) issues.push(`${here}.name duplicates another theme: ${name}`);
    names.add(name);
    const colorScheme = obj.colorScheme ?? (COLOR_SCHEMES.has(name) ? name : 'no-preference');
    if (!COLOR_SCHEMES.has(colorScheme)) issues.push(`${here}.colorScheme must be light, dark, or no-preference`);
    const attributes = normalizeStringRecord(obj.attributes ?? { 'data-theme': name }, `${here}.attributes`, issues);
    const classes = obj.classes ?? [name];
    if (!Array.isArray(classes) || !classes.every((v) => typeof v === 'string' && v.trim() && !/\s/.test(v))) {
      issues.push(`${here}.classes must be an array of non-empty class tokens without whitespace`);
    }
    out.push({ name, colorScheme, attributes, classes: Array.isArray(classes) ? classes.map((v) => String(v).trim()).filter(Boolean) : [] });
  }
  return out;
}

function normalizeStringRecord(value, at, issues) {
  if (!isRecord(value)) { issues.push(`${at} must be an object of string values`); return {}; }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (!key.trim() || !/^[^\s"'<>\/=]+$/.test(key) || /^on/i.test(key) || key.toLowerCase() === 'srcdoc') {
      issues.push(`${at}.${key || '(empty)'} is not a safe HTML attribute name`);
    } else if (typeof val !== 'string') issues.push(`${at}.${key} must be a string`);
    else out[key] = val;
  }
  return out;
}

function optionalSelector(value, at, issues) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim()) { issues.push(`${at} must be a non-empty selector string`); return null; }
  if (value.length > 2_048) { issues.push(`${at} exceeds 2048 characters`); return null; }
  return value.trim();
}

function boundedInt(value, fallback, min, max, at, issues) {
  if (value == null && fallback != null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    issues.push(`${at} must be an integer from ${min} to ${max}`);
    return fallback ?? min;
  }
  return value;
}

function assertMatrixBound(plan, routes) {
  let cases = 0;
  for (const route of routes) cases += (route.states ?? plan.states).length * plan.viewports.length * plan.themes.length;
  if (cases > plan.maxCases) {
    throw new AppProofConfigError([
      `proof matrix expands to ${cases} cases, exceeding proof.maxCases=${plan.maxCases}; reduce the matrix or raise the explicit limit`,
    ]);
  }
}

function routeFromUrl(url, base) {
  const path = `${url.pathname}${url.search}` || '/';
  return { name: displayRouteName(path), path, url: url.href, waitFor: null, states: null };
}
function displayRouteName(path) {
  const text = String(path).trim();
  if (text === '/' || !text) return 'home';
  return text.replace(/^\//, '').replace(/[/?#=&]+/g, '-').replace(/^-|-$/g, '') || 'home';
}
function canonicalUrl(url) { const next = new URL(url); next.hash = ''; return next.href; }
export function appProofCaseId(matrix) {
  const dimensions = ['route', 'state', 'viewport', 'theme'].map((key) => String(matrix?.[key] ?? ''));
  return `case_${createHash('sha256').update(JSON.stringify(dimensions)).digest('hex').slice(0, 24)}`;
}
export function appProofConfigHash(plan, tags = []) {
  return createHash('sha256').update(stableStringify({
    proof: plan,
    tags: normalizeA11yTags(tags, 'tags'),
  })).digest('hex');
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function rejectUnknown(value, allowed, at, issues) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${at}.${key} is not supported`);
}
function isRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
