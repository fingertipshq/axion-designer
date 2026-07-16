import {
  discoverProofSurfaces,
  defineConfig,
  loadConfig,
  indexRepository,
  normalizeAppProofConfig,
  runDriftBenchmark,
  buildAppProofMatrix,
  writeSystemGraph,
  type DkConfig,
  type DkA11yTag,
  type DkProofSurfaces,
  type DkSystemGraph,
  createIntegrationEnvelope,
  validateIntegrationEnvelope,
  bridgeConnectionContractDigest,
  buildCodexDesignContext,
  inspectCodexIntegration,
  codexStarterPrompt,
  recommendDesignDirections,
  createReferenceSystem,
  type CodexDesignLane,
  type DesignRecommendation,
  type AxionBridgeEnvelope,
} from 'axion-designer';
import {
  CODEX_CONTEXT_MAX_BYTES,
  inspectCodexIntegration as inspectCodexSubpath,
  type CodexIntegrationInspection,
} from 'axion-designer/codex';
import {
  BRIDGE_CONFIG_SCHEMA,
  BRIDGE_LEDGER_FILE,
  BRIDGE_LIFECYCLES,
  BRIDGE_RUN_SCHEMA,
  BRIDGE_STATUS_SCHEMA,
  BRIDGE_TRUST_LEVELS,
  BridgeAbortError,
  BridgeLedgerError,
  BridgeOrchestratorError,
  BridgePermissionError,
  BridgeRegistryError,
  BridgeRequiredProviderError,
  BridgeRuntimeError,
  BridgeTimeoutError,
  BridgeValidationError,
  DEFAULT_BRIDGE_ARTIFACT_DIR,
  LEDGER_CONNECTION_SCHEMA,
  appendArtifactLedger,
  artifactLedgerPath,
  assertAdapterManifest,
  assertIntegrationEnvelope,
  canonicalSha256,
  canonicalStringify,
  createConnectionAdapter,
  createFileEnvelopeAdapter,
  createMemoryEnvelopeAdapter,
  emptyArtifactLedger,
  integrationEnvelopeDigest,
  invokeWithControl,
  isSafeRelativePath,
  resolveInsideRoot,
  trustRank,
  createBridgeRuntime as createBridgeRuntimeSubpath,
  safeFetch,
} from 'axion-designer/bridge';
import { createAxionMcpServer, type AxionMcpOptions } from 'axion-designer/mcp';
import { normalizeDesignBrief, type DesignIntelligenceOptions } from 'axion-designer/intelligence';
import { createReferenceSystem as createReferenceSubpath, type ReferenceSystem } from 'axion-designer/reference';

const config: DkConfig = defineConfig({
  preset: 'strict',
  failOn: 'error',
  failOnSkipped: true,
  targets: ['src/**/*.{css,tsx,astro}'],
  contrast: {
    algorithm: 'wcag',
    modes: ['light', 'dark'],
    pairs: [['color.text.primary', 'color.surface.page', 4.5]],
  },
  slop: {
    rules: [{ id: 'brand/no-glow', zone: 'style', pattern: 'drop-shadow', severity: 'warn' }],
  },
  gates: { a11y: { tags: ['wcag2a', 'wcag22aa'] } },
  proof: {
    baseUrl: 'http://127.0.0.1:3000',
    routes: ['/', { path: '/pricing', states: ['default', {
      name: 'annual', actions: [{ type: 'click', selector: '[data-plan=annual]' }],
    }] }],
    viewports: [{ name: 'phone', width: 375, height: 812 }],
    themes: ['light', { name: 'night', colorScheme: 'dark', classes: ['dark'] }],
  },
});

const proofPlan = normalizeAppProofConfig(config.proof!);
if (proofPlan.routes !== 'auto') buildAppProofMatrix(proofPlan);
const supportedA11yTag: DkA11yTag = 'best-practice';
// @ts-expect-error Unknown Axe tags must fail in editor/types before runtime config validation.
const unsupportedA11yTag: DkA11yTag = 'definitely-not-a-real-tag';

