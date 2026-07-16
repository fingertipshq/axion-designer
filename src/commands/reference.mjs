import { pick } from '../core/i18n.mjs';
import {
  ALLOWED_OPERATIONS,
  LICENCE_STATUSES,
  REFERENCE_KINDS,
  ReferenceSystemError,
  ReferenceValidationError,
  createReferenceSystem,
} from '../reference/index.mjs';
import { readRegularFileInside } from '../reference/safety.mjs';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

export async function cmdReference(args, flags, cwd) {
  const subcommand = String(args[0] ?? 'help').toLowerCase();
  if (subcommand === 'help') { printReferenceHelp(); return EXIT_OK; }
  const system = createReferenceSystem(cwd);
  try {
    if (subcommand === 'add') return addReference(system, args.slice(1), flags);
    if (subcommand === 'decompose') return ingestDraft(system, 'decompose', args.slice(1), flags);
    if (subcommand === 'map') return ingestDraft(system, 'map', args.slice(1), flags);
    if (subcommand === 'plan') return ingestDraft(system, 'plan', args.slice(1), flags);
    if (subcommand === 'compare') return compareReference(system, args.slice(1), flags);
    if (subcommand === 'status' || subcommand === 'validate') {
      if (args.length !== 1) return usage(`dk reference ${subcommand} [--json]`);
      const status = system.inspectStatus();
      printResult(status, flags, renderStatus);
      return subcommand === 'validate' && status.status !== 'complete' ? EXIT_FAIL : EXIT_OK;
    }
    process.stderr.write(pick(
      `未知 Reference 子命令：${subcommand}\n執行 dk reference help 看用法。\n`,
      `Unknown Reference subcommand: ${subcommand}\nRun dk reference help for usage.\n`,
    ));
    return EXIT_USAGE;
  } catch (error) {
    return printError(error, flags);
  }
}

function addReference(system, args, flags) {
  if (args.length !== 2 || !hasValues(flags, ['source', 'license', 'scope', 'viewport'])) {
    return usage('dk reference add <id> <image> --source <provenance> --license <status> --scope <path-or-route,...> --viewport <WxH[@DPR]> [--json]');
  }
  const licence = String(flags.license).toLowerCase();
  if (!LICENCE_STATUSES.includes(licence)) return usage(`dk reference add ... --license <${LICENCE_STATUSES.join('|')}>`);
  const viewport = parseViewport(String(flags.viewport));
  const scope = parseScope(String(flags.scope));
  const source = String(flags.source).trim();
  const result = system.registerReferences([{
    id: args[0],
    path: args[1],
    provenance: {
      type: /^https?:\/\//i.test(source) ? 'url-capture' : 'user-provided',
      source,
      author: null,
      notes: null,
    },
    licence: { status: licence, identifier: null, termsUrl: null, attribution: null, notes: null },
    viewport,
    authorizedScope: {
      ...scope,
      operations: licence === 'unknown'
        ? ['decompose']
        : ALLOWED_OPERATIONS.filter((operation) => operation !== 'extract-assets'),
      notes: 'Authorized explicitly through dk reference add.',
    },
  }]);
  const payload = {
    schema: 'axion-reference-command/v1',
    command: 'add',
    status: 'registered',
    reference: result.artifact.references.find((entry) => entry.id === args[0]),
    manifest: { path: result.path, sha256: result.sha256 },
    next: `Create a visual-decomposition/v1 draft, then run dk reference decompose <draft.json>.`,
  };
  printResult(payload, flags, (value) => [
    '', `✓ ${pick('參考圖已註冊', 'Reference registered')} · ${value.reference.id}`,
    `  ${pick('證據', 'evidence')}   ${value.manifest.path}`,
    `  SHA-256   ${value.reference.sha256}`,
    `  ${pick('授權範圍', 'scope')}      ${[...value.reference.authorizedScope.projectPaths, ...value.reference.authorizedScope.routes].join(', ')}`,
    `  ${pick('下一步', 'next')}       ${value.next}`, '',
  ].join('\n'));
  return EXIT_OK;
}

