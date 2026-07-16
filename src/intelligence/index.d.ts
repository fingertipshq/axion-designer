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