const systemGraph: DkSystemGraph = indexRepository('.', {
  maxFiles: 500,
  maxBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
});
const proofSurfaces: DkProofSurfaces = discoverProofSurfaces('.', { maxTotalBytes: 2 * 1024 * 1024 });
const routeStatus: 'discovered' | 'evidence-linked' | 'proven' | undefined = proofSurfaces.routes[0]?.status;
const screenshotCount: number = systemGraph.proof.summary.screenshotCount;
const appProofStatus: 'missing' | 'invalid' | 'quality-failed' | 'unattested' | 'stale' | 'complete' = systemGraph.proof.appProof.status;
const graphOutput: string = writeSystemGraph(systemGraph, 'output/system-graph.json', { root: '.' });
const benchmarkPromise = runDriftBenchmark({ timeoutMs: 30_000, throwOnFailure: false });
const bridgeEnvelope: AxionBridgeEnvelope<{ status: string }> = createIntegrationEnvelope({
  provider: 'storybook', kind: 'collect/storybook', payload: { status: 'passed' },
});
const bridgeIssues = validateIntegrationEnvelope(bridgeEnvelope);
const bridgeContractDigest: string = bridgeConnectionContractDigest({
  id: 'storybook-main', adapter: 'storybook', role: 'source', required: true,
  trust: 'verified', source: 'storybook/index.json', permissions: ['fs:read', 'network:storybook'],
}, '.');
const bridgeRuntime = createBridgeRuntimeSubpath({ root: '.' });
const safeFetchPromise = safeFetch('https://evidence.example.test/status', {
  maxBytes: 1024 * 1024,
  allowRedirects: false,
  validateUrlOptions: { httpsOnly: true, allowedOrigins: ['https://evidence.example.test'] },
});
const mcpOptions: AxionMcpOptions = { root: '.', maxResourceBytes: 1024 * 1024 };
const mcpServer = createAxionMcpServer(mcpOptions);
const codexLane: CodexDesignLane = 'refine';
const codexPrompt: string = codexStarterPrompt(codexLane);
const reconstructLane: CodexDesignLane = 'reconstruct';
const reconstructPrompt: string = codexStarterPrompt(reconstructLane);
const intelligenceOptions: DesignIntelligenceOptions = { stack: 'next', density: 'compact', variance: 70 };
const normalizedBrief = normalizeDesignBrief('A dashboard for analysts to monitor workflow status', intelligenceOptions);
const recommendation: DesignRecommendation = recommendDesignDirections(normalizedBrief.source, intelligenceOptions);
const referenceSystem: ReferenceSystem = createReferenceSubpath('.');
const rootReferenceSystem = createReferenceSystem('.');
const codexInspection: CodexIntegrationInspection = inspectCodexSubpath('.');
const rootCodexInspection = inspectCodexIntegration('.');
const codexContextPromise = buildCodexDesignContext('.');
const resolvedConfig = loadConfig('.');
benchmarkPromise.then((benchmark) => {
  const timeoutPhase: 'baseline' | 'detection' | 'recovery' | undefined = benchmark.failure?.phase;
  void timeoutPhase;
});
// @ts-expect-error Proof surfaces are an exact public contract, not an open bag of legacy fields.
systemGraph.proof.screenshots;
void routeStatus;
void screenshotCount;
void appProofStatus;
void graphOutput;
void benchmarkPromise;
void bridgeIssues;
void bridgeContractDigest;
void bridgeRuntime;
void safeFetchPromise;
void mcpServer;
void CODEX_CONTEXT_MAX_BYTES;
void codexPrompt;
void reconstructPrompt;
void recommendation;
void referenceSystem;
void rootReferenceSystem;
void codexInspection;
void rootCodexInspection;
void codexContextPromise;
void resolvedConfig;
void config;
void supportedA11yTag;
void unsupportedA11yTag;
void [
  BRIDGE_CONFIG_SCHEMA, BRIDGE_LEDGER_FILE, BRIDGE_LIFECYCLES, BRIDGE_RUN_SCHEMA,
  BRIDGE_STATUS_SCHEMA, BRIDGE_TRUST_LEVELS, DEFAULT_BRIDGE_ARTIFACT_DIR, LEDGER_CONNECTION_SCHEMA,
  BridgeAbortError, BridgeLedgerError, BridgeOrchestratorError, BridgePermissionError,
  BridgeRegistryError, BridgeRequiredProviderError, BridgeRuntimeError, BridgeTimeoutError,
  BridgeValidationError, appendArtifactLedger, artifactLedgerPath, assertAdapterManifest,
  assertIntegrationEnvelope, canonicalSha256, canonicalStringify, createConnectionAdapter,
  createFileEnvelopeAdapter, createMemoryEnvelopeAdapter, emptyArtifactLedger,
  integrationEnvelopeDigest, invokeWithControl, isSafeRelativePath, resolveInsideRoot, trustRank,
];
