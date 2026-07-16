export type DkSeverity = 'error' | 'warn' | 'info' | 'off';
export type DkFailOn = 'error' | 'warn';
export type DkPreset = 'recommended' | 'strict' | 'minimal';
export type DkEnforcement = 'off' | 'warn' | 'error' | boolean;
export type CodexIntegrationStatus = 'missing' | 'ready' | 'stale' | 'invalid';
export type CodexDesignLane = 'auto' | 'explore' | 'refine' | 'reconstruct' | 'reimagine' | 'verify';
export type AxionDesignStack = 'react' | 'next' | 'vue' | 'nuxt' | 'svelte' | 'astro' | 'html-tailwind' | 'shadcn';
export type AxionDesignDensity = 'compact' | 'balanced' | 'airy';
export type AxionDesignMotion = 'none' | 'subtle' | 'expressive';
export type AxionDesignContrast = 'standard' | 'high';
export type AxionDesignDomain = 'product' | 'style' | 'color' | 'typography' | 'layout' | 'motion' | 'icons' | 'charts' | 'ux';

export interface DesignIntelligenceOptions {
  stack?: AxionDesignStack | string;
  density?: AxionDesignDensity;
  motion?: AxionDesignMotion;
  contrast?: AxionDesignContrast;
  variance?: number;
}

export interface NormalizedDesignBrief {
  schema: 'axion-normalized-design-brief/v1';
  source: string;
  language: 'zh' | 'en' | 'mixed';
  tokens: string[];
  corrections: Array<{ from: string; to: string; distance: number }>;
  intent: string | null;
  intentCandidates: Array<{ id: string; signals: string[] }>;
  audience: string | null;
  primaryTask: string | null;
  statePriority: string[];
  controls: Required<Pick<DesignIntelligenceOptions, 'density' | 'motion' | 'contrast' | 'variance'>> & { stack: AxionDesignStack };
  confidence: { score: number; level: 'low' | 'medium' | 'high'; reasons: string[] };
}

export interface DesignDirectionRecipe {
  id: string;
  name: string;
  thesis: string;
  why: string;
  recipe: Record<string, unknown>;
  stackPlan: string[];
  tradeoff: string;
  antiGoals: string[];
  provenance: Array<{ domain: AxionDesignDomain; ruleIds: string[] }>;
}

export interface DesignRecommendation {
  schema: 'axion-design-recommendation/v1';
  status: 'ready' | 'needs-clarification';
  briefDigest: string;
  normalizedIntent: NormalizedDesignBrief;
  confidence: NormalizedDesignBrief['confidence'];
  warnings: Array<{ code: string; message: string }>;
  constraints: NormalizedDesignBrief['controls'] & { implementation: string[] };
  matches: Record<AxionDesignDomain, Array<{ ruleId: string; reason: string }>>;
  provenance: Record<string, unknown>;
  directions: DesignDirectionRecipe[];
}

export class DesignIntelligenceError extends Error { code: string }
export const INTELLIGENCE_CATALOG_SCHEMA: 'axion-design-intelligence-catalog/v1';
export const INTELLIGENCE_RECOMMENDATION_SCHEMA: 'axion-design-recommendation/v1';
export const INTELLIGENCE_NORMALIZED_BRIEF_SCHEMA: 'axion-normalized-design-brief/v1';
export const INTELLIGENCE_DOMAINS: readonly AxionDesignDomain[];
export const INTELLIGENCE_STACKS: readonly AxionDesignStack[];
export function loadIntelligenceCatalog(): Record<string, unknown>;
export function normalizeDesignBrief(brief: string, options?: DesignIntelligenceOptions): NormalizedDesignBrief;
export function recommendDesignDirections(brief: string, options?: DesignIntelligenceOptions): DesignRecommendation;
export type ReferenceKind =
  | 'reference-manifest/v1'
  | 'visual-decomposition/v1'
  | 'component-mapping/v1'
  | 'reconstruction-plan/v1'
  | 'reference-comparison/v1';
