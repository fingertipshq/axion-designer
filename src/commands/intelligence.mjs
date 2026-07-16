import { pick } from '../core/i18n.mjs';
import {
  loadIntelligenceCatalog,
  recommendDesignDirections,
} from '../intelligence/index.mjs';

const EXIT_OK = 0;
const EXIT_USAGE = 2;

export async function cmdIntelligence(args, flags) {
  const subcommand = String(args[0] ?? 'help').toLowerCase();
  if (subcommand === 'help') {
    printIntelligenceHelp();
    return EXIT_OK;
  }
  try {
    if (subcommand === 'catalog') {
      if (args.length !== 1) return usage('dk intelligence catalog [--json]');
      const catalog = await loadIntelligenceCatalog();
      if (flags.json) process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
      else renderCatalog(catalog);
      return EXIT_OK;
    }
    if (subcommand === 'recommend') {
      const brief = args.slice(1).join(' ').trim();
      if (!brief) return usage('dk intelligence recommend <brief> [--stack <stack>] [--density <density>] [--motion <motion>] [--contrast <contrast>] [--variance <0-100>] [--json]');
      const options = compact({
        stack: value(flags.stack),
        density: value(flags.density),
        motion: value(flags.motion),
        contrast: value(flags.contrast),
        variance: flags.variance == null ? undefined : Number(flags.variance),
      });
      if (options.variance != null && (!Number.isFinite(options.variance) || options.variance < 0 || options.variance > 100)) {
        return usage(pick('dk intelligence recommend <brief> --variance <0-100>', 'dk intelligence recommend <brief> --variance <0-100>'));
      }
      const recommendation = await recommendDesignDirections(brief, options);
      if (flags.json) process.stdout.write(`${JSON.stringify(recommendation, null, 2)}\n`);
      else renderRecommendation(recommendation);
      return EXIT_OK;
    }
    process.stderr.write(pick(
      `未知 Intelligence 子命令：${subcommand}\n執行 dk intelligence help 看用法。\n`,
      `Unknown Intelligence subcommand: ${subcommand}\nRun dk intelligence help for usage.\n`,
    ));
    return EXIT_USAGE;
  } catch (error) {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({
        schema: 'axion-design-intelligence-error/v1',
        code: error?.code ?? 'DK_INTELLIGENCE',
        error: error?.message ?? String(error),
      })}\n`);
    } else process.stderr.write(`${error?.message ?? error}\n`);
    return EXIT_USAGE;
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function value(input) {
  return input == null || input === true ? undefined : String(input);
}

function renderCatalog(catalog) {
  const domains = Array.isArray(catalog.domains) ? catalog.domains : Object.keys(catalog.domains ?? {});
  const stacks = Array.isArray(catalog.stacks) ? catalog.stacks : Object.keys(catalog.stacks ?? {});
  process.stdout.write([
    '',
    'Axion Design Intelligence',
    `  ${pick('知識領域', 'domains')}  ${domains.join(' · ')}`,
    `  ${pick('技術棧', 'stacks')}    ${stacks.join(' · ')}`,
    `  ${pick('模式', 'mode')}      offline · deterministic · no API key`,
    '',
  ].join('\n'));
}

function renderRecommendation(result) {
  const directions = result.directions ?? result.recipes ?? [];
  const confidence = result.confidence?.score ?? result.confidence ?? result.normalized?.confidence ?? 'n/a';
  const lines = [
    '',
    `Axion Design Intelligence · ${pick('三方向建議', 'three-direction recommendation')}`,
    `  ${pick('意圖', 'intent')}      ${result.normalizedIntent?.intent ?? result.normalized?.intent ?? result.intent ?? '—'}`,
    `  ${pick('技術棧', 'stack')}      ${result.constraints?.stack ?? result.stack ?? '—'}`,
    `  ${pick('信心', 'confidence')} ${confidence}`,
    '',
  ];
  directions.forEach((direction, index) => {
    lines.push(`${index + 1}. ${direction.name ?? direction.title ?? `Direction ${index + 1}`}`);
    lines.push(`   ${direction.thesis ?? direction.rationale ?? direction.reason ?? ''}`.trimEnd());
    const signature = direction.signature ?? direction.recipe?.signature;
    if (signature) lines.push(`   ${pick('辨識度', 'signature')}: ${typeof signature === 'string' ? signature : JSON.stringify(signature)}`);
    const tradeoff = direction.tradeoff ?? direction.recipe?.tradeoff;
    if (tradeoff) lines.push(`   ${pick('取捨', 'trade-off')}: ${tradeoff}`);
  });
  if (Array.isArray(result.warnings) && result.warnings.length) {
    lines.push('', `${pick('需要確認', 'Needs confirmation')}:`);
    lines.push(...result.warnings.map((warning) => `  - ${typeof warning === 'string' ? warning : warning.message ?? JSON.stringify(warning)}`));
  }
  lines.push('', pick('機器格式：dk intelligence recommend <brief> --json', 'Machine form: dk intelligence recommend <brief> --json'), '');
  process.stdout.write(lines.join('\n'));
}

function usage(form) {
  process.stderr.write(pick(`用法：${form}\n`, `Usage: ${form}\n`));
  return EXIT_USAGE;
}

export function printIntelligenceHelp() {
  process.stdout.write(pick(`
dk intelligence — 離線、可重現的九領域設計建議

  dk intelligence catalog [--json]
      列出知識領域與受支援技術棧。

  dk intelligence recommend <brief> [--json]
      [--stack react|next|vue|nuxt|svelte|astro|html-tailwind|shadcn]
      [--density compact|balanced|airy]
      [--motion none|subtle|expressive]
      [--contrast standard|high] [--variance 0-100]

輸出固定為三個結構、字體、色彩分配、密度與辨識特徵都有實質差異的方向。
完全離線，不呼叫模型或網路；低信心時會顯示待確認項，不會情境不明卻偷偷回傳通用模板。
`, `
dk intelligence — offline, reproducible nine-domain design recommendations

  dk intelligence catalog [--json]
      List the knowledge domains and supported implementation stacks.

  dk intelligence recommend <brief> [--json]
      [--stack react|next|vue|nuxt|svelte|astro|html-tailwind|shadcn]
      [--density compact|balanced|airy]
      [--motion none|subtle|expressive]
      [--contrast standard|high] [--variance 0-100]

Always returns three materially distinct directions across structure, type, color allocation, density, and signature.
Runs offline with no model or network call; low confidence is surfaced as confirmation needs instead of a silent generic fallback.
`));
}