function ingestDraft(system, kind, args, flags) {
  if (args.length !== 1) return usage(`dk reference ${kind} <draft.json> [--json]`);
  const draft = readDraft(system, args[0]);
  const methods = {
    decompose: ['writeVisualDecomposition', REFERENCE_KINDS.decomposition, 'dk reference map <draft.json>'],
    map: ['writeComponentMapping', REFERENCE_KINDS.mapping, 'dk reference plan <draft.json>'],
    plan: ['writeReconstructionPlan', REFERENCE_KINDS.plan, 'Implement the bounded plan, run App Proof for the declared viewport, then compare its deterministic case screenshot.'],
  };
  const [method, expectedKind, next] = methods[kind];
  const result = system[method](draft);
  const payload = {
    schema: 'axion-reference-command/v1', command: kind, status: 'written',
    artifact: { kind: result.artifact.kind, path: result.path, sha256: result.sha256, bytes: result.bytes }, next,
  };
  if (payload.artifact.kind !== expectedKind) throw new Error(`unexpected ${kind} artifact kind`);
  printResult(payload, flags, (value) => [
    '', `✓ ${value.artifact.kind}`, `  path     ${value.artifact.path}`, `  SHA-256  ${value.artifact.sha256}`,
    `  ${pick('下一步', 'next')}     ${value.next}`, '',
  ].join('\n'));
  return EXIT_OK;
}

function compareReference(system, args, flags) {
  if (args.length < 3) return usage('dk reference compare <reference-id> <candidate-image> <implementation-files...> [--json]');
  const result = system.compareReference({
    referenceId: args[0], candidatePath: args[1], implementationFiles: args.slice(2),
  });
  const comparison = result.artifact;
  const payload = {
    schema: 'axion-reference-command/v1', command: 'compare', status: comparison.status,
    artifact: { path: result.path, sha256: result.sha256, bytes: result.bytes },
    metrics: comparison.metrics,
    capture: comparison.capture,
    policy: comparison.policy,
    highestDeltas: comparison.highestDeltas,
  };
  printResult(payload, flags, (value) => [
    '', `${comparison.status === 'match' ? '✓' : comparison.status === 'incomplete' ? '○' : '!'} Reference comparison · ${comparison.status}`,
    `  ${pick('尺寸', 'dimensions')}  ${value.metrics.dimensions.match ? 'match' : `${value.metrics.dimensions.widthDeltaPx}px × ${value.metrics.dimensions.heightDeltaPx}px delta`}`,
    `  ${pick('瀏覽器擷圖', 'browser capture')}  ${value.capture.status}${value.capture.reason ? ` · ${value.capture.reason}` : ''}`,
    `  ${pick('防作弊', 'anti-cheat')}  ${value.policy.noWholeReferenceBackground.status}`,
    `  ${pick('證據', 'evidence')}    ${value.artifact.path}`,
    ...value.highestDeltas.map((delta, index) => `  ${index + 1}. [${delta.severity}] ${delta.summary}`), '',
  ].join('\n'));
  return comparison.status === 'mismatch' ? EXIT_FAIL : EXIT_OK;
}

function readDraft(system, path) {
  const loaded = readRegularFileInside(system.projectRoot, path, { label: 'reference draft', maxBytes: MAX_DRAFT_BYTES });
  try { return JSON.parse(loaded.bytes.toString('utf8')); }
  catch { throw new ReferenceValidationError([`reference draft is not valid JSON: ${loaded.relative}`]); }
}

function parseViewport(value) {
  const match = /^(\d{1,5})x(\d{1,5})(?:@(\d+(?:\.\d+)?))?$/.exec(value.trim());
  if (!match) throw new ReferenceValidationError(['viewport must use WxH or WxH@DPR, for example 1440x900@1']);
  return { width: Number(match[1]), height: Number(match[2]), deviceScaleFactor: Number(match[3] ?? 1) };
}

function parseScope(value) {
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) throw new ReferenceValidationError(['scope must name at least one project path or route']);
  return {
    projectPaths: entries.filter((entry) => !entry.startsWith('/')),
    routes: entries.filter((entry) => entry.startsWith('/')),
  };
}

function hasValues(flags, keys) { return keys.every((key) => flags[key] != null && flags[key] !== true && String(flags[key]).trim()); }
function printResult(value, flags, render) { process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : render(value)); }