export interface ReferenceArtifactResult<T = Record<string, unknown>> {
  path: string;
  sha256: string;
  bytes: number;
  artifact: T;
}
export class ReferenceSystemError extends Error { code: string }
export class ReferenceValidationError extends ReferenceSystemError { issues: string[] }
export class ReferenceSystem {
  readonly projectRoot: string;
  readonly projectRootSha256: string;
  readonly directory: string;
  readonly paths: { directory: string; manifest: string; assets: string };
  artifactPaths(referenceId: string): Record<'manifest' | 'decomposition' | 'mapping' | 'plan' | 'comparison', string>;
  registerReferences(inputs: Array<Record<string, unknown>>, options?: { replace?: boolean }): ReferenceArtifactResult;
  readManifest(options?: { verifyAssets?: boolean }): ReferenceArtifactResult;
  readArtifact(path: string, options?: { validateLinks?: boolean }): ReferenceArtifactResult;
  validateArtifact(input: string | Record<string, unknown>, context?: Record<string, unknown>): string[];
  writeVisualDecomposition(input: Record<string, unknown>): ReferenceArtifactResult;
  writeComponentMapping(input: Record<string, unknown>): ReferenceArtifactResult;
  writeReconstructionPlan(input: Record<string, unknown>): ReferenceArtifactResult;
  compareReference(input: Record<string, unknown>): ReferenceArtifactResult;
  scanWholeReferenceBackground(files: string[]): Record<string, unknown>;
  inspectStatus(): Record<string, unknown>;
  verifyManifestAssets(manifest: Record<string, unknown>): true;
}
export function createReferenceSystem(projectRoot: string, options?: { directory?: string; clock?: () => Date | string | number }): ReferenceSystem;
export function validateReferenceArtifact(artifact: unknown, context?: Record<string, unknown>): string[];
export function assertValidReferenceArtifact<T>(artifact: T, context?: Record<string, unknown>): T;
export function isReferenceSystemError(error: unknown): boolean;
export const REFERENCE_KINDS: Readonly<Record<string, ReferenceKind>>;
export const REFERENCE_LIMITS: Readonly<Record<string, unknown>>;
export const REFERENCE_FILENAMES: Readonly<Record<string, string | ((referenceId: string) => string)>>;
export const DEFAULT_REFERENCE_DIRECTORY: '.dk/reference';

export interface CodexIntegrationInspection {
  schema: 'axion-codex-integration/v1';
  status: CodexIntegrationStatus;
  project: string;
  scope: 'repository';
  activation: 'explicit';
  scopeGuard: { status: 'ready' | 'forbidden'; issue: string | null };
  skill: {
    name: 'dk-design';
    path: '.agents/skills/dk-design';
    kind: 'missing' | 'symlink' | 'directory' | 'file';
    explicitOnly: boolean;
    digest: string | null;
    expectedDigest: string;
    issue: string | null;
  };
  runtime: {
    status: 'ready' | 'missing' | 'mismatch' | 'invalid';
    kind: 'source-repository' | 'project-dependency' | 'missing';
    path: string | null;
    version: string | null;
    digest: string | null;
    expectedDigest: string;
    issue: string | null;
  };
  surfaces: {
    cli: 'ready' | 'setup-required';
    desktop: 'ready' | 'setup-required';
    trustedProjectRequiredForProjectConfig: true;
  };
  isolation: {
    installerWrites: string[];
    installerWritesGlobalConfig: false;
    implicitInvocation: false;
    neverWrites: string[];
  };
  changed?: boolean;
}

export interface CodexDesignContext {
  schema: 'axion-codex-context/v1';
  project: string;
  codex: CodexIntegrationInspection;
  suggestedLane: { lane: Exclude<CodexDesignLane, 'auto' | 'reimagine'>; reason: string };
  repository: {
    stats: Record<string, unknown>;
    frameworks: string[];
    routes: Array<Record<string, unknown>>;
    components: Array<Record<string, unknown>>;
    proof: Record<string, unknown>;
    warnings: Array<Record<string, unknown>>;
  };
  direction: Record<string, unknown>;
  evidence: Record<string, unknown>;
  configuration: {
    status: 'defaults' | 'trusted-static' | 'trusted-executable' | 'requires-trust' | 'invalid';
    file: string | null;
    executable: boolean;
    trusted: boolean;
    errors: string[];
  };
  authority: {
    singleWriter: string;
    requiresExplicitUserApproval: string[];
    forbiddenGlobalWrites: string[];
  };
  nextCommands: string[];
  contextBytes: number;
  contextBudget: 12288;
  contextTruncated?: true;
}

