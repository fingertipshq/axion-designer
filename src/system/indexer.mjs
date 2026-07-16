/* ============================================================
   Axion System Graph — repository component / story / token index.

   The indexer is deliberately dependency-free. It is not an AST compiler;
   it builds a conservative, source-backed graph from common Web conventions
   and keeps every inference labelled with its file/line evidence.

   Public surface:
     indexRepository(root, options) -> dk-system-graph/v1 JSON
     discoverProofSurfaces(root, options) -> route/state proof summary

   Direct use:
     node src/system/indexer.mjs [root] [--out graph.json]
   ============================================================ */
import {
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { appProofCaseId } from '../proof/app-proof.mjs';
import { safeWriteFileSync } from '../core/safe-write.mjs';

export const SYSTEM_GRAPH_SCHEMA = 'dk-system-graph/v1';
export const PROOF_SURFACES_SCHEMA = 'dk-proof-surfaces/v1';

const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.vue', '.svelte', '.astro', '.html', '.htm',
  '.css', '.scss', '.less', '.json',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const COMPONENT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro']);
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.less']);
const HARD_IGNORES = new Set([
  'node_modules', '.git', '.dk', '.next', '.nuxt', '.svelte-kit',
  'dist', 'build', 'coverage', '.cache', '.turbo', '.vercel',
]);
const GENERATED_ROOTS = new Set(['output']);
const GENERATED_FILES = new Set(['dk-report.html', 'axion-p3-benchmark.html']);
const DEFAULT_MAX_FILES = 6000;
const DEFAULT_MAX_BYTES = 768 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Build a machine-readable repository graph.
 * @param {string} root
 * @param {{maxFiles?:number,maxBytes?:number,maxTotalBytes?:number,now?:string|Date,tokensPath?:string|string[],includeGenerated?:boolean}} options
 */
export function indexRepository(root = process.cwd(), options = {}) {
  const cwd = resolvePath(root);
  const warnings = [];
  const files = collectRepositoryFiles(cwd, options, warnings);
  const sourceRecords = [];
  const imageFiles = [];
  const fileSet = new Set(files.map((file) => file.path));

  for (const file of files) {
    if (file.binary) {
      imageFiles.push(file.path);
      continue;
    }
    try {
      sourceRecords.push({ ...file, source: readFileSync(join(cwd, file.path), 'utf8') });
    } catch (error) {
      warnings.push({ kind: 'read', file: file.path, message: error.message });
    }
  }

  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const edgeIds = new Set();
  const componentsByFile = new Map();
  const componentsByName = new Map();
  const stylesByFile = new Map();
  const recordByFile = new Map(sourceRecords.map((record) => [record.path, record]));

  const addNode = (node) => {
    if (!node?.id || nodeIds.has(node.id)) return node?.id ?? null;
    nodeIds.add(node.id);
    nodes.push(node);
    return node.id;
  };
  const addEdge = (edge) => {
    if (!edge?.from || !edge?.to || edge.from === edge.to) return;
    const id = edge.id ?? `${edge.type}:${edge.from}->${edge.to}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, ...edge });
  };

  // Pass 1: define source-backed components and stylesheets.
  for (const record of sourceRecords) {
    const ext = extname(record.path).toLowerCase();
    if (STYLE_EXTENSIONS.has(ext)) {
      const id = `stylesheet:${record.path}`;
      addNode({
        id, kind: 'stylesheet', label: basename(record.path), file: record.path, line: 1,
        evidence: 'stylesheet source', meta: {},
      });
      stylesByFile.set(record.path, [id]);
    }
    if (!COMPONENT_EXTENSIONS.has(ext) || isStoryFile(record.path) || isTestFile(record.path)) continue;
    const defs = discoverComponents(record.path, record.source);
    const ids = [];
    for (const def of defs) {
      const id = `component:${record.path}#${def.name}`;
      addNode({
        id, kind: 'component', label: def.name, file: record.path, line: def.line,
        evidence: def.evidence,
        meta: { framework: frameworkFor(record.path, record.source), export: def.exportKind },
      });
      ids.push(id);
      const bucket = componentsByName.get(def.name) ?? [];
      bucket.push(id);
      componentsByName.set(def.name, bucket);
    }
    if (ids.length) componentsByFile.set(record.path, ids);
  }

  // Pass 2: stories and their state variants.
  for (const record of sourceRecords.filter((item) => isStoryFile(item.path))) {
    const story = discoverStories(record.path, record.source);
    const storyIds = [];
    for (const item of story.exports.length ? story.exports : [{ name: basename(record.path).split('.')[0], line: 1 }]) {
      const id = `story:${record.path}#${item.name}`;
      addNode({
        id, kind: 'story', label: item.name, file: record.path, line: item.line,
        evidence: story.title ? `Storybook ${story.title}` : 'story module export',
        meta: { title: story.title, state: normalizeState(item.name) },
      });
      storyIds.push(id);
    }
    const target = resolveComponentReference(record.path, story.component, record.source, fileSet, componentsByFile, componentsByName);
    if (target) for (const storyId of storyIds) addEdge({ type: 'storyFor', from: storyId, to: target, evidence: story.component });
  }

  // Pass 3: tokens from DTCG-ish JSON and CSS custom properties.
  const tokenInfo = indexTokens(cwd, sourceRecords, options, warnings, addNode, addEdge);

  // Pass 4: imports, JSX/SFC component use, and token consumption.
  for (const record of sourceRecords) {
    if (isStoryFile(record.path)) continue;
    const owners = componentsByFile.get(record.path) ?? stylesByFile.get(record.path) ?? [];
    if (!owners.length) continue;

    for (const imported of discoverImports(record.source)) {
      const targetFile = resolveImportPath(record.path, imported.specifier, fileSet);
      if (!targetFile) continue;
      const targets = componentsByFile.get(targetFile) ?? [];
      for (const owner of owners) {
        for (const target of targets) addEdge({ type: 'imports', from: owner, to: target, evidence: imported.specifier });
      }
    }

    const usedNames = discoverComponentUses(record.source);
    for (const name of usedNames) {
      const target = chooseComponent(componentsByName.get(name), record.path);
      if (!target) continue;
      for (const owner of owners) addEdge({ type: 'uses', from: owner, to: target, evidence: `<${name}>` });
    }

    const usedVars = discoverCssVariableUses(record.source);
    for (const cssVar of usedVars) {
      const target = tokenInfo.byCssVar.get(cssVar);
      if (!target) continue;
      for (const owner of owners) addEdge({ type: 'tokenUses', from: owner, to: target, evidence: `var(${cssVar})` });
    }
  }

  // Pass 5: routes and proof edges.
  const proof = buildProofSurfaces(cwd, sourceRecords, imageFiles);
  for (const route of proof.routes) {
    const id = `route:${route.route}`;
    addNode({
      id, kind: 'route', label: route.route, file: route.file, line: route.line ?? 1,
      evidence: route.evidence,
      meta: {
        status: route.status,
        states: route.states,
        viewports: route.viewports,
        themes: route.themes,
        proofCount: route.proof.length,
        sources: route.sources,
      },
    });
    for (const source of route.sources ?? [{ file: route.file, evidence: route.evidence }]) {
      const localComponents = componentsByFile.get(source.file) ?? [];
      for (const component of localComponents) addEdge({ type: 'renders', from: id, to: component, evidence: source.evidence });
      const record = recordByFile.get(source.file);
      if (record) {
        for (const imported of discoverImports(record.source)) {
          const targetFile = resolveImportPath(record.path, imported.specifier, fileSet);
          for (const component of componentsByFile.get(targetFile) ?? []) {
            addEdge({ type: 'renders', from: id, to: component, evidence: imported.specifier });
          }
        }
      }
    }
  }

  nodes.sort(compareNodes);
  edges.sort((a, b) => a.id.localeCompare(b.id));

  const stats = countKinds(nodes, edges, sourceRecords.length, imageFiles.length);
  return {
    schema: SYSTEM_GRAPH_SCHEMA,
    generatedAt: normalizeNow(options.now),
    root: cwd,
    stats,
    nodes,
    edges,
    proof,
    warnings,
  };
}

