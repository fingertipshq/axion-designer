export type CodexIntegrationStatus = 'missing' | 'ready' | 'stale' | 'invalid';
export type CodexDesignLane = 'auto' | 'explore' | 'refine' | 'reconstruct' | 'reimagine' | 'verify';

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
export function codexSkillDigest(directory?: string): string;
export function inspectCodexIntegration(root?: string): CodexIntegrationInspection;
export function installCodexIntegration(root?: string, options?: { now?: string }): CodexIntegrationInspection & { changed: boolean };
export function codexStarterPrompt(lane?: CodexDesignLane): string;
export function codexStarterPrompts(): Record<CodexDesignLane, string>;
export const CODEX_CONTEXT_SCHEMA: 'axion-codex-context/v1';
export const CODEX_CONTEXT_MAX_BYTES: 12288;
export function buildCodexDesignContext(root?: string, options?: { trustProjectConfig?: boolean }): Promise<CodexDesignContext>;