export class CodexIntegrationError extends Error { code: string }
export const CODEX_INTEGRATION_SCHEMA: 'axion-codex-integration/v1';
export const CODEX_INSTALL_RECEIPT_SCHEMA: 'axion-codex-skill-install/v1';
export const CODEX_SKILL_NAME: 'dk-design';
export const CODEX_SKILL_PATH: '.agents/skills/dk-design';
export const CODEX_CONTEXT_SCHEMA: 'axion-codex-context/v1';
export const CODEX_CONTEXT_MAX_BYTES: 12288;
export function codexSkillDigest(directory?: string): string;
export function inspectCodexIntegration(root?: string): CodexIntegrationInspection;
export function installCodexIntegration(root?: string, options?: { now?: string }): CodexIntegrationInspection & { changed: boolean };
export function codexStarterPrompt(lane?: CodexDesignLane): string;
export function codexStarterPrompts(): Record<CodexDesignLane, string>;
export function buildCodexDesignContext(root?: string, options?: { trustProjectConfig?: boolean }): Promise<CodexDesignContext>;
export type DkA11yTag =
  | 'wcag2a'
  | 'wcag2aa'
  | 'wcag2aaa'
  | 'wcag21a'
  | 'wcag21aa'
  | 'wcag22aa'
  | 'best-practice'
  | 'section508'
  | 'ACT'
  | 'EN-301-549'
  | 'RGAAv4'
  | 'TTv5'
  | 'experimental';

export type DkProofAction =
  | { type: 'click' | 'check' | 'uncheck'; selector: string; timeoutMs?: number }
  | { type: 'fill'; selector: string; value: string; timeoutMs?: number }
  | { type: 'select'; selector: string; value: string | string[]; timeoutMs?: number }
  | { type: 'press'; selector: string; key: string; timeoutMs?: number }
  | { type: 'waitFor'; selector: string; state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeoutMs?: number };

export type DkProofState = 'default' | {
  name: string;
  actions?: DkProofAction[];
  waitFor?: string;
};

export type DkProofRoute = string | {
  name?: string;
  path: string;
  waitFor?: string;
  /** When present, replaces the global proof.states matrix for this route. */
  states?: DkProofState[];
};

export type DkProofViewport = number | {
  name?: string;
  width: number;
  height: number;
};

export type DkProofTheme = string | {
  name: string;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  /** Attributes applied to document.documentElement before and after navigation. */
  attributes?: Record<string, string>;
  /** Classes applied to document.documentElement before and after navigation. */
  classes?: string[];
};

export interface DkAppProofConfig {
  /** URL of an already running HTTP(S) dev/preview server. */
  baseUrl: string;
  /** Explicit routes, or same-origin links visible from the entry URL. */
  routes?: 'auto' | DkProofRoute[];
  states?: DkProofState[];
  viewports?: DkProofViewport[];
  themes?: DkProofTheme[];
  timeoutMs?: number;
  maxRoutes?: number;
  maxCases?: number;
}

export interface DkNormalizedProofState {
  name: string;
  actions: DkProofAction[];
  waitFor: string | null;
}

export interface DkNormalizedProofRoute {
  name: string;
  path: string;
  url: string;
  waitFor: string | null;
  states: DkNormalizedProofState[] | null;
}

export interface DkNormalizedProofViewport { name: string; width: number; height: number }
export interface DkNormalizedProofTheme {
  name: string;
  colorScheme: 'light' | 'dark' | 'no-preference';
  attributes: Record<string, string>;
  classes: string[];
}