/** Return route/state/browser evidence without consumers having to parse graph nodes. */
export function discoverProofSurfaces(root = process.cwd(), options = {}) {
  const graph = indexRepository(root, options);
  return graph.proof;
}

/** Persist an already-built graph as deterministic JSON (except generatedAt). */
export function writeSystemGraph(graph, outputPath, options = {}) {
  const root = resolvePath(options.root ?? process.cwd());
  const target = resolvePath(root, outputPath);
  safeWriteFileSync(root, target, `${JSON.stringify(graph, null, 2)}\n`, { encoding: 'utf8' });
  return target;
}

function collectRepositoryFiles(root, options, warnings) {
  const maxFiles = finitePositive(options.maxFiles, DEFAULT_MAX_FILES);
  const maxBytes = finitePositive(options.maxBytes, DEFAULT_MAX_BYTES);
  const maxTotalBytes = finitePositive(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  const result = [];
  let truncated = false;
  let totalSourceBytes = 0;
  let byteTruncated = false;

  function walk(absDir, relDir = '') {
    if (result.length >= maxFiles) { truncated = true; return; }
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); }
    catch (error) {
      warnings.push({ kind: 'walk', file: slash(relDir || '.'), message: error.message });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= maxFiles) { truncated = true; return; }
      const rel = slash(join(relDir, entry.name));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (HARD_IGNORES.has(entry.name)) continue;
        walk(join(absDir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      const generated = GENERATED_ROOTS.has(rel.split('/')[0]) || GENERATED_FILES.has(rel);
      const binary = IMAGE_EXTENSIONS.has(ext);
      if (generated && !options.includeGenerated && !binary) continue;
      if (!SOURCE_EXTENSIONS.has(ext) && !binary) continue;
      let stat;
      try { stat = statSync(join(absDir, entry.name)); } catch { continue; }
      if (!binary && stat.size > maxBytes) {
        warnings.push({ kind: 'size', file: rel, message: `Skipped ${stat.size} byte source (limit ${maxBytes}).` });
        continue;
      }
      if (!binary && totalSourceBytes + stat.size > maxTotalBytes) {
        byteTruncated = true;
        continue;
      }
      if (!binary) totalSourceBytes += stat.size;
      result.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs, binary });
    }
  }

  walk(root);
  if (truncated) warnings.push({ kind: 'limit', file: null, message: `Repository scan stopped at ${maxFiles} files.` });
  if (byteTruncated) warnings.push({
    kind: 'total-size', file: null,
    message: `Repository source scan was capped at ${maxTotalBytes} total bytes (${totalSourceBytes} bytes indexed).`,
  });
  return result;
}

