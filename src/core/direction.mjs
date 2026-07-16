/* ============================================================
   dk direction core — a compact seam between creative judgment and
   deterministic proof. The contract stores only durable decisions:
   context, visual identity, and semantic token bindings.
   ============================================================ */
import { createHash } from 'node:crypto';
import { pick } from './i18n.mjs';

export const DIRECTION_SCHEMA = 'dk-direction/v2';
export const DIRECTION_LOCK_SCHEMA = 'dk-direction-lock/v2';

const REGISTERS = new Set(['brand', 'product']);
const GENERIC_QUALITIES = new Set([
  'beautiful', 'clean', 'elegant', 'minimal', 'modern', 'professional', 'simple',
  '乾淨', '漂亮', '現代', '簡約', '專業', '優雅',
]);
const TOP_KEYS = ['$schema', 'schema', 'status', 'name', 'context', 'identity', 'bindings'];
const CONTEXT_KEYS = ['register', 'product', 'audience', 'task', 'action', 'constraints'];
const IDENTITY_KEYS = [
  'thesis', 'qualities', 'signature', 'composition', 'responsive',
  'typography', 'color', 'form', 'motion', 'media', 'avoid',
];

/** `dk design init` deliberately writes a short unfinished contract. */
export function createDirectionTemplate() {
  return {
    $schema: 'https://unpkg.com/axion-designer/direction.schema.json',
    schema: DIRECTION_SCHEMA,
    status: 'draft',
    name: 'TODO: memorable direction name',
    context: {
      register: 'product',
      product: 'TODO: what is being built and why it should exist',
      audience: ['TODO: primary audience'],
      task: 'TODO: the single most important user job',
      action: 'TODO: the action that deserves the strongest emphasis',
      constraints: [],
    },
    identity: {
      thesis: 'TODO: one precise sentence that can direct every surface',
      qualities: ['TODO: quality one', 'TODO: quality two', 'TODO: quality three'],
      signature: 'TODO: one earned, repeatable move that makes this product recognizable',
      composition: 'TODO: macro layout, hierarchy, density, and grouping rule',
      responsive: 'TODO: how priority and composition change across widths',
      typography: 'TODO: type roles, hierarchy, voice, and readable measure',
      color: 'TODO: semantic color relationship, surfaces, and accent budget',
      form: 'TODO: geometry, radius, borders, depth, and icon language',
      motion: 'Use motion only to explain state change and honor reduced motion.',
      media: 'Use imagery only when it carries product meaning; never as filler.',
      avoid: ['TODO: generic category cliché', 'TODO: product-inappropriate visual habit'],
    },
    bindings: {
      accent: 'color.brand.accent',
      surface: 'color.surface.page',
      text: 'color.text.primary',
      displayFont: 'font.family.display',
      bodyFont: 'font.family.base',
      spacing: 'space.4',
      radius: 'radius.md',
    },
  };
}