export interface DkAppProofPlan {
  baseUrl: string;
  routes: 'auto' | DkNormalizedProofRoute[];
  states: DkNormalizedProofState[];
  viewports: DkNormalizedProofViewport[];
  themes: DkNormalizedProofTheme[];
  timeoutMs: number;
  maxRoutes: number;
  maxCases: number;
}

export interface DkAppProofCase {
  id: string;
  label: string;
  url: string;
  route: DkNormalizedProofRoute;
  state: DkNormalizedProofState;
  viewport: DkNormalizedProofViewport;
  theme: DkNormalizedProofTheme;
  matrix: { route: string; state: string; viewport: string; theme: string };
}

export interface DkTokenOutput {
  css?: string;
  js?: string;
  json?: string;
  [format: string]: string | undefined;
}

export interface DkCustomFinding {
  severity?: Exclude<DkSeverity, 'off'>;
  file?: string;
  line?: number;
  col?: number;
  message?: string;
  evidence?: string;
  fix?: string;
}

export interface DkRuleContext {
  source: string;
  file: string;
  manifest: unknown;
  resolve(token: string, mode?: 'light' | 'dark'): string | null;
  contrast(foreground: string, background: string): number | null;
  emits(key: string): unknown;
}

export interface DkSlopRule {
  id: string;
  zone?: 'style' | 'all';
  pattern?: string;
  flags?: string;
  severity?: Exclude<DkSeverity, 'off'>;
  message?: string;
  hint?: string;
  fix?: string;
  test?(context: DkRuleContext): DkCustomFinding[] | undefined | null;
}

export type DkBridgeTrust = 'untrusted' | 'linked' | 'verified';
export type DkBridgeRole = 'source' | 'sink' | 'both';
export type DkBridgePermission =
  | 'filesystem:read'
  | 'filesystem:write'
  | 'network:read'
  | 'network:write'
  | 'environment:read'
  | 'process:execute'
  | (string & {});

export interface DkBridgeConnection {
  id: string;
  adapter: string;
  role?: DkBridgeRole;
  enabled?: boolean;
  required?: boolean;
  trust?: DkBridgeTrust;
  source?: string;
  /** Explicit local custom-adapter module. Loading executable modules requires declared permissions. */
  module?: string;
  permissions?: DkBridgePermission[];
  /** Provider options. Credentials must be referenced by *Env field name and never placed inline. */
  options?: Record<string, unknown>;
}

export interface DkBridgeConfig {
  enabled?: boolean;
  /** Portable manifest; an existing design/bridge.json is auto-discovered by default. */
  source?: string;
  artifactDir?: string;
  timeoutMs?: number;
  maxArtifactBytes?: number;
  freshnessMs?: number;
  connections?: DkBridgeConnection[];
}

export interface DkConfig {
  preset?: DkPreset;
  tokens?: {
    source?: string;
    output?: DkTokenOutput;
  };
  /** Portable AI art-direction contract; validated and fingerprinted when present. */
  direction?: {
    source?: string;
    lock?: string;
    /** Require an approved, Taste-Locked direction; drafts and unlocked contracts block verification. */
    required?: boolean;
  };
  targets?: string[];
  ignore?: string[];
  failOn?: DkFailOn;
  /** Treat an attempted heavy gate that cannot run as a blocking failure. */
  failOnSkipped?: boolean;
  tokens_required?: string[];
  contrast?: {
    algorithm?: 'wcag' | 'apca';
    modes?: Array<'light' | 'dark'>;
    pairs?: Array<[foregroundToken: string, backgroundToken: string, minimum: number]>;
  };
  enforce?: {
    spacing?: DkEnforcement;
    radius?: DkEnforcement;
    type?: DkEnforcement;
  };
  slop?: {
    fonts?: { allow?: string[]; deny?: string[] };
    rules?: DkSlopRule[];
  };
  severity?: Record<string, DkSeverity>;
  allowlist?: Record<string, string[]>;
  /** Real running-app coverage consumed by `dk verify --gate a11y`. */
  proof?: DkAppProofConfig;
  gates?: {
    cssStrict?: { enabled?: boolean };
    a11y?: {
      enabled?: boolean;
      /** Supported Axe standards/profile tags. `[]` runs Axe's default all-rules selection. */
      tags?: DkA11yTag[];
    };
    visual?: {
      enabled?: boolean;
      viewports?: number[];
      themes?: string[];
    };
    bridge?: { enabled?: boolean };
  };
  bridge?: DkBridgeConfig;
  baseline?: string;
  report?: Record<string, unknown>;
}

