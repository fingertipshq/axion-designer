import { createHash } from 'node:crypto';
import { INTELLIGENCE_CATALOG } from './catalog.mjs';

export const INTELLIGENCE_CATALOG_SCHEMA = 'axion-design-intelligence-catalog/v1';
export const INTELLIGENCE_RECOMMENDATION_SCHEMA = 'axion-design-recommendation/v1';
export const INTELLIGENCE_NORMALIZED_BRIEF_SCHEMA = 'axion-normalized-design-brief/v1';
export const INTELLIGENCE_DOMAINS = Object.freeze([...INTELLIGENCE_CATALOG.domains]);
export const INTELLIGENCE_STACKS = Object.freeze(Object.keys(INTELLIGENCE_CATALOG.stacks));

const MAX_BRIEF_CHARS = 4_000;
const OPTION_KEYS = new Set(['stack', 'density', 'motion', 'contrast', 'variance']);
const ENUMS = Object.freeze({
  density: ['compact', 'balanced', 'airy'],
  motion: ['none', 'subtle', 'expressive'],
  contrast: ['standard', 'high'],
});
const STACK_ALIASES = Object.freeze({
  reactjs: 'react', 'react.js': 'react', nextjs: 'next', 'next.js': 'next',
  vuejs: 'vue', 'vue.js': 'vue', nuxtjs: 'nuxt', 'nuxt.js': 'nuxt',
  sveltekit: 'svelte', 'svelte-kit': 'svelte', astrojs: 'astro',
  html: 'html-tailwind', tailwind: 'html-tailwind', 'html+tailwind': 'html-tailwind',
  'shadcn/ui': 'shadcn', 'shadcn-ui': 'shadcn',
});
const AUDIENCE_SIGNALS = Object.freeze([
  ['designer', ['designer', 'design team', '設計師', '設計團隊']],
  ['developer', ['developer', 'engineer', 'frontend', 'coder', '工程師', '前端', '開發者']],
  ['operator', ['operator', 'analyst', 'manager', 'admin', '營運', '分析師', '管理者', '後台使用者']],
  ['customer', ['customer', 'buyer', 'shopper', 'client', '客戶', '買家', '消費者']],
  ['reader', ['reader', 'learner', 'student', '讀者', '學習者', '學生']],
]);

export class DesignIntelligenceError extends Error {
  constructor(message, code = 'DK_INTELLIGENCE') {
    super(message);
    this.name = 'DesignIntelligenceError';
    this.code = code;
  }
}

/** Return an isolated copy so callers cannot mutate process-wide knowledge. */
export function loadIntelligenceCatalog() {
  return clone(INTELLIGENCE_CATALOG);
}

export function normalizeDesignBrief(brief, options = {}) {
  const text = normalizeText(brief);
  const controls = normalizeOptions(options);
  const sourceTokens = tokenize(text);
  const vocabulary = catalogVocabulary();
  const corrections = [];
  const tokens = sourceTokens.map((token) => {
    if (vocabulary.has(token) || /\p{Script=Han}/u.test(token) || token.length < 5) return token;
    const correction = nearest(token, vocabulary);
    if (correction && correction !== token) corrections.push({ from: token, to: correction, distance: editDistance(token, correction) });
    return correction ?? token;
  });
  const searchable = `${text.toLowerCase()} ${tokens.join(' ')}`;
  const intentMatches = INTELLIGENCE_CATALOG.intents
    .map((intent) => ({
      id: intent.id,
      hits: intent.signals.filter((signal) => searchable.includes(signal.toLowerCase())),
      task: intent.task,
      statePriority: intent.statePriority,
    }))
    .filter((entry) => entry.hits.length)
    .sort((a, b) => b.hits.length - a.hits.length || a.id.localeCompare(b.id));
  const audience = AUDIENCE_SIGNALS
    .map(([id, signals]) => ({ id, hits: signals.filter((signal) => searchable.includes(signal)) }))
    .filter((entry) => entry.hits.length)
    .sort((a, b) => b.hits.length - a.hits.length || a.id.localeCompare(b.id))[0]?.id ?? null;
  const primary = intentMatches[0] ?? null;
  const score = confidenceScore(text, tokens, primary, audience);
  const confidence = {
    score,
    level: score >= 0.78 ? 'high' : score >= 0.55 ? 'medium' : 'low',
    reasons: [
      ...(primary ? [`recognized ${primary.id} from ${primary.hits.join(', ')}`] : ['no product intent was recognized']),
      ...(audience ? [`recognized ${audience} audience`] : ['audience is not explicit']),
      ...(corrections.length ? [`corrected ${corrections.length} likely typo(s)`] : []),
    ],
  };
  return {
    schema: INTELLIGENCE_NORMALIZED_BRIEF_SCHEMA,
    source: text,
    language: detectLanguage(text),
    tokens,
    corrections,
    intent: primary?.id ?? null,
    intentCandidates: intentMatches.map((entry) => ({ id: entry.id, signals: entry.hits })),
    audience,
    primaryTask: primary?.task ?? null,
    statePriority: primary?.statePriority ?? [],
    controls,
    confidence,
  };
}

