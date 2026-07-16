import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const failures = [];

function engineAtLeast(range, minimum) {
  const match = String(range ?? '').trim().match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\s|$)/);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

if (pkg.name !== 'axion-designer') failures.push(`expected package name axion-designer, got ${pkg.name}`);
if (pkg.bin?.dk !== 'bin/dk.mjs') failures.push('package bin.dk must point to bin/dk.mjs');
if (!engineAtLeast(pkg.engines?.node, [18, 14, 1])) {
  failures.push(`package engines.node must require Node >=18.14.1, got ${pkg.engines?.node ?? 'missing'}`);
}
if (JSON.stringify(pkg).includes('OWNER')) failures.push('package metadata still contains OWNER placeholder');

for (const file of [
  'templates/scaffold/.gitignore',
  'templates/scaffold/stylelint.config.mjs',
  'templates/scaffold/playwright.config.mjs',
  'templates/scaffold/gates/visual-matrix.mjs',
  'src/studio/client/index.html',
  'src/studio/client/app.css',
  'src/studio/client/app.js',
  'src/studio/client/inspector.js',
  'src/proof/app-proof-runner.mjs',
  'src/system/indexer.mjs',
  'scripts/p3-benchmark.mjs',
  'scripts/eval-codex-traces.mjs',
  'src/codex/context.mjs',
  'src/codex/integration.mjs',
  'src/codex/index.mjs',
  'src/codex/index.d.ts',
  'src/intelligence/index.mjs',
  'src/intelligence/index.d.ts',
  'src/reference/index.mjs',
  'src/reference/index.d.ts',
  'src/reference/attestation.mjs',
  'reference.schema.json',
  '.mcp.json',
  'skills/dk-design/scripts/preflight.mjs',
  'skills/dk-design/scripts/runtime-integrity.mjs',
  'skills/dk-design/references/codex-surfaces.md',
  'skills/dk-design/references/product-ui.md',
  'skills/dk-design/references/visual-review.md',
  'skills/dk-design/references/reconstruct.md',
  'skills/dk-design-claude/SKILL.md',
  'skills/dk-design-claude/agents/claude.json',
  'skills/dk-design-claude/scripts/preflight.mjs',
  'skills/dk-design-claude/scripts/runtime-integrity.mjs',
  'skills/dk-design-claude/references/claude-surfaces.md',
  'src/claude/index.mjs',
  'src/claude/index.d.ts',
  'evals/codex/cases.json',
  'evals/codex/trace.schema.json',
]) {
  try { readFileSync(resolve(root, file), 'utf8'); }
  catch { failures.push(`required scaffold file is missing: ${file}`); }
}