export interface DkResolvedConfig extends DkConfig {
  cwd: string;
  configFile: string | null;
  presetName: DkPreset;
  tokensPath: string;
  directionPath: string;
  directionLockPath: string;
  baselinePath: string;
  bridge: Required<Pick<DkBridgeConfig, 'enabled' | 'timeoutMs' | 'maxArtifactBytes' | 'freshnessMs' | 'connections'>> & {
    sourcePath: string;
    artifactDir: string;
  };
  errors: Array<Record<string, unknown>>;
}

/** Identity helper that validates and completes dk.config.mjs in TypeScript-aware editors. */
export function defineConfig<const T extends DkConfig>(config: T): T;
export function loadConfig(cwd?: string): Promise<DkResolvedConfig>;

export class AppProofConfigError extends Error {
  readonly code: 'DK_PROOF_CONFIG';
  readonly issues: string[];
}

export function normalizeAppProofConfig(
  input: DkAppProofConfig,
): DkAppProofPlan;
export function validateAppProofConfig(input: unknown): string[];
export function buildAppProofMatrix(
  plan: DkAppProofPlan,
  concreteRoutes?: DkNormalizedProofRoute[],
): DkAppProofCase[];
export function appProofCaseId(matrix: DkAppProofCase['matrix']): string;
export function appProofConfigHash(plan: DkAppProofPlan, tags?: DkA11yTag[]): string;
export function normalizeDiscoveredRoutes(plan: DkAppProofPlan, hrefs: Iterable<string>): DkNormalizedProofRoute[];
export function applyAppProofCliOverrides<T extends { proof?: DkAppProofConfig }>(
  config: T,
  flags?: { app?: string | true; routes?: string | true },
): T & { proof?: DkAppProofConfig };

export const APPROVAL_HISTORY_SCHEMA: 'dk-approval-history/v1';
export const APPROVAL_ENTRY_SCHEMA: 'dk-approval/v1';

export interface DkApprovalEvidence {
  report: string | null;
  reportHash: string | null;
  generatedAt: string | null;
  status: string | null;
  exitCode: number | null;
  counts: { error: number; warn: number; info: number } | null;
  gates: Array<{ id: string; status: string; reason?: string }>;
}
export interface DkApprovalEntry {
  schema: 'dk-approval/v1';
  id: string;
  action: 'created' | 'updated';
  directionName: string;
  directionHash: string;
  bindingHash: string;
  actor: string;
  reason: string;
  createdAt: string;
  previousHash: string | null;
  evidence: DkApprovalEvidence | null;
  entryHash: string;
}
export interface DkApprovalHistory {
  schema: 'dk-approval-history/v1';
  entries: DkApprovalEntry[];
}
export interface DkApprovalHistoryRead {
  ok: boolean;
  missing: boolean;
  history: DkApprovalHistory | null;
  issues: Array<{ code: string; index?: number | null; field?: string; message: string }>;
  headHash: string | null;
}
export class ApprovalHistoryError extends Error {
  readonly code: 'DK_APPROVAL_HISTORY';
  readonly issues: DkApprovalHistoryRead['issues'];
}
export function defaultApprovalHistoryPath(lockPath: string): string;
export function emptyApprovalHistory(): DkApprovalHistory;
export function readApprovalHistory(path: string): DkApprovalHistoryRead;
export function validateApprovalHistory(history: unknown): Omit<DkApprovalHistoryRead, 'missing' | 'history'>;
export function appendApproval(
  root: string,
  path: string,
  input: {
    directionName: string;
    directionHash: string;
    bindingHash: string;
    actor?: string;
    reason?: string;
    evidence?: DkApprovalEvidence | null;
  },
  options?: { now?: string | number | Date },
): { entry: DkApprovalEntry; history: DkApprovalHistory; headHash: string; path: string };
export function readVerificationEvidence(root: string, reportPath?: string): DkApprovalEvidence | null;
export function resolveApprovalActor(explicit?: string | null, env?: Record<string, string | undefined>): string;