export function recommendDesignDirections(brief, options = {}) {
  const normalizedIntent = normalizeDesignBrief(brief, options);
  const warnings = buildWarnings(normalizedIntent);
  const base = {
    schema: INTELLIGENCE_RECOMMENDATION_SCHEMA,
    status: normalizedIntent.confidence.level === 'low' ? 'needs-clarification' : 'ready',
    briefDigest: sha256(normalizedIntent.source),
    normalizedIntent,
    confidence: normalizedIntent.confidence,
    warnings,
    constraints: {
      ...normalizedIntent.controls,
      implementation: [...INTELLIGENCE_CATALOG.stacks[normalizedIntent.controls.stack]],
    },
    matches: buildDomainMatches(normalizedIntent),
    provenance: {
      catalogSchema: INTELLIGENCE_CATALOG_SCHEMA,
      catalogVersion: INTELLIGENCE_CATALOG.version,
      corpus: 'Axion original relationship corpus',
      domains: [...INTELLIGENCE_DOMAINS],
      externalAssetsOrCode: false,
    },
  };
  if (base.status !== 'ready') return { ...base, directions: [] };
  const kernels = selectKernels(normalizedIntent);
  const directions = kernels.map((kernel, index) => buildDirection(kernel, normalizedIntent, index));
  assertDistinctDirections(directions);
  return { ...base, directions };
}

function normalizeText(value) {
  if (typeof value !== 'string') throw new DesignIntelligenceError('brief must be a string', 'DK_INTELLIGENCE_BRIEF');
  const text = value.normalize('NFKC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) throw new DesignIntelligenceError('brief must not be empty', 'DK_INTELLIGENCE_BRIEF');
  if (text.length > MAX_BRIEF_CHARS) throw new DesignIntelligenceError(`brief exceeds ${MAX_BRIEF_CHARS} characters`, 'DK_INTELLIGENCE_BRIEF');
  return text;
}

function normalizeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new DesignIntelligenceError('options must be an object', 'DK_INTELLIGENCE_OPTIONS');
  const unknown = Object.keys(options).filter((key) => !OPTION_KEYS.has(key));
  if (unknown.length) throw new DesignIntelligenceError(`unknown intelligence option(s): ${unknown.join(', ')}`, 'DK_INTELLIGENCE_OPTIONS');
  const rawStack = String(options.stack ?? 'react').trim().toLowerCase();
  const stack = STACK_ALIASES[rawStack] ?? rawStack;
  if (!INTELLIGENCE_STACKS.includes(stack)) throw new DesignIntelligenceError(`unsupported stack: ${rawStack}`, 'DK_INTELLIGENCE_STACK');
  const controls = { stack };
  for (const [key, allowed] of Object.entries(ENUMS)) {
    const value = String(options[key] ?? { density: 'balanced', motion: 'subtle', contrast: 'standard' }[key]).toLowerCase();
    if (!allowed.includes(value)) throw new DesignIntelligenceError(`${key} must be one of: ${allowed.join(', ')}`, 'DK_INTELLIGENCE_OPTIONS');
    controls[key] = value;
  }
  const variance = options.variance == null ? 55 : Number(options.variance);
  if (!Number.isFinite(variance) || variance < 0 || variance > 100) throw new DesignIntelligenceError('variance must be between 0 and 100', 'DK_INTELLIGENCE_OPTIONS');
  controls.variance = Math.round(variance);
  return controls;
}

function tokenize(text) {
  return [...text.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}._+/-]*/gu)].map((match) => match[0]).slice(0, 256);
}

