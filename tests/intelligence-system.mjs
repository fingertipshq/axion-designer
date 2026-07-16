import assert from 'node:assert/strict';
import {
  INTELLIGENCE_DOMAINS,
  INTELLIGENCE_STACKS,
  loadIntelligenceCatalog,
  normalizeDesignBrief,
  recommendDesignDirections,
} from '../src/intelligence/index.mjs';

assert.deepEqual(INTELLIGENCE_DOMAINS, ['product', 'style', 'color', 'typography', 'layout', 'motion', 'icons', 'charts', 'ux']);
assert.deepEqual(INTELLIGENCE_STACKS, ['react', 'next', 'vue', 'nuxt', 'svelte', 'astro', 'html-tailwind', 'shadcn']);

const catalogA = loadIntelligenceCatalog();
const catalogB = loadIntelligenceCatalog();
catalogA.domains.push('mutated');
assert.equal(catalogB.domains.includes('mutated'), false, 'catalog callers receive isolated copies');

const normalized = normalizeDesignBrief('給分析師用的財務儀表板，主要用表格和圖表監控風險並決策', {
  stack: 'Next.js', density: 'compact', motion: 'subtle', contrast: 'high', variance: 80,
});
assert.equal(normalized.intent, 'operations');
assert.equal(normalized.audience, 'operator');
assert.equal(normalized.controls.stack, 'next');
assert.equal(normalized.language, 'zh');

const typo = normalizeDesignBrief('A dashbaord for developer analytics workflow and monitoring', { stack: 'react' });
assert(typo.corrections.some((entry) => entry.from === 'dashbaord' && entry.to === 'dashboard'));
assert.equal(typo.intent, 'operations');

const brief = 'Build a dashboard for operations analysts to monitor incidents, compare trends, filter a table, and resolve workflow exceptions.';
const first = recommendDesignDirections(brief, { stack: 'shadcn/ui', density: 'balanced', motion: 'subtle', contrast: 'standard', variance: 55 });
const second = recommendDesignDirections(brief, { stack: 'shadcn/ui', density: 'balanced', motion: 'subtle', contrast: 'standard', variance: 55 });
assert.deepEqual(first, second, 'same brief and controls are byte-stable deterministic JSON');
assert.equal(first.schema, 'axion-design-recommendation/v1');
assert.equal(first.status, 'ready');
assert.equal(first.directions.length, 3);
assert.equal(first.constraints.stack, 'shadcn');
assert.equal(new Set(first.directions.map((entry) => entry.recipe.macrostructure)).size, 3);
assert.equal(new Set(first.directions.map((entry) => entry.recipe.signature)).size, 3);
assert.equal(new Set(first.directions.map((entry) => entry.recipe.color.tokens.accent)).size, 3);
for (const direction of first.directions) {
  assert.deepEqual(direction.provenance.map((entry) => entry.domain), INTELLIGENCE_DOMAINS);
  assert.equal(direction.stackPlan.length, 3);
  assert(direction.recipe.ux.states.includes('loading'));
}
assert.deepEqual(Object.keys(first.matches), INTELLIGENCE_DOMAINS);

const unclear = recommendDesignDirections('Make it nice', { stack: 'react' });
assert.equal(unclear.status, 'needs-clarification');
assert.deepEqual(unclear.directions, [], 'low confidence never silently returns generic recipes');
assert(unclear.warnings.some((entry) => entry.code === 'no-generic-fallback'));

for (const stack of INTELLIGENCE_STACKS) {
  const result = recommendDesignDirections('A product dashboard for operators to monitor workflow status and act on errors', { stack });
  assert.equal(result.status, 'ready');
  assert.equal(result.constraints.stack, stack);
  assert(result.constraints.implementation.length >= 3);
}

assert.throws(() => normalizeDesignBrief('dashboard', { __proto__: null, unknown: 'x' }), /unknown intelligence option/);
assert.throws(() => normalizeDesignBrief('dashboard', { stack: '../../evil' }), /unsupported stack/);
assert.throws(() => normalizeDesignBrief('x'.repeat(4_001)), /exceeds 4000/);
assert.throws(() => normalizeDesignBrief('\0\0'), /must not be empty/);
assert.throws(() => normalizeDesignBrief('dashboard', { variance: Infinity }), /between 0 and 100/);

process.stdout.write('intelligence-system: 9-domain offline recommendations, normalization, no-generic fallback, stack constraints, determinism and input safety passed\n');