export const DRIFT_BENCHMARK_SCHEMA: 'dk-drift-benchmark/v1';
export interface DkDriftBenchmarkRound {
  round: number;
  id: string;
  dimension: string;
  mutation: string;
  expectedRule: string;
  expectedDetected: boolean;
  observedRules: string[];
  exitCode: number;
  findingCount: number;
  detectionMs: number;
  recoveryClean: boolean;
  recoveryExitCode: number;
  recoveryFindingCount: number;
  recoveryMs: number;
  timeoutPhase?: 'detection' | 'recovery';
}
export interface DkDriftBenchmarkFailure {
  kind: 'timeout';
  phase: 'baseline' | 'detection' | 'recovery';
  round: number | null;
  scenarioId: string | null;
  message: string;
}
export interface DkDriftBenchmarkReport {
  schema: 'dk-drift-benchmark/v1';
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  isolation: string;
  command: string;
  timeoutMs: number;
  rounds: number;
  completedRounds: number;
  detected: number;
  recovered: number;
  detectionRate: number;
  recoveryRate: number;
  cleanChecks: number;
  timeouts: number;
  unexpectedFindings: number;
  medianDetectionMs: number;
  p95DetectionMs: number;
  dimensions: string[];
  results: DkDriftBenchmarkRound[];
  failure: DkDriftBenchmarkFailure | null;
  proofHash: string;
  workspace: string | null;
}
export function runDriftBenchmark(options?: {
  cli?: string;
  scaffold?: string;
  tempRoot?: string;
  keepWorkspace?: boolean;
  throwOnFailure?: boolean;
  /** Per `dk verify` subprocess, in milliseconds. Defaults to 30000; allowed range is 100–300000. */
  timeoutMs?: number;
}): Promise<DkDriftBenchmarkReport>;
export function renderDriftBenchmarkHtml(report: DkDriftBenchmarkReport): string;

export interface DkSystemNode {
  id: string;
  kind: 'component' | 'story' | 'route' | 'token' | 'stylesheet' | string;
  label: string;
  file: string | null;
  line: number | null;
  evidence?: string | null;
  meta?: Record<string, unknown>;
}
export interface DkSystemEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  evidence?: string | null;
}
export interface DkSystemProofSource {
  file: string;
  line: number;
  evidence: string;
}
export type DkSystemRouteProofEvidence =
  | {
      kind: 'declared-browser-test';
      verification: 'unexecuted';
      file: string;
      labels: string[];
      screenshots: string[];
    }
  | {
      kind: 'screenshot-file';
      verification: 'unverified';
      file: string;
    }
  | {
      kind: 'app-proof-case';
      verification: 'successful';
      file: string;
      id: string;
      matrix: DkAppProofCase['matrix'];
      url: string;
    };