function catalogVocabulary() {
  const set = new Set(INTELLIGENCE_STACKS);
  for (const intent of INTELLIGENCE_CATALOG.intents) {
    for (const signal of intent.signals) if (/^[a-z][a-z -]+$/i.test(signal)) for (const token of signal.split(' ')) set.add(token);
  }
  for (const [, signals] of AUDIENCE_SIGNALS) for (const signal of signals) if (/^[a-z][a-z -]+$/i.test(signal)) for (const token of signal.split(' ')) set.add(token);
  return set;
}

function nearest(token, vocabulary) {
  let best = null;
  let distance = Infinity;
  for (const candidate of vocabulary) {
    if (Math.abs(candidate.length - token.length) > 2 || candidate.length < 4) continue;
    const current = editDistance(token, candidate);
    const limit = token.length >= 9 ? 2 : 1;
    if (current <= limit && (current < distance || (current === distance && candidate < best))) {
      best = candidate;
      distance = current;
    }
  }
  return best;
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const diagonal = previous;
      previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return row[b.length];
}

function confidenceScore(text, tokens, primary, audience) {
  let score = 0.16;
  if (primary) score += Math.min(0.42, 0.24 + primary.hits.length * 0.08);
  if (audience) score += 0.13;
  if (tokens.length >= 8) score += 0.12;
  if (/(?:for|to|so that|because|給|用來|希望|主要|目標|任務)/i.test(text)) score += 0.1;
  return Math.min(0.99, Math.round(score * 100) / 100);
}

function detectLanguage(text) {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (han && latin) return 'mixed';
  return han ? 'zh' : 'en';
}

function buildWarnings(normalized) {
  const warnings = [];
  if (!normalized.intent) warnings.push({ code: 'intent-missing', message: 'State the product type or primary workflow before choosing a direction.' });
  if (!normalized.audience) warnings.push({ code: 'audience-missing', message: 'Name the primary user so density and language can be judged.' });
  if (!normalized.primaryTask) warnings.push({ code: 'task-missing', message: 'Name the decision or action the interface must help complete.' });
  if (normalized.confidence.level === 'low') warnings.push({ code: 'no-generic-fallback', message: 'Axion withheld generic recipes because the brief is under-specified.' });
  return warnings;
}

function buildDomainMatches(normalized) {
  const intent = normalized.intent ?? 'unresolved';
  const controls = normalized.controls;
  return {
    product: [{ ruleId: `product/${intent}`, reason: normalized.primaryTask ?? 'product task unresolved' }],
    style: [{ ruleId: `style/variance-${controls.variance}`, reason: 'variation changes structure and signature, not palette alone' }],
    color: [{ ruleId: `color/contrast-${controls.contrast}`, reason: 'semantic allocation and text contrast remain explicit' }],
    typography: [{ ruleId: 'typography/role-contrast', reason: 'display, body, label, and numeric roles stay distinct' }],
    layout: [{ ruleId: `layout/density-${controls.density}`, reason: 'task order and responsive priority precede decoration' }],
    motion: [{ ruleId: `motion/${controls.motion}`, reason: 'motion communicates change and respects reduced motion' }],
    icons: [{ ruleId: 'icons/meaning-before-style', reason: 'labels remain when an icon is not universally understood' }],
    charts: [{ ruleId: 'charts/direct-label-and-unit', reason: 'charts declare units, comparison, and action' }],
    ux: [{ ruleId: `ux/states-${intent}`, reason: `state coverage follows the ${intent} job` }],
  };
}

function selectKernels(normalized) {
  const preferred = {
    operations: ['precision-grid', 'signal-console', 'editorial-ledger'],
    commerce: ['catalog-stage', 'editorial-ledger', 'precision-grid'],
    editor: ['calm-workbench', 'signal-console', 'spatial-chapters'],
    knowledge: ['editorial-ledger', 'calm-workbench', 'precision-grid'],
    marketing: ['spatial-chapters', 'editorial-ledger', 'catalog-stage'],
    portfolio: ['spatial-chapters', 'editorial-ledger', 'calm-workbench'],
  }[normalized.intent] ?? [];
  const rotation = normalized.controls.variance >= 75 ? 1 : normalized.controls.variance <= 25 ? -1 : 0;
  const ids = rotation === 1 ? [preferred[1], preferred[2], preferred[0]]
    : rotation === -1 ? [preferred[0], preferred[2], preferred[1]] : preferred;
  return ids.map((id) => INTELLIGENCE_CATALOG.kernels.find((kernel) => kernel.id === id));
}