function renderStatus(value) {
  if (value.status === 'missing') return `\n○ ${pick('尚未註冊參考圖。', 'No references registered.')}\n  dk reference add --help\n\n`;
  return [
    '', `${value.status === 'complete' ? '✓' : value.status === 'invalid' ? '✗' : '○'} Reference evidence · ${value.status}`,
    ...(value.manifest ? [`  manifest  ${value.manifest.path}`, `  SHA-256  ${value.manifest.sha256}`] : []),
    ...value.references.map((reference) => `  ${reference.id}  ${Object.entries(reference.stages).map(([stage, status]) => `${stage}:${status}`).join(' · ')}`),
    ...value.issues.slice(0, 10).map((issue) => `  ! ${issue}`), '',
  ].join('\n');
}

function printError(error, flags) {
  const code = error?.code ?? 'DK_REFERENCE';
  const issues = error instanceof ReferenceValidationError ? error.issues : [];
  if (flags.json) process.stdout.write(`${JSON.stringify({ schema: 'axion-reference-error/v1', code, error: error?.message ?? String(error), issues })}\n`);
  else process.stderr.write(`${error?.message ?? error}\n${issues.length ? `${issues.map((issue) => `  - ${issue}`).join('\n')}\n` : ''}`);
  return error instanceof ReferenceSystemError || error instanceof ReferenceValidationError ? EXIT_USAGE : EXIT_USAGE;
}

function usage(form) { process.stderr.write(pick(`用法：${form}\n`, `Usage: ${form}\n`)); return EXIT_USAGE; }

export function printReferenceHelp() {
  process.stdout.write(pick(`
dk reference — 參考圖到真實程式的可追溯證據鏈

  dk reference add <id> <image>
      --source <來源> --license <owned|licensed|permission-granted|public-domain|unknown>
      --scope <src/**,/route,...> --viewport <WxH[@DPR]> [--json]
  dk reference decompose <draft.json> [--json]  驗證並寫入 visual-decomposition/v1
  dk reference map <draft.json> [--json]        驗證並寫入 component-mapping/v1
  dk reference plan <draft.json> [--json]       驗證並寫入 reconstruction-plan/v1
  dk reference compare <id> <candidate-image> <source-files...> [--json]
  dk reference status [--json]                  顯示每張圖的證據鏈進度
  dk reference validate [--json]                完整驗證 digest、links、scope 與 assets

只接受專案內的 1–5 張 PNG／JPEG／WebP。所有輸出只寫 \`.dk/reference/\`；
實作始終由 Codex 在既有技術棧以真實 DOM／component 完成，不允許用整張圖當全頁背景作弊。
\`--license unknown\` 只允許註冊與拆解；在授權狀態釐清前不得對映、重建或比較。
只有目前、完整且由 ledger 認證的 App Proof case 原始截圖路徑，才可能成為 \`match\`／\`complete\`；其他圖片只會成為 advisory \`review\`。
`, `
dk reference — a traceable evidence chain from authorized references to real code

  dk reference add <id> <image>
      --source <provenance> --license <owned|licensed|permission-granted|public-domain|unknown>
      --scope <src/**,/route,...> --viewport <WxH[@DPR]> [--json]
  dk reference decompose <draft.json> [--json]  validate and write visual-decomposition/v1
  dk reference map <draft.json> [--json]        validate and write component-mapping/v1
  dk reference plan <draft.json> [--json]       validate and write reconstruction-plan/v1
  dk reference compare <id> <candidate-image> <source-files...> [--json]
  dk reference status [--json]                  show each reference evidence-chain stage
  dk reference validate [--json]                verify digests, links, scope, and assets

Accepts one to five project-local PNG/JPEG/WebP files. Evidence writes only under \`.dk/reference/\`.
Codex implements real DOM/components in the existing stack; using the whole reference as a page background is a blocking policy failure.
\`--license unknown\` permits registration and decomposition only; mapping, reconstruction, and comparison remain blocked until authorization is clarified.
Only the original screenshot path from a current, complete, ledger-attested App Proof case can become \`match\`/\`complete\`; any other image remains advisory \`review\` evidence.
`));
}