export interface DkSystemProofRoute {
  route: string;
  file: string;
  line: number;
  evidence: string;
  sources: DkSystemProofSource[];
  states: string[];
  viewports: Array<string | number>;
  themes: string[];
  proof: DkSystemRouteProofEvidence[];
  status: 'discovered' | 'evidence-linked' | 'proven';
}
export interface DkSystemStoryState {
  component: string | null;
  story: string;
  state: string | null;
  file: string;
}
export interface DkSystemTestEvidence {
  file: string;
  tests: string[];
  routes: string[];
  states: string[];
  viewports: Array<number | 'mobile' | 'tablet' | 'desktop'>;
  screenshots: string[];
}
export interface DkSystemAppProofSummary {
  status: 'missing' | 'invalid' | 'quality-failed' | 'unattested' | 'stale' | 'complete';
  path: string;
  reason: string | null;
  caseCount: number;
  finishedAt: string | null;
  configHash: string | null;
}
export interface DkSystemProofSummary {
  routeCount: number;
  provenRoutes: number;
  evidenceLinkedRoutes: number;
  provenCases: number;
  states: string[];
  themes: string[];
  screenshotCount: number;
  testFileCount: number;
}
export interface DkProofSurfaces {
  schema: 'dk-proof-surfaces/v1';
  routes: DkSystemProofRoute[];
  storyStates: DkSystemStoryState[];
  tests: DkSystemTestEvidence[];
  appProof: DkSystemAppProofSummary;
  summary: DkSystemProofSummary;
}
export interface DkSystemGraph {
  schema: 'dk-system-graph/v1';
  generatedAt: string;
  root: string;
  stats: { nodes: number; edges: number; sourceFiles: number; imageFiles: number; kinds: Record<string, number>; relations: Record<string, number> };
  nodes: DkSystemNode[];
  edges: DkSystemEdge[];
  proof: DkProofSurfaces;
  warnings: Array<{ kind: string; file: string | null; message: string }>;
}
export interface DkSystemIndexOptions {
  maxFiles?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  includeGenerated?: boolean;
  tokensPath?: string | string[];
  now?: string | Date;
}
export function indexRepository(root?: string, options?: DkSystemIndexOptions): DkSystemGraph;
export function discoverProofSurfaces(root?: string, options?: DkSystemIndexOptions): DkProofSurfaces;
export function writeSystemGraph(graph: DkSystemGraph, outputPath: string, options?: { root?: string }): string;

export interface DkStudioController {
  root: string;
  host: string;
  port: number;
  readonly address: unknown;
  readonly url: string;
  server: unknown;
  graph(force?: boolean): DkSystemGraph;
  snapshot(force?: boolean): Promise<Record<string, unknown>>;
  invalidate(): void;
  listen(): Promise<DkStudioController>;
  close(): Promise<void>;
}
export function createStudioServer(options?: {
  root?: string;
  host?: string;
  port?: number;
  allowRemote?: boolean;
  cacheTtl?: number;
}): DkStudioController;
export function startStudio(options?: Parameters<typeof createStudioServer>[0]): Promise<DkStudioController>;
export function collectStudioSnapshot(root?: string, options?: { graph?: DkSystemGraph; now?: string | Date }): Promise<Record<string, unknown>>;
export function readSourceExcerpt(root: string, file: string, line?: number | string, context?: number | string): Record<string, unknown>;
export function resolveInside(root: string, file: string): string;

export type AxionBridgeTrustLevel = 'untrusted' | 'self-attested' | 'verified';
export type AxionBridgeLifecycle = 'discover' | 'collect' | 'publish';
export interface AxionBridgeIssue { path: string; code: string; message: string }
export interface AxionBridgeAdapterManifest {
  schema: 'axion-bridge-adapter/v1';
  id: string;
  provider: string;
  version: string;
  lifecycle: AxionBridgeLifecycle[];
  permissions: Record<AxionBridgeLifecycle, string[]>;
  digest: string;
}
export interface AxionBridgeArtifact {
  path: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}