for (const file of ['README.md', 'README.zh-TW.md', 'DESIGN.md', 'index.mjs', 'templates/scaffold/dk.config.mjs']) {
  const source = readFileSync(resolve(root, file), 'utf8');
  if (/from\s+['"]dk['"]/.test(source)) failures.push(`${file} imports the CLI name "dk" instead of package "axion-designer"`);
}

const schema = JSON.parse(readFileSync(resolve(root, 'dk.schema.json'), 'utf8'));
if (schema.$id !== 'https://unpkg.com/axion-designer/dk.schema.json') failures.push('config schema $id is not the published package URL');
if (!schema.properties?.direction) failures.push('config schema does not expose the direction contract settings');
if (!schema.properties?.proof || schema.properties.proof.additionalProperties !== false) {
  failures.push('config schema does not expose a fail-closed App Proof contract');
}
const directionSchema = JSON.parse(readFileSync(resolve(root, 'direction.schema.json'), 'utf8'));
if (directionSchema.$id !== 'https://unpkg.com/axion-designer/direction.schema.json'
    || directionSchema.properties?.schema?.const !== 'dk-direction/v2') {
  failures.push('direction schema id/version is not the compact dk-direction/v2 contract');
}
const bridgeSchema = JSON.parse(readFileSync(resolve(root, 'bridge.schema.json'), 'utf8'));
if (bridgeSchema.$id !== 'https://unpkg.com/axion-designer/bridge.schema.json'
    || bridgeSchema.properties?.schema?.const !== 'axion-bridge-config/v1'
    || !schema.properties?.bridge
    || !pkg.exports?.['./bridge']
    || !pkg.exports?.['./bridge-schema']) {
  failures.push('Axion Bridge schema, config surface, or package exports are incomplete');
}
const referenceSchema = JSON.parse(readFileSync(resolve(root, 'reference.schema.json'), 'utf8'));
if (referenceSchema.$id !== 'https://unpkg.com/axion-designer/reference.schema.json'
    || referenceSchema.oneOf?.length !== 5
    || referenceSchema.$defs?.referenceManifest?.allOf?.[1]?.properties?.kind?.const !== 'reference-manifest/v1'
    || referenceSchema.$defs?.referenceComparison?.properties?.kind?.const !== 'reference-comparison/v1'
    || referenceSchema.$defs?.referenceComparison?.properties?.capture?.$ref !== '#/$defs/captureAttestation'
    || referenceSchema.$defs?.captureAttestation?.properties?.status?.enum?.join(',') !== 'attested,unattested'
    || !pkg.exports?.['./reference']
    || !pkg.exports?.['./reference-schema']) {
  failures.push('Reference-to-Code schema or package exports are incomplete');
}
const skill = readFileSync(resolve(root, 'skills/dk-design/SKILL.md'), 'utf8');
if (!/^---\nname: dk-design\ndescription: .+\n---/s.test(skill)
    || skill.includes('[TODO')
    || !skill.includes('## Shape')
    || !skill.includes('## Prove and preserve')
    || !skill.includes('dk design lock --accept')) {
  failures.push('unified Axion Designer skill is incomplete');
}
for (const required of [
  'Run this skill only after explicit `$dk-design` invocation.',
  'Never enable it implicitly or install it globally.',
  'Do not write `$HOME/.codex`',
  'Run `node scripts/preflight.mjs --cwd <target-repository>`',
  'do not install dependencies merely to find the runtime.',
  'Only the main agent may modify product source.',
  'use `--trust-project-config` only after the user has trusted this repository',
  'use `--publish` only when the user or repository workflow explicitly authorizes',
  'Run `dk design lock --accept` only when the current user request explicitly authorizes acceptance',
  'Never update a visual baseline',
  '`incomplete` is not a pass.',
]) {
  if (!skill.includes(required)) failures.push(`Codex skill is missing its safe default: ${required}`);
}
if (readFileSync(resolve(root, '.agents/skills/dk-design/SKILL.md'), 'utf8') !== skill) {
  failures.push('repo-scoped .agents/skills discovery link does not resolve to dk-design');
}
const agent = readFileSync(resolve(root, 'skills/dk-design/agents/openai.yaml'), 'utf8');
const implicitPolicies = agent.match(/^\s*allow_implicit_invocation:\s*(?:true|false)\s*$/gm) ?? [];
if (!agent.includes('display_name: "Axion Designer for Codex"')
    || !agent.includes('$dk-design')
    || implicitPolicies.length !== 1
    || implicitPolicies[0].trim() !== 'allow_implicit_invocation: false') {
  failures.push('Axion Designer agent metadata is incomplete');
}
const runtimeIntegrity = readFileSync(resolve(root, 'skills/dk-design/scripts/runtime-integrity.mjs'), 'utf8');
for (const name of [
  'AXION_RUNTIME_DIGEST_SCHEMA', 'AXION_RUNTIME_PATHS', 'axionSkillDigest',
  'axionRuntimeDigest', 'inspectAxionRuntime', 'findProjectAxionRuntime', 'pathInside',
]) {
  if (!new RegExp(`export (?:const|class|function) ${name}\\b`).test(runtimeIntegrity)) {
    failures.push(`Codex runtime-integrity helper does not export ${name}`);
  }
}
const pluginManifest = JSON.parse(readFileSync(resolve(root, '.codex-plugin/plugin.json'), 'utf8'));
if (pluginManifest.name !== pkg.name
    || pluginManifest.version !== pkg.version
    || pluginManifest.skills !== './skills/'
    || pluginManifest.mcpServers !== './.mcp.json'
    || pluginManifest.interface?.displayName !== 'Axion Designer for Codex'
    || !Array.isArray(pluginManifest.interface?.defaultPrompt)
    || pluginManifest.interface.defaultPrompt.length < 2
    || !pluginManifest.interface.defaultPrompt.every((prompt) => prompt.includes('$dk-design'))) {
  failures.push('root Codex plugin manifest does not expose the unified skill and bundled runtime version');
}
const pluginMcp = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8'));
const intelligenceMcp = pluginMcp.mcpServers?.['axion-design-intelligence'];
if (intelligenceMcp?.command !== 'node'
    || !intelligenceMcp.args?.includes('./bin/dk-mcp.mjs')
    || !intelligenceMcp.args?.includes('--intelligence-only')
    || intelligenceMcp.args?.includes('--root')) {
  failures.push('Plugin MCP must expose only stateless design intelligence without project-root authority');
}
for (const capability of [
  'Three-direction AI UI art direction',
  'Code-native frontend implementation',
  'Studio Live Inspector and System Graph',
  'Route-state-viewport-theme App Proof',
  'Semantic Taste Lock drift protection',
  'Hash-chained approvals, CI reports, and drift benchmark',
  'Project-scoped explicit activation in Codex CLI and desktop',
  'Sub-12KB source-backed Codex design context',
  'Nine-domain offline design intelligence with stack-aware direction recipes',
  'Authorized reference-to-code evidence chain with anti-cheat validation',
  'Studio Reference overlay, scoped repair requests, Live Inspector, and System Graph',
]) {
  if (!pluginManifest.interface?.capabilities?.includes(capability)) {
    failures.push(`plugin manifest is missing the P3 capability: ${capability}`);
  }
}
let proof = null;
try { proof = JSON.parse(readFileSync(resolve(root, 'output/market-demo/manifest.json'), 'utf8')); }
catch { proof = null; }
if (!proof) {
  failures.push('reproducible proof evidence is missing; run `npm run demo` first to regenerate output/market-demo (prepublishOnly does this automatically)');
} else if (proof.schema !== 'dk-market-demo/v1'
    || proof.fail?.exitCode !== 1
    || proof.pass?.exitCode !== 0
    || proof.correction?.sourceRestoredByteForByte !== true
    || proof.assertions?.jsonHtmlSarifValidated !== true) {
  failures.push('reproducible proof manifest does not prove fail → exact repair → pass');
}

const api = await import(pathToFileURL(resolve(root, 'index.mjs')).href);
if (typeof api.defineConfig !== 'function') failures.push('public defineConfig export is missing');
for (const name of [
  'appProofCaseId', 'normalizeAppProofConfig', 'appendApproval', 'runDriftBenchmark',
  'createStudioServer', 'startStudio', 'indexRepository', 'collectStudioSnapshot',
  'createBridgeRuntime', 'syncBridge', 'auditBridge', 'builtInAdapterCatalog',
  'bridgeConnectionContractDigest', 'buildCodexDesignContext', 'inspectCodexIntegration',
  'installCodexIntegration', 'codexSkillDigest', 'codexStarterPrompt', 'codexStarterPrompts',
  'loadIntelligenceCatalog', 'normalizeDesignBrief', 'recommendDesignDirections',
  'createReferenceSystem', 'validateReferenceArtifact',
]) {
  if (typeof api[name] !== 'function') failures.push(`public ${name} export is missing`);
}
for (const name of [
  'CODEX_CONTEXT_MAX_BYTES', 'CODEX_CONTEXT_SCHEMA', 'CODEX_INSTALL_RECEIPT_SCHEMA',
  'CODEX_INTEGRATION_SCHEMA', 'CODEX_SKILL_NAME', 'CODEX_SKILL_PATH', 'CodexIntegrationError',
]) {
  if (!(name in api)) failures.push(`public ${name} export is missing`);
}
if (pkg.exports?.['./codex']?.types !== './src/codex/index.d.ts'
    || pkg.exports?.['./codex']?.import !== './src/codex/index.mjs') {
  failures.push('public Codex subpath export is missing or does not expose runtime plus types');
}
if (pkg.exports?.['./intelligence']?.types !== './src/intelligence/index.d.ts'
    || pkg.exports?.['./reference']?.types !== './src/reference/index.d.ts') {
  failures.push('public Intelligence or Reference subpath types are missing');
}
const codexApi = await import(pathToFileURL(resolve(root, 'src/codex/index.mjs')).href);
for (const name of [
  'CODEX_CONTEXT_MAX_BYTES', 'CODEX_CONTEXT_SCHEMA', 'CODEX_INSTALL_RECEIPT_SCHEMA',
  'CODEX_INTEGRATION_SCHEMA', 'CODEX_SKILL_NAME', 'CODEX_SKILL_PATH', 'CodexIntegrationError',
  'buildCodexDesignContext', 'codexSkillDigest', 'codexStarterPrompt', 'codexStarterPrompts',
  'inspectCodexIntegration', 'installCodexIntegration',
]) {
  if (!(name in codexApi)) failures.push(`public Codex subpath ${name} export is missing`);
}
const rootTypes = readFileSync(resolve(root, 'index.d.ts'), 'utf8');
const codexTypes = readFileSync(resolve(root, 'src/codex/index.d.ts'), 'utf8');
for (const name of [
  'CodexIntegrationInspection', 'CodexDesignContext', 'CodexDesignLane',
  'buildCodexDesignContext', 'inspectCodexIntegration', 'installCodexIntegration',
]) {
  if (!rootTypes.includes(name)) failures.push(`root type surface is missing ${name}`);
  if (!codexTypes.includes(name)) failures.push(`Codex type subpath is missing ${name}`);
}
for (const entry of ['bin', 'src', 'data', 'scripts', 'tests', '.codex-plugin', '.mcp.json', 'skills/dk-design', 'evals/codex', 'reference.schema.json']) {
  if (!pkg.files?.includes(entry)) failures.push(`npm pack allowlist is missing Codex-required entry: ${entry}`);
}
for (const keyword of ['codex', 'codex-skill']) {
  if (!pkg.keywords?.includes(keyword)) failures.push(`package keywords are missing ${keyword}`);
}
for (const forbidden of [
  'templates/scaffold/.dk/cache.json',
  'templates/scaffold/.dk/report.json',
  'templates/scaffold/.dk/proof/app-proof.json',
]) {
  try {
    readFileSync(resolve(root, forbidden));
    failures.push(`scaffold ships stale runtime evidence: ${forbidden}`);
  } catch {}
}
const bridgeApi = await import(pathToFileURL(resolve(root, 'src/bridge/index.mjs')).href);
for (const name of [
  'BRIDGE_CONFIG_SCHEMA', 'BRIDGE_LEDGER_FILE', 'BRIDGE_LIFECYCLES', 'BRIDGE_RUN_SCHEMA',
  'BRIDGE_STATUS_SCHEMA', 'BRIDGE_TRUST_LEVELS', 'BridgeAbortError', 'BridgeLedgerError',
  'BridgeOrchestratorError', 'BridgePermissionError', 'BridgeRegistryError',
  'BridgeRequiredProviderError', 'BridgeRuntimeError', 'BridgeTimeoutError',
  'BridgeValidationError', 'DEFAULT_BRIDGE_ARTIFACT_DIR', 'LEDGER_CONNECTION_SCHEMA',
  'appendArtifactLedger', 'artifactLedgerPath', 'assertAdapterManifest',
  'assertIntegrationEnvelope', 'canonicalSha256', 'canonicalStringify',
  'createConnectionAdapter', 'createFileEnvelopeAdapter', 'createMemoryEnvelopeAdapter',
  'emptyArtifactLedger', 'integrationEnvelopeDigest', 'invokeWithControl',
  'isSafeRelativePath', 'resolveInsideRoot', 'trustRank',
]) {
  if (!(name in bridgeApi)) failures.push(`public Bridge subpath ${name} export is missing`);
}
if (failures.length) {
  process.stderr.write(`package validation failed:\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('package validation passed: metadata, imports, public API, types, schema and proof are coherent\n');
}