/** Validate the compact contract and its optional resolved token bindings. */
export function validateDirection(doc, opts = {}) {
  const issues = [];
  const add = (code, severity, path, message, fix) => issues.push({ code, severity, path, message, fix });
  const err = (path, zh, en, fixZh, fixEn) => add('contract', 'error', path, pick(zh, en), pick(fixZh, fixEn));
  const warn = (code, path, zh, en, fixZh, fixEn) => add(code, 'warn', path, pick(zh, en), pick(fixZh, fixEn));

  if (!isObj(doc)) {
    err('$', '方向契約必須是 JSON object。', 'The direction contract must be a JSON object.',
      '重新執行 `dk design init`，再填入內容。', 'Run `dk design init` again, then fill in the contract.');
    return issues;
  }

  rejectUnknown(doc, '$', TOP_KEYS, err);
  if (doc.schema !== DIRECTION_SCHEMA) {
    err('schema', `schema 必須是 ${DIRECTION_SCHEMA}。`, `schema must be ${DIRECTION_SCHEMA}.`,
      `公開發布前請改用精簡的 ${DIRECTION_SCHEMA} 契約。`, `Use the compact ${DIRECTION_SCHEMA} contract before release.`);
  }
  if (!['draft', 'approved'].includes(doc.status)) {
    err('status', 'status 必須是 draft 或 approved。', 'status must be draft or approved.',
      '探索時用 draft；方向選定並完成內容後改成 approved。', 'Use draft while exploring; set approved after selection.');
  } else if (doc.status === 'draft') {
    warn('draft', 'status', '方向仍是 draft，尚未成為可鎖定的產品身份。',
      'The direction is still a draft and is not yet a lockable product identity.',
      '選定方向、完成契約後設為 approved，再建立 Taste Lock。',
      'Select a direction, complete the contract, set approved, then create the Taste Lock.');
  }

  requireText(doc.name, 'name', 4, 80, err);

  const context = requireObj(doc.context, 'context', err);
  if (context) {
    rejectUnknown(context, 'context', CONTEXT_KEYS, err);
    if (!REGISTERS.has(context.register)) {
      err('context.register', 'register 必須是 brand 或 product。', 'register must be brand or product.',
        '品牌敘事面用 brand；高頻任務介面用 product。', 'Use brand for expressive storytelling and product for task surfaces.');
    }
    requireText(context.product, 'context.product', 12, 240, err);
    requireTextArray(context.audience, 'context.audience', 1, 3, 3, 120, err);
    requireText(context.task, 'context.task', 10, 240, err);
    requireText(context.action, 'context.action', 4, 160, err);
    requireTextArray(context.constraints, 'context.constraints', 0, 4, 6, 240, err);
  }

  const identity = requireObj(doc.identity, 'identity', err);
  if (identity) {
    rejectUnknown(identity, 'identity', IDENTITY_KEYS, err);
    requireText(identity.thesis, 'identity.thesis', 20, 240, err);
    requireTextArray(identity.qualities, 'identity.qualities', 3, 5, 2, 48, err);
    requireText(identity.signature, 'identity.signature', 16, 240, err);
    requireText(identity.composition, 'identity.composition', 16, 240, err);
    requireText(identity.responsive, 'identity.responsive', 16, 240, err);
    requireText(identity.typography, 'identity.typography', 16, 240, err);
    requireText(identity.color, 'identity.color', 16, 240, err);
    requireText(identity.form, 'identity.form', 12, 240, err);
    requireText(identity.motion, 'identity.motion', 12, 240, err);
    requireText(identity.media, 'identity.media', 12, 240, err);
    requireTextArray(identity.avoid, 'identity.avoid', 2, 5, 4, 160, err);

    const overlap = intersect(identity.qualities, identity.avoid);
    if (overlap.length) {
      err('identity.qualities', `qualities 與 avoid 自相矛盾：${overlap.join('、')}。`,
        `qualities contradict avoid: ${overlap.join(', ')}.`,
        '保留真正想要的一側，另一側改成具體反例。', 'Keep the intended side and make the other a concrete counterexample.');
    }
    if (Array.isArray(identity.qualities)
        && identity.qualities.length
        && identity.qualities.every((value) => GENERIC_QUALITIES.has(norm(value)))) {
      warn('generic', 'identity.qualities', 'qualities 全是「乾淨、現代、漂亮」一類平均詞，無法導出獨特畫面。',
        'Every quality is a generic average such as clean, modern, or beautiful, so it cannot direct a distinctive surface.',
        '改成與任務相關、彼此有張力的特質，並由 signature 承擔辨識度。',
        'Use task-specific qualities with tension, then let the signature carry distinction.');
    }
  }

  validateBindings(doc.bindings, opts.resolveToken, add, err);

  walkStrings(doc, (value, path) => {
    if (isTodo(value) && !issues.some((issue) => issue.path === path)) {
      err(path, `${path} 仍含 TODO。`, `${path} still contains TODO.`,
        '用真實內容或明確設計決策取代 placeholder。', 'Replace the placeholder with real content or a concrete decision.');
    }
  });

  return dedupeIssues(issues);
}