export interface AxionBridgeEnvelope<T = unknown> {
  schema: 'axion-bridge-envelope/v1';
  id: string;
  provider: string;
  kind: string;
  createdAt: string;
  expiresAt: string | null;
  trust: { level: AxionBridgeTrustLevel; issuer: string; evidence: string[] };
  binding: { repository: string | null; commit: string | null };
  permissions: string[];
  payload: T;
  artifacts: AxionBridgeArtifact[];
  digest: string;
}
export interface AxionBridgeAudit {
  schema: 'axion-bridge-status/v1';
  generatedAt: string;
  status: 'passed' | 'incomplete' | 'failed';
  repository: { root: string; remote: string | null; commit: string | null };
  ledger: { path: string; missing: boolean; ok: boolean; headHash: string | null; summary?: unknown };
  summary: { total: number; healthy: number; failed: number; incomplete: number; requiredFailed: number };
  connections: Array<Record<string, unknown>>;
  issues: Array<{ severity: 'error' | 'warn'; connection: string | null; code: string; message: string; path?: string | null }>;
}
export const ADAPTER_MANIFEST_SCHEMA: 'axion-bridge-adapter/v1';
export const INTEGRATION_ENVELOPE_SCHEMA: 'axion-bridge-envelope/v1';
export const ARTIFACT_LEDGER_SCHEMA: 'axion-bridge-ledger/v1';
export const MAX_BRIDGE_LEDGER_BYTES: number;
export function createAdapterManifest(input: {
  id: string; provider?: string; version?: string; lifecycle: AxionBridgeLifecycle[];
  permissions?: Partial<Record<AxionBridgeLifecycle, string[]>>;
}): AxionBridgeAdapterManifest;
export function validateAdapterManifest(manifest: unknown): AxionBridgeIssue[];
export function createIntegrationEnvelope<T = unknown>(input: {
  id?: string; provider: string; kind: string; createdAt?: string | number | Date; expiresAt?: string | number | Date | null;
  trust?: { level?: AxionBridgeTrustLevel; issuer?: string; evidence?: string[] };
  binding?: { repository?: string | null; commit?: string | null };
  permissions?: string[]; payload: T; artifacts?: AxionBridgeArtifact[];
}, options?: { now?: string | number | Date }): AxionBridgeEnvelope<T>;
export function validateIntegrationEnvelope(envelope: unknown, policy?: Record<string, unknown>): AxionBridgeIssue[];
export class AdapterRegistry {
  constructor(adapters?: object[]);
  register(adapter: object): this;
  list(lifecycle?: AxionBridgeLifecycle): object[];
}
export class BridgeRuntime {
  constructor(options?: Record<string, unknown>);
  discover(input?: object, options?: object): Promise<Record<string, unknown>>;
  collect(input?: object, options?: object): Promise<Record<string, unknown>>;
  publish(input: { envelope: AxionBridgeEnvelope }, options?: object): Promise<Record<string, unknown>>;
}
export function createBridgeRuntime(options?: Record<string, unknown>): BridgeRuntime;
export function readArtifactLedger(root: string, options?: Record<string, unknown>): Record<string, unknown>;
export function verifyArtifactLedger(ledger: unknown, options?: Record<string, unknown>): { ok: boolean; issues: AxionBridgeIssue[]; headHash: string | null; summary: unknown };
export function bridgeGitIdentity(root?: string, env?: Record<string, string | undefined>): { root: string; remote: string | null; commit: string | null };
export function bridgeConnectionContractDigest(connection: DkBridgeConnection, root?: string): string;
export function builtInAdapterCatalog(): Promise<Array<{ id: string; version: string; kind: string; capabilities: string[]; permissions: Record<AxionBridgeLifecycle, string[]> }>>;
export function syncBridge(config: DkResolvedConfig, options?: { ids?: string[]; publish?: boolean; env?: Record<string, string | undefined>; fetch?: typeof fetch }): Promise<Record<string, unknown>>;
export function auditBridge(config: DkResolvedConfig, options?: Record<string, unknown>): AxionBridgeAudit;
export function latestBridgeEnvelope(config: DkResolvedConfig, id: string): AxionBridgeEnvelope | null;
export function ingestBridgeEnvelope(config: DkResolvedConfig, id: string, envelope: AxionBridgeEnvelope, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export function initializeBridgeManifest(root: string, sourcePath?: string): { path: string; manifest: { schema: 'axion-bridge-config/v1'; connections: DkBridgeConnection[] } };
export function safeFetch(url: string | URL, options?: {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  timeoutMs?: number;
  maxBytes?: number;
  allowRedirects?: boolean;
  maxRedirects?: number;
  validateUrlOptions?: {
    label?: string;
    allowHttpLoopback?: boolean;
    httpsOnly?: boolean;
    allowedOrigins?: string[];
    allowedHosts?: string[];
    allowSensitiveQuery?: boolean;
  };
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ response: Response; bytes: Uint8Array; url: URL; redirects: number }>;