function buildDirection(kernel, normalized, index) {
  const intent = INTELLIGENCE_CATALOG.intents.find((entry) => entry.id === normalized.intent);
  const densityRhythms = {
    compact: ['tight and persistent', 'tight with narrative pauses', 'tight with one isolated focus zone'],
    balanced: ['compact evidence with balanced work zones', 'measured bands with dense evidence', 'balanced modules around a spacious focus zone'],
    airy: ['spacious groups with compact controls', 'large chapter transitions with bounded evidence', 'one expansive focus zone with collapsible detail'],
  }[normalized.controls.density];
  const motionRules = {
    none: ['instant state changes', 'persistent focus and status', 'no decorative transform'],
    subtle: ['120–180ms state feedback', 'opacity or 4px translation only', 'reduced-motion removes transforms'],
    expressive: ['one 240–320ms signature transition', '120–180ms utility feedback', 'reduced-motion preserves meaning without transforms'],
  }[normalized.controls.motion];
  const palette = normalized.controls.contrast === 'high' ? strengthenPalette(kernel.palette) : kernel.palette;
  return {
    id: `${normalized.intent}-${kernel.id}`,
    name: kernel.name,
    thesis: `${kernel.name} turns the ${normalized.intent} job into ${kernel.macro}.`,
    why: `It protects the primary task — ${intent.task} — while giving direction ${index + 1} a different focal order and signature.`,
    recipe: {
      macrostructure: kernel.macro,
      focalOrder: [...kernel.focal],
      typography: { roles: [...kernel.type], rule: 'Use at most three families/voices; body readability outranks display character.' },
      density: { requested: normalized.controls.density, rhythm: densityRhythms[index], disclosure: kernel.density[index] },
      geometry: { language: [...kernel.geometry], rule: 'Reserve the strongest shape for selection or the primary action.' },
      color: { tokens: { ...palette }, allocation: 'background 70–85%, surface 10–25%, accent under 8%; semantic states are separate tokens' },
      motion: { requested: normalized.controls.motion, rules: motionRules },
      icons: { style: index === 1 ? 'outlined with selective filled state' : index === 2 ? 'compact technical glyphs' : 'simple stroke icons', rule: 'Pair unfamiliar icons with persistent labels.' },
      charts: { stance: kernel.chart, rule: 'Declare unit, time range, comparison, and empty/error behavior.' },
      ux: { states: [...intent.statePriority], responsive: 'Preserve task order; collapse context after the action, never shrink the desktop composition.' },
      signature: kernel.signature,
    },
    stackPlan: [...INTELLIGENCE_CATALOG.stacks[normalized.controls.stack]],
    tradeoff: kernel.tradeoff,
    antiGoals: ['no interchangeable card grid', 'no invented product claims or metrics', 'no palette-only differentiation'],
    provenance: INTELLIGENCE_DOMAINS.map((domain) => ({ domain, ruleIds: buildDomainMatches(normalized)[domain].map((match) => match.ruleId) })),
  };
}

function strengthenPalette(palette) {
  const dark = palette.background.startsWith('#1') || palette.background.startsWith('#0');
  return dark ? { ...palette, text: '#FFFFFF', muted: '#C2CDD5', border: '#52616D' }
    : { ...palette, background: '#FFFFFF', text: '#111827', muted: '#4B5563', border: '#AAB4C0' };
}

function assertDistinctDirections(directions) {
  if (directions.length !== 3) throw new DesignIntelligenceError('ready recommendations must contain exactly three directions', 'DK_INTELLIGENCE_INVARIANT');
  for (const field of ['macrostructure', 'signature']) {
    if (new Set(directions.map((direction) => direction.recipe[field])).size !== 3) {
      throw new DesignIntelligenceError(`directions are not distinct in ${field}`, 'DK_INTELLIGENCE_INVARIANT');
    }
  }
  if (new Set(directions.map((direction) => direction.recipe.color.tokens.accent)).size !== 3) {
    throw new DesignIntelligenceError('directions are not distinct in color allocation', 'DK_INTELLIGENCE_INVARIANT');
  }
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

