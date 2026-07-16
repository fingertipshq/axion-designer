export type ClaudeIntegrationStatus = 'missing' | 'ready' | 'stale' | 'invalid';
export type ClaudeDesignLane = 'auto' | 'explore' | 'refine' | 'reconstruct' | 'reimagine' | 'verify';

export interface ClaudeIntegrationInspection {
  schema: 'axion-claude-integration/v1';
  status: ClaudeIntegrationStatus;
  project: string;
  scope: 'repository';
  activation: 'explicit';
  scopeGuard: { status: 'ready' | 'forbidden'; issue: string | null };
  skill: {
    name: 'dk-design';
    path: '.claude/skills/dk-design';
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

export class ClaudeIntegrationError extends Error { code: string }
export const CLAUDE_INTEGRATION_SCHEMA: 'axion-claude-integration/v1';
export const CLAUDE_INSTALL_RECEIPT_SCHEMA: 'axion-claude-skill-install/v1';
export const CLAUDE_SKILL_NAME: 'dk-design';
export const CLAUDE_SKILL_PATH: '.claude/skills/dk-design';
export function claudeSkillDigest(directory?: string): string;
export function inspectClaudeIntegration(root?: string): ClaudeIntegrationInspection;
export function installClaudeIntegration(root?: string, options?: { now?: string }): ClaudeIntegrationInspection & { changed: boolean };
export function claudeStarterPrompt(lane?: ClaudeDesignLane): string;
export function claudeStarterPrompts(): Record<ClaudeDesignLane, string>;