function discoverComponents(path, source) {
  const ext = extname(path).toLowerCase();
  const defs = [];
  const seen = new Set();
  const add = (name, index, evidence, exportKind = 'local') => {
    if (!name || !/^[A-Z][A-Za-z0-9_$]*$/.test(name) || seen.has(name)) return;
    seen.add(name);
    defs.push({ name, line: lineAt(source, index), evidence, exportKind });
  };

  const patterns = [
    [/export\s+default\s+(?:async\s+)?function\s+([A-Z][\w$]*)/g, 'default function', 'default'],
    [/export\s+(?:async\s+)?function\s+([A-Z][\w$]*)/g, 'exported function', 'named'],
    [/export\s+class\s+([A-Z][\w$]*)/g, 'exported class', 'named'],
    [/export\s+(?:const|let|var)\s+([A-Z][\w$]*)\s*=/g, 'exported binding', 'named'],
    [/(?:^|\n)\s*(?:async\s+)?function\s+([A-Z][\w$]*)\s*\(/g, 'component-like function', 'local'],
    [/(?:^|\n)\s*(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*(?:\([^)]*\)|[\w$]+)\s*=>/g, 'component-like binding', 'local'],
  ];
  for (const [regex, evidence, exportKind] of patterns) {
    let match;
    while ((match = regex.exec(source))) add(match[1], match.index, evidence, exportKind);
  }

  const base = basename(path, ext);
  if (['.vue', '.svelte', '.astro'].includes(ext) && /^[A-Za-z][\w$-]*$/.test(base)) {
    const name = pascalCase(base);
    add(name, 0, `${ext.slice(1)} single-file component`, 'default');
  }

  let custom;
  const customElement = /customElements\.define\(\s*['"]([^'"]+)['"]\s*,\s*([A-Z][\w$]*)/g;
  while ((custom = customElement.exec(source))) add(custom[2], custom.index, `custom element <${custom[1]}>`, 'custom-element');

  return defs.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

function discoverStories(path, source) {
  const title = source.match(/\btitle\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
  const component = source.match(/\bcomponent\s*:\s*([A-Z][\w$]*)/)?.[1] ?? null;
  const exports = [];
  const regex = /export\s+(?:const|let|var|function)\s+([A-Z][\w$]*)/g;
  let match;
  while ((match = regex.exec(source))) exports.push({ name: match[1], line: lineAt(source, match.index) });
  return { path, title, component, exports };
}

function indexTokens(root, records, options, warnings, addNode, addEdge) {
  const byCssVar = new Map();
  const byDotPath = new Map();
  const configured = new Set(
    (Array.isArray(options.tokensPath) ? options.tokensPath : options.tokensPath ? [options.tokensPath] : [])
      .map((item) => slash(relative(root, resolvePath(root, item)))),
  );
  const candidates = records.filter((record) => {
    if (extname(record.path).toLowerCase() !== '.json') return false;
    const lower = basename(record.path).toLowerCase();
    return configured.has(record.path) || /(^|[-_.])tokens?([-_.]|$)/.test(lower) || record.path === 'design/tokens.json';
  });

  for (const record of candidates) {
    let json;
    try { json = JSON.parse(record.source); }
    catch (error) {
      warnings.push({ kind: 'tokens', file: record.path, message: `Invalid token JSON: ${error.message}` });
      continue;
    }
    walkTokenLeaves(json, [], (path, leaf) => {
      const dotPath = path.join('.');
      const cssVar = `--${path.join('-')}`;
      const id = `token:${dotPath}`;
      const value = leaf.$value;
      addNode({
        id, kind: 'token', label: dotPath, file: record.path,
        line: findTokenLine(record.source, path.at(-1)), evidence: 'DTCG token leaf',
        meta: {
          dotPath, cssVar, value: displayTokenValue(value),
          dark: displayTokenValue(leaf.$extensions?.modes?.dark),
          type: leaf.$type ?? inferTokenType(dotPath, value),
        },
      });
      byDotPath.set(dotPath, id);
      byCssVar.set(cssVar, id);
    });
  }

  // CSS variables not represented by the DTCG source remain useful graph nodes.
  for (const record of records.filter((item) => STYLE_EXTENSIONS.has(extname(item.path).toLowerCase()))) {
    const regex = /(^|[;{]\s*|\n\s*)(--[A-Za-z0-9_-]+)\s*:\s*([^;}{]+)/g;
    let match;
    while ((match = regex.exec(record.source))) {
      const cssVar = match[2];
      if (byCssVar.has(cssVar)) continue;
      const id = `token:css:${cssVar}`;
      addNode({
        id, kind: 'token', label: cssVar, file: record.path, line: lineAt(record.source, match.index),
        evidence: 'CSS custom property', meta: { cssVar, value: match[3].trim(), type: inferTokenType(cssVar, match[3]) },
      });
      byCssVar.set(cssVar, id);
    }
  }

  // Resolve aliases after every token node exists, including forward aliases.
  for (const record of candidates) {
    let json;
    try { json = JSON.parse(record.source); } catch { continue; }
    walkTokenLeaves(json, [], (path, leaf) => {
      const alias = aliasPath(leaf.$value);
      const from = byDotPath.get(path.join('.'));
      const to = alias ? byDotPath.get(alias) : null;
      if (from && to) addEdge({ type: 'aliases', from, to, evidence: `{${alias}}` });
    });
  }

  return { byCssVar, byDotPath };
}

function buildProofSurfaces(root, records, imageFiles) {
  const routeMap = new Map();
  const testEvidence = [];
  const globalStates = new Set();

  const addRoute = (route, file, line, evidence) => {
    if (!route || !file) return;
    const normalized = normalizeRoute(route);
    const source = { file, line: line ?? 1, evidence };
    const current = routeMap.get(normalized);
    if (current) {
      if (!current.sources.some((item) => item.file === file && item.evidence === evidence)) current.sources.push(source);
      return current;
    }
    const created = {
      route: normalized, file, line: line ?? 1, evidence, sources: [source],
      states: [], viewports: [], themes: [], proof: [], status: 'discovered',
    };
    routeMap.set(normalized, created);
    return created;
  };

  for (const record of records) {
    if (!isNonProductSurface(record.path)) {
      for (const route of inferFileRoutes(record.path)) addRoute(route, record.path, 1, 'file-system route');
    }
    if (!isTestFile(record.path)) {
      const jsxRoutes = /<Route\b[^>]*\bpath\s*=\s*['"]([^'"]+)['"]/g;
      let match;
      while ((match = jsxRoutes.exec(record.source))) addRoute(match[1], record.path, lineAt(record.source, match.index), 'route declaration');
      if (/createBrowserRouter|createRoutesFromElements|\b(?:app)?routes\s*=|new\s+Router/i.test(record.source)) {
        const objectRoutes = /\bpath\s*:\s*['"]([^'"]+)['"]/g;
        while ((match = objectRoutes.exec(record.source))) addRoute(match[1], record.path, lineAt(record.source, match.index), 'route declaration');
      }
      continue;
    }

    const tests = [...record.source.matchAll(/\b(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/g)];
    const gotos = [...record.source.matchAll(/\bpage\.goto\s*\(\s*['"`]([^'"`]+)['"`]/g)];
    const screenshots = [...record.source.matchAll(/\b(?:screenshot|toHaveScreenshot)\s*\(\s*(?:['"`]([^'"`]+)['"`])?/g)];
    const viewports = discoverViewports(record.source);
    const states = new Set();
    for (const test of tests) for (const state of statesFromText(test[1])) { states.add(state); globalStates.add(state); }
    const routeValues = gotos.map((item) => urlToRoute(item[1])).filter(Boolean);
    testEvidence.push({
      file: record.path,
      tests: tests.map((item) => item[1]),
      routes: routeValues,
      states: [...states].sort(),
      viewports,
      screenshots: screenshots.map((item) => item[1]).filter(Boolean),
    });
  }

  // Ensure browser-tested routes are visible even if no route source file was inferred.
  for (const evidence of testEvidence) {
    for (const route of evidence.routes) addRoute(route, evidence.file, 1, 'browser test navigation');
  }

  const evidenceImages = imageFiles.filter(isEvidenceScreenshot);
  for (const route of routeMap.values()) {
    const direct = testEvidence.filter((evidence) =>
      evidence.routes.includes(route.route)
      || (!evidence.routes.length && evidence.file === route.file));
    const states = new Set();
    const viewports = new Set();
    const proof = [];
    for (const evidence of direct) {
      evidence.states.forEach((state) => states.add(state));
      evidence.viewports.forEach((viewport) => viewports.add(viewport));
      proof.push({
        kind: 'declared-browser-test', verification: 'unexecuted', file: evidence.file,
        labels: evidence.tests, screenshots: evidence.screenshots,
      });
    }
    const slug = route.route === '/' ? 'index' : route.route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    for (const image of evidenceImages) {
      const lower = image.toLowerCase();
      if (slug && (lower.includes(slug.toLowerCase()) || (slug === 'index' && /(?:final|desktop|mobile)/.test(lower)))) {
        proof.push({ kind: 'screenshot-file', verification: 'unverified', file: image });
        if (lower.includes('mobile')) viewports.add('mobile');
        if (lower.includes('tablet')) viewports.add('tablet');
        if (lower.includes('desktop')) viewports.add('desktop');
        for (const state of statesFromText(lower)) states.add(state);
      }
    }
    route.states = [...states].sort();
    route.viewports = [...viewports].sort();
    route.proof = proof;
    route.status = proof.length ? 'evidence-linked' : 'discovered';
  }

  // Only a current, complete App Proof artifact with one concrete successful
  // result for every planned case upgrades a route to `proven`. Test source,
  // screenshots, and filenames remain useful leads but never assert execution.
  const trusted = readTrustedAppProof(root, records);
  if (trusted.status === 'complete') {
    for (const result of trusted.results) {
      const routeName = urlToRoute(result.url);
      if (!routeName) continue;
      const route = addRoute(routeName, trusted.path, 1, 'complete App Proof artifact');
      const state = result.matrix.state;
      const viewport = result.matrix.viewport;
      const theme = result.matrix.theme;
      if (state && !route.states.includes(state)) route.states.push(state);
      if (viewport && !route.viewports.includes(viewport)) route.viewports.push(viewport);
      if (theme && !route.themes.includes(theme)) route.themes.push(theme);
      route.proof.push({
        kind: 'app-proof-case', verification: 'successful', file: trusted.path,
        id: result.id, matrix: result.matrix, url: result.url,
      });
      route.status = 'proven';
    }
  }

  const storyStates = records
    .filter((record) => isStoryFile(record.path))
    .flatMap((record) => discoverStories(record.path, record.source).exports.map((item) => ({
      component: discoverStories(record.path, record.source).component,
      story: item.name,
      state: normalizeState(item.name),
      file: record.path,
    })));

  const routes = [...routeMap.values()];
  for (const route of routes) {
    route.sources.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    route.states.sort();
    route.viewports.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    route.themes.sort();
  }
  routes.sort((a, b) => a.route.localeCompare(b.route));
  return {
    schema: PROOF_SURFACES_SCHEMA,
    routes,
    storyStates,
    tests: testEvidence,
    appProof: {
      status: trusted.status,
      path: trusted.path,
      reason: trusted.reason ?? null,
      caseCount: trusted.results?.length ?? 0,
      finishedAt: trusted.finishedAt ?? null,
      configHash: trusted.configHash ?? null,
    },
    summary: {
      routeCount: routes.length,
      provenRoutes: routes.filter((route) => route.status === 'proven').length,
      evidenceLinkedRoutes: routes.filter((route) => route.status === 'evidence-linked').length,
      provenCases: trusted.status === 'complete' ? trusted.results.length : 0,
      states: [...new Set([
        ...globalStates,
        ...storyStates.map((item) => item.state).filter(Boolean),
        ...routes.flatMap((route) => route.states ?? []),
      ])].sort(),
      themes: [...new Set(routes.flatMap((route) => route.themes ?? []))].sort(),
      screenshotCount: evidenceImages.length,
      testFileCount: testEvidence.length,
    },
  };
}

function readTrustedAppProof(root, records) {
  const path = '.dk/proof/app-proof.json';
  const absolute = join(root, path);
  if (!existsSync(absolute)) return { status: 'missing', path, results: [], reason: 'No App Proof artifact exists.' };
  let artifact;
  try { artifact = JSON.parse(readBoundedProjectText(root, absolute)); }
  catch (error) { return { status: 'invalid', path, results: [], reason: `Invalid App Proof JSON: ${error.message}` }; }
  const coverage = artifact?.coverage;
  const results = Array.isArray(artifact?.results) ? artifact.results : [];
  const planned = coverage?.plannedCases;
  const completed = coverage?.completedCases;
  const failed = coverage?.failedCases;
  const screenshotCases = coverage?.screenshotCases;
  const dimensions = ['route', 'state', 'viewport', 'theme'];
  const caseIds = new Set();
  const matrixKeys = new Set();
  const usedTokens = new Set();
  let violationCount = 0;
  let concrete = results.length > 0;
  for (const result of results) {
    const matrixValid = result?.matrix && dimensions.every((key) => typeof result.matrix[key] === 'string' && result.matrix[key]);
    const matrixKey = matrixValid ? JSON.stringify(dimensions.map((key) => result.matrix[key])) : null;
    const tokensValid = Array.isArray(result?.usedTokens)
      && result.usedTokens.every((token) => /^--[A-Za-z0-9_-]+$/.test(token));
    const resultValid = typeof result?.id === 'string' && result.id === appProofCaseId(result.matrix)
      && !caseIds.has(result.id)
      && matrixValid && !matrixKeys.has(matrixKey)
      && typeof result.target === 'string' && result.target
      && typeof result.url === 'string' && urlToRoute(result.url)
      && result.error == null && Array.isArray(result.violations)
      && tokensValid && trustedScreenshotMatches(root, result);
    if (!resultValid) concrete = false;
    if (typeof result?.id === 'string') caseIds.add(result.id);
    if (matrixKey != null) matrixKeys.add(matrixKey);
    if (tokensValid) for (const token of result.usedTokens) usedTokens.add(token);
    if (Array.isArray(result?.violations)) violationCount += result.violations.length;
  }
  const declaredTokens = artifact?.usedTokens;
  const tokenUnionMatches = Array.isArray(declaredTokens)
    && new Set(declaredTokens).size === declaredTokens.length
    && declaredTokens.every((token) => /^--[A-Za-z0-9_-]+$/.test(token))
    && JSON.stringify([...declaredTokens].sort()) === JSON.stringify([...usedTokens].sort());
  if (artifact?.schemaVersion !== 2
      || artifact?.kind !== 'axion-app-proof' || artifact?.coverageStatus !== 'complete'
      || !/^[a-f0-9]{64}$/i.test(artifact?.configHash ?? '')
      || !Number.isInteger(planned) || planned <= 0
      || !Number.isInteger(completed) || !Number.isInteger(failed) || !Number.isInteger(screenshotCases)
      || completed !== planned || failed !== 0 || screenshotCases !== completed
      || results.length !== planned || caseIds.size !== results.length || matrixKeys.size !== results.length
      || !concrete || !tokenUnionMatches) {
    return {
      status: 'invalid', path, results: [], finishedAt: artifact?.finishedAt ?? null,
      reason: 'Artifact is not schema v2 complete proof with a unique hashed case, durable screenshot, and exact runtime-token union for every planned case.',
    };
  }
  const summary = artifact?.summary;
  if (!summary || summary.cases !== planned || summary.failed !== 0
      || !Number.isInteger(summary.violations) || summary.violations !== violationCount
      || artifact.qualityStatus !== (violationCount ? 'violations' : 'clean')) {
    return {
      status: 'invalid', path, results: [], finishedAt: artifact?.finishedAt ?? null,
      reason: 'The App Proof quality status, violation count, or summary contradicts its concrete case results.',
    };
  }
  if (violationCount > 0) {
    return {
      status: 'quality-failed', path, results: [], finishedAt: artifact?.finishedAt ?? null,
      reason: `App Proof executed every case but found ${violationCount} accessibility violation${violationCount === 1 ? '' : 's'}.`,
    };
  }
  const ledgerPath = join(root, '.dk', 'report.json');
  let ledger;
  try { ledger = JSON.parse(readBoundedProjectText(root, ledgerPath)); }
  catch (error) { return { status: 'unattested', path, results: [], finishedAt: artifact.finishedAt ?? null, reason: `The evidence ledger cannot attest this artifact: ${error.message}` }; }
  const attested = ledger?.emits?.appProofCoverage;
  const a11yRan = Array.isArray(ledger?.gates) && ledger.gates.some((gate) => gate?.id === 'a11y' && gate?.status === 'ran');
  const coverageMatches = attested
    && attested.plannedCases === planned
    && attested.completedCases === completed
    && attested.failedCases === failed
    && attested.screenshotCases === screenshotCases;
  if (ledger?.emits?.appProofArtifact !== path
      || ledger?.emits?.appProofConfigHash !== artifact.configHash
      || !coverageMatches || !a11yRan) {
    return { status: 'unattested', path, results: [], finishedAt: artifact.finishedAt ?? null, reason: 'The ledger artifact path, config hash, coverage counters, or a11y gate does not match App Proof.' };
  }
  if (ledger?.status !== 'passed' || ledger?.exitCode !== 0 || ledger?.counts?.error !== 0) {
    return {
      status: 'quality-failed', path, results: [], finishedAt: artifact.finishedAt ?? null,
      reason: 'The evidence ledger that attests this App Proof did not pass with zero errors.',
    };
  }
  const finishedAt = Date.parse(artifact.finishedAt ?? '');
  const ledgerAt = Date.parse(ledger.generatedAt ?? '');
  if (!Number.isFinite(finishedAt) || !Number.isFinite(ledgerAt) || ledgerAt < finishedAt) {
    return { status: 'unattested', path, results: [], finishedAt: artifact.finishedAt ?? null, reason: 'The ledger timestamp does not postdate the completed App Proof run.' };
  }
  let proofMtime = 0;
  try { proofMtime = statSync(absolute).mtimeMs; } catch { /* read already succeeded */ }
  let ledgerMtime = 0;
  try { ledgerMtime = statSync(ledgerPath).mtimeMs; } catch { /* parsed above */ }
  if (ledgerMtime + 1 < proofMtime) {
    return { status: 'unattested', path, results: [], finishedAt: artifact.finishedAt ?? null, reason: 'The ledger predates the App Proof artifact on disk.' };
  }
  const newestSource = records.reduce((latest, record) => Math.max(latest, record.mtimeMs ?? 0), 0);
  if (proofMtime + 1 < newestSource) {
    return { status: 'stale', path, results: [], finishedAt: artifact.finishedAt ?? null, reason: 'Source changed after the App Proof artifact was written.' };
  }
  return { status: 'complete', path, results, finishedAt: artifact.finishedAt ?? null, configHash: artifact.configHash };
}

function readBoundedProjectText(root, path, maxBytes = 8 * 1024 * 1024) {
  const absoluteRoot = resolvePath(root);
  const absolute = resolvePath(path);
  if (!isInside(absoluteRoot, absolute)) throw new Error('artifact path escapes the project root');
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error('symbolic-link proof artifacts are not trusted');
  if (!stat.isFile()) throw new Error('proof artifact is not a regular file');
  if (stat.size > maxBytes) throw new Error(`proof artifact exceeds ${maxBytes} bytes`);
  const canonicalRoot = realpathSync(absoluteRoot);
  const canonical = realpathSync(absolute);
  if (!isInside(canonicalRoot, canonical)) throw new Error('canonical artifact path escapes the project root');
  return readFileSync(canonical, 'utf8');
}

/** Mirror the App Proof heavy-gate contract at the Studio trust boundary. A
 * screenshot claim is trusted only when it uses the deterministic case path,
 * remains inside the real project root, and its bytes match the claimed digest.
 */
function trustedScreenshotMatches(root, result) {
  const shot = result?.screenshot;
  if (!shot || shot.path !== `.dk/proof/screenshots/${result.id}.png`
      || !/^[a-f0-9]{64}$/i.test(shot.sha256 ?? '')
      || !Number.isInteger(shot.bytes) || shot.bytes < 1
      || !Number.isInteger(shot.width) || shot.width < 1
      || !Number.isInteger(shot.height) || shot.height < 1
      || shot.fullPage !== true) return false;
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalShot = realpathSync(resolvePath(root, shot.path));
    const rel = relative(canonicalRoot, canonicalShot);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    const bytes = readFileSync(canonicalShot);
    return bytes.length === shot.bytes
      && createHash('sha256').update(bytes).digest('hex') === shot.sha256;
  } catch { return false; }
}

function isEvidenceScreenshot(path) {
  return /(?:^|\/)(?:screenshots?|__screenshots__|test-results|visual-baselines)(?:\/|$)/i.test(path)
    && /\.(?:png|jpe?g|webp)$/i.test(path);
}

function inferFileRoutes(path) {
  const normalized = slash(path);
  const routes = [];
  if (/\.html?$/.test(normalized)) {
    let route = normalized.replace(/\.html?$/, '');
    route = route.replace(/(^|\/)index$/, '$1');
    routes.push(`/${route}`.replace(/\/+/g, '/'));
  }
  let match = normalized.match(/(?:^|\/)app\/(.*)\/(?:page|route)\.[cm]?[jt]sx?$/);
  if (match) routes.push(`/${match[1].split('/').filter((part) => !/^\(.+\)$/.test(part)).join('/')}`);
  if (/(?:^|\/)app\/(?:page|route)\.[cm]?[jt]sx?$/.test(normalized)) routes.push('/');
  match = normalized.match(/(?:^|\/)(?:src\/)?pages\/(.+)\.[cm]?[jt]sx?$/);
  if (match && !/^(?:_app|_document|api\/)/.test(match[1])) routes.push(`/${match[1].replace(/\/index$/, '')}`);
  match = normalized.match(/(?:^|\/)src\/routes\/(.*)\/+page\.(?:svelte|[jt]s)$/);
  if (match) routes.push(`/${match[1]}`);
  if (/(?:^|\/)src\/routes\/+page\.(?:svelte|[jt]s)$/.test(normalized)) routes.push('/');
  match = normalized.match(/(?:^|\/)src\/pages\/(.+)\.astro$/);
  if (match) routes.push(`/${match[1].replace(/\/index$/, '')}`);
  return [...new Set(routes.map(normalizeRoute))];
}

function discoverImports(source) {
  const imports = [];
  const regex = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+[\s\S]*?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(source))) imports.push({ specifier: match[1], line: lineAt(source, match.index) });
  return imports;
}

function discoverComponentUses(source) {
  const names = new Set();
  const regex = /<([A-Z][A-Za-z0-9_$]*)(?:\s|\/?>)/g;
  let match;
  while ((match = regex.exec(source))) names.add(match[1]);
  return [...names].sort();
}

function discoverCssVariableUses(source) {
  return [...new Set([...source.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((match) => match[1]))].sort();
}

function resolveComponentReference(fromFile, name, source, fileSet, componentsByFile, componentsByName) {
  if (!name) return null;
  const importRegex = new RegExp(`import\\s+(?:${escapeRegExp(name)}|\\{[^}]*\\b${escapeRegExp(name)}\\b[^}]*\\})[\\s\\S]*?from\\s*['\"]([^'\"]+)['\"]`);
  const specifier = source.match(importRegex)?.[1];
  const targetFile = specifier ? resolveImportPath(fromFile, specifier, fileSet) : null;
  const inFile = targetFile ? componentsByFile.get(targetFile) : null;
  return chooseComponent(inFile?.filter((id) => id.endsWith(`#${name}`)) ?? componentsByName.get(name), fromFile);
}

function resolveImportPath(fromFile, specifier, fileSet) {
  if (!specifier?.startsWith('.')) return null;
  const base = slash(resolvePath('/', dirname(fromFile), specifier)).replace(/^\//, '');
  const candidates = [base];
  for (const ext of COMPONENT_EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of COMPONENT_EXTENSIONS) candidates.push(`${base}/index${ext}`);
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function chooseComponent(ids, fromFile) {
  if (!ids?.length) return null;
  return [...ids].sort((a, b) => {
    const aNear = a.includes(`${dirname(fromFile)}/`) ? 0 : 1;
    const bNear = b.includes(`${dirname(fromFile)}/`) ? 0 : 1;
    return aNear - bNear || a.localeCompare(b);
  })[0];
}

function walkTokenLeaves(value, path, visit) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (Object.prototype.hasOwnProperty.call(value, '$value')) { visit(path, value); return; }
  for (const key of Object.keys(value).sort()) {
    if (key.startsWith('$') || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    walkTokenLeaves(value[key], [...path, key], visit);
  }
}

function aliasPath(value) {
  return typeof value === 'string' ? value.match(/^\{([^}]+)\}$/)?.[1] ?? null : null;
}

function displayTokenValue(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return '[complex]'; }
}

function inferTokenType(name, value) {
  const lower = String(name).toLowerCase();
  if (/color|background|surface|accent|#[0-9a-f]{3,8}|rgba?\(/i.test(`${lower} ${displayTokenValue(value)}`)) return 'color';
  if (/font|type|line-height|letter/.test(lower)) return 'typography';
  if (/space|gap|margin|padding/.test(lower)) return 'spacing';
  if (/radius|corner/.test(lower)) return 'radius';
  if (/shadow|elevation/.test(lower)) return 'shadow';
  if (/duration|motion|easing/.test(lower)) return 'motion';
  return 'other';
}

function discoverViewports(source) {
  const values = new Set();
  for (const match of source.matchAll(/setViewportSize\s*\(\s*\{[^}]*\bwidth\s*:\s*(\d+)/g)) values.add(Number(match[1]));
  for (const match of source.matchAll(/viewport\s*:\s*\{[^}]*\bwidth\s*:\s*(\d+)/g)) values.add(Number(match[1]));
  if (/mobile|iphone|pixel/i.test(source)) values.add('mobile');
  if (/tablet|ipad/i.test(source)) values.add('tablet');
  if (/desktop/i.test(source)) values.add('desktop');
  return [...values].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

function statesFromText(text) {
  const lower = String(text).toLowerCase();
  const dictionary = [
    ['loading', /loading|skeleton|pending/], ['empty', /empty|no[- ]data|zero[- ]state/],
    ['error', /error|invalid|failure|failed/], ['success', /success|complete|passed/],
    ['focus', /focus|keyboard|tab order/], ['hover', /hover/], ['disabled', /disabled/],
    ['reduced-motion', /reduced[- ]motion/],
  ];
  return dictionary.filter(([, regex]) => regex.test(lower)).map(([name]) => name);
}

function normalizeState(name) {
  const normalized = String(name).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  if (/^(?:dark|light|mobile|tablet|desktop)$/.test(normalized)) return null;
  return statesFromText(name)[0] ?? normalized;
}

function urlToRoute(value) {
  try {
    if (/^https?:\/\//i.test(value)) return normalizeRoute(new URL(value).pathname);
  } catch { /* use literal route below */ }
  if (String(value).startsWith('/')) return normalizeRoute(String(value).split(/[?#]/)[0]);
  return null;
}

function normalizeRoute(route) {
  const raw = String(route || '/').trim().split(/[?#]/)[0] || '/';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const compact = withSlash.replace(/\/+/g, '/');
  return compact.length > 1 ? compact.replace(/\/$/, '') : compact;
}

function isStoryFile(path) { return /\.(?:stories|story)\.[^.]+$/i.test(path); }
function isTestFile(path) { return /\.(?:spec|test)\.[^.]+$/i.test(path) || /(?:^|\/)tests?\//i.test(path); }
function isNonProductSurface(path) {
  return /(?:^|\/)(?:fixtures|golden|tests?)(?:\/|$)/i.test(path)
    || /(?:^|\/)output(?:\/|$)/i.test(path);
}

function frameworkFor(path, source) {
  const ext = extname(path).toLowerCase();
  if (ext === '.vue') return 'vue';
  if (ext === '.svelte') return 'svelte';
  if (ext === '.astro') return 'astro';
  if (/from\s+['"]react['"]|jsx|tsx/i.test(`${source.slice(0, 1200)} ${ext}`)) return 'react';
  return 'javascript';
}

function countKinds(nodes, edges, sourceFiles, imageFiles) {
  const kinds = {};
  for (const node of nodes) kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
  const relations = {};
  for (const edge of edges) relations[edge.type] = (relations[edge.type] ?? 0) + 1;
  return { nodes: nodes.length, edges: edges.length, sourceFiles, imageFiles, kinds, relations };
}

function compareNodes(a, b) {
  const order = { route: 0, component: 1, story: 2, token: 3, stylesheet: 4 };
  return (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

function findTokenLine(source, key) {
  const index = source.indexOf(`"${key}"`);
  return index < 0 ? 1 : lineAt(source, index);
}

function lineAt(source, index) { return source.slice(0, Math.max(0, index)).split('\n').length; }
function isInside(root, target) {
  const value = relative(resolvePath(root), resolvePath(target));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function slash(path) { return path.split(sep).join('/'); }
function pascalCase(value) { return value.split(/[-_.\s]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(''); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function finitePositive(value, fallback) { return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
function normalizeNow(now) { return now instanceof Date ? now.toISOString() : typeof now === 'string' ? now : new Date().toISOString(); }

const invokedPath = process.argv[1] ? resolvePath(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const output = outAt >= 0 ? args[outAt + 1] : null;
  const positional = args.filter((arg, index) => arg !== '--out' && index !== outAt + 1);
  const graph = indexRepository(positional[0] ?? process.cwd());
  if (output) {
    writeSystemGraph(graph, output, { root: process.cwd() });
    process.stdout.write(`${resolvePath(output)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
  }
}