function validateBindings(bindings, resolveToken, add, err) {
  if (!isObj(bindings)) {
    err('bindings', 'bindings 必須是 role → token dot-path 的 object。',
      'bindings must be an object mapping roles to token dot paths.',
      '至少綁定四個真正影響畫面的 semantic roles。', 'Bind at least four semantic roles that materially affect the UI.');
    return;
  }
  const entries = Object.entries(bindings);
  if (entries.length < 4 || entries.length > 12) {
    err('bindings', 'bindings 必須精選 4–12 個 semantic roles。',
      'bindings must contain a focused set of 4–12 semantic roles.',
      '保留會改變產品身份的色彩、字體、間距或形狀角色。',
      'Keep only color, type, spacing, or form roles that affect product identity.');
  }
  for (const [role, token] of entries) {
    if (role.trim().length < 2) {
      err(`bindings.${role || '(empty)'}`, 'binding role 必須有可讀的語意名稱。',
        'Each binding role needs a readable semantic name.',
        '使用 accent、surface、displayFont、spacing 這類角色。',
        'Use a role such as accent, surface, displayFont, or spacing.');
    }
    requireText(token, `bindings.${role}`, 3, 120, err);
    if (typeof token === 'string' && !isTodo(token) && typeof resolveToken === 'function'
        && resolveToken(token.trim(), 'light') == null) {
      add('token-binding', 'error', `bindings.${role}`,
        pick(`方向角色 ${role} 指向不存在或無法解析的 token：${token}。`,
          `Direction role ${role} points to a missing or unresolved token: ${token}.`),
        pick('改成 tokens.json 內存在且可解析的 dot-path，或先建立該語意 token。',
          'Use a resolvable dot path from tokens.json, or create the semantic token first.'));
    }
  }
}

/**
 * Taste Lock fingerprints only durable visual identity. Content, audience,
 * constraints, and authoring metadata may evolve without false identity drift.
 */
export function hashDirection(doc) {
  const payload = {
    schema: doc?.schema ?? null,
    name: cleanText(doc?.name),
    register: doc?.context?.register ?? null,
    identity: canonicalIdentity(doc?.identity),
  };
  return hash(payload);
}

/** Fingerprint only the selected semantic roles and their resolved values. */
export function hashDirectionBindings(doc, resolveToken) {
  const rows = Object.entries(isObj(doc?.bindings) ? doc.bindings : {})
    .map(([role, path]) => [cleanText(role), cleanText(path)])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, path]) => ({
      role,
      path,
      light: typeof resolveToken === 'function' ? resolveToken(path, 'light') ?? null : null,
      dark: typeof resolveToken === 'function' ? resolveToken(path, 'dark') ?? null : null,
    }));
  return hash(rows);
}

export function createDirectionLock(doc, previous = null, opts = {}) {
  const now = new Date().toISOString();
  return {
    schema: DIRECTION_LOCK_SCHEMA,
    directionHash: hashDirection(doc),
    bindingHash: opts.bindingHash ?? hashDirectionBindings(doc, opts.resolveToken),
    ...(opts.approvalHeadHash ? { approvalHeadHash: opts.approvalHeadHash } : {}),
    directionName: doc?.name ?? null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    note: 'Locks approved visual identity and resolved semantic bindings; update only after intentional design review.',
  };
}

export function validateDirectionLock(lock) {
  return isObj(lock)
    && lock.schema === DIRECTION_LOCK_SCHEMA
    && typeof lock.directionHash === 'string'
    && /^[a-f0-9]{16}$/i.test(lock.directionHash)
    && typeof lock.bindingHash === 'string'
    && /^[a-f0-9]{16}$/i.test(lock.bindingHash)
    && (lock.approvalHeadHash == null || /^[a-f0-9]{64}$/i.test(lock.approvalHeadHash));
}

/** A compact handoff for another model/agent. Same-session agents read JSON. */
export function renderDirectionPrompt(doc) {
  const lines = [
    `# dk direction: ${doc.name}`,
    '',
    pick(
      '核准的 JSON contract 是規範來源；這份摘要只供交接。衝突順序：無障礙與使用者任務 > 平台慣例 > 核准方向 > 個人偏好。',
      'The approved JSON contract is normative; this digest is only a handoff. Conflict order: accessibility and user task > platform convention > approved direction > personal preference.'),
    '',
    `- Register: ${doc.context.register}`,
    `- Task: ${doc.context.task}`,
    `- Primary action: ${doc.context.action}`,
    `- Thesis: ${doc.identity.thesis}`,
    `- Qualities: ${doc.identity.qualities.join(', ')}`,
    `- Signature: ${doc.identity.signature}`,
    `- Avoid: ${doc.identity.avoid.join('; ')}`,
  ];
  if (doc.context.constraints.length) lines.push(`- Constraints: ${doc.context.constraints.join('; ')}`);
  lines.push('', pick('Semantic bindings：', 'Semantic bindings:'));
  for (const [role, token] of Object.entries(doc.bindings).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- ${role}: ${token}`);
  }
  lines.push('', pick(
    '用真內容先建層級；沿用現有 stack 與元件；所有身份值走 bindings；渲染相關 mobile/desktop 與狀態；最後執行 dk verify。',
    'Build hierarchy with real content first; keep the existing stack and components; route identity values through bindings; render relevant mobile/desktop states; finish with dk verify.'));
  return `${lines.join('\n')}\n`;
}

function rejectUnknown(value, path, allowed, err) {
  if (!isObj(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const at = path === '$' ? key : `${path}.${key}`;
      err(at, `${at} 不是 ${DIRECTION_SCHEMA} 支援的欄位。`, `${at} is not supported by ${DIRECTION_SCHEMA}.`,
        '刪除重複或工作階段專屬資料；核心只保留 context、identity 與 bindings。',
        'Remove duplicated or session-specific data; the core keeps only context, identity, and bindings.');
    }
  }
}

function requireObj(value, path, err) {
  if (isObj(value)) return value;
  err(path, `${path} 必須是 object。`, `${path} must be an object.`,
    '依 direction schema 補齊這個區塊。', 'Add this section according to the direction schema.');
  return null;
}

function requireText(value, path, min, max, err) {
  if (typeof value === 'string' && value.trim().length >= min && value.trim().length <= max && !isTodo(value)) return true;
  err(path, `${path} 必須是 ${min}–${max} 字元的具體文字，且不能保留 TODO。`,
    `${path} must be concrete text of ${min}–${max} characters with no TODO.`,
    '用真實內容或一個精確、短小的設計決策填寫。', 'Use real content or one precise, concise design decision.');
  return false;
}

function requireTextArray(value, path, minItems, maxItems, minChars, maxChars, err) {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    err(path, `${path} 必須有 ${minItems}–${maxItems} 項。`, `${path} must contain ${minItems}–${maxItems} items.`,
      '只保留具體、互不重複、會影響結果的項目。', 'Keep only concrete, distinct items that affect the result.');
    return false;
  }
  let ok = true;
  value.forEach((item, index) => {
    if (!requireText(item, `${path}[${index}]`, minChars, maxChars, err)) ok = false;
  });
  if (new Set(value.map(norm)).size !== value.length) {
    err(path, `${path} 不得有重複項目。`, `${path} must not contain duplicates.`,
      '合併或刪除重複項目。', 'Merge or remove duplicate items.');
    ok = false;
  }
  return ok;
}

function canonicalIdentity(identity) {
  if (!isObj(identity)) return null;
  const out = {};
  for (const key of IDENTITY_KEYS) {
    const value = identity[key];
    out[key] = Array.isArray(value)
      ? value.map(cleanText).sort((a, b) => a.localeCompare(b))
      : cleanText(value);
  }
  return out;
}

function hash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}
function cleanText(value) { return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value ?? null; }
function isObj(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function isTodo(value) { return typeof value === 'string' && /^\s*TODO\s*:/i.test(value); }
function norm(value) { return cleanText(String(value ?? '')).toLowerCase(); }
function intersect(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return [];
  const right = new Set(b.map(norm));
  return [...new Set(a.filter((value) => right.has(norm(value))).map((value) => String(value).trim()))];
}
function walkStrings(value, cb, path = '$') {
  if (typeof value === 'string') { cb(value, path); return; }
  if (Array.isArray(value)) { value.forEach((item, index) => walkStrings(item, cb, `${path}[${index}]`)); return; }
  if (isObj(value)) for (const [key, item] of Object.entries(value)) walkStrings(item, cb, path === '$' ? key : `${path}.${key}`);
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = `${issue.code}\0${issue.path}\0${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
