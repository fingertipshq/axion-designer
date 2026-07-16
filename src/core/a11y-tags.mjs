/* ============================================================
   Axe tag contract.

   These are the stable, user-facing standards/profile tags supported by
   Axion's a11y gates. Individual Axe rule/category tags are intentionally not
   part of this configuration surface: accepting an unknown tag makes Axe run
   zero rules and can turn a broken page into a false clean result.
   ============================================================ */

export const SUPPORTED_A11Y_TAGS = Object.freeze([
  'wcag2a',
  'wcag2aa',
  'wcag2aaa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'best-practice',
  'section508',
  'ACT',
  'EN-301-549',
  'RGAAv4',
  'TTv5',
  'experimental',
]);

const SUPPORTED_A11Y_TAG_SET = new Set(SUPPORTED_A11Y_TAGS);

/**
 * Validate one explicit Axe tag list. An empty list is valid and deliberately
 * means "do not call withTags", which preserves Axe's default all-rules run.
 *
 * @param {unknown} value
 * @param {string} [path]
 * @returns {{ path: string, message: string }[]}
 */
export function validateA11yTags(value, path = 'gates.a11y.tags') {
  if (!Array.isArray(value)) return [{ path, message: `${path} must be an array` }];
  const issues = [];
  value.forEach((tag, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof tag !== 'string' || !tag.trim()) {
      issues.push({ path: itemPath, message: `${itemPath} must be a non-empty string` });
      return;
    }
    if (!SUPPORTED_A11Y_TAG_SET.has(tag)) {
      issues.push({
        path: itemPath,
        message: `${itemPath} contains unsupported Axe tag ${JSON.stringify(tag)}; supported tags: ${SUPPORTED_A11Y_TAGS.join(', ')}`,
      });
    }
  });
  return issues;
}

/**
 * Canonicalize a validated tag union to supported-profile order and remove
 * duplicates. Axe treats the list as a set, so this makes evidence hashes
 * stable without changing scan semantics. `[]` remains `[]` (default-all).
 *
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]}
 */
export function normalizeA11yTags(value, path = 'gates.a11y.tags') {
  const issues = validateA11yTags(value, path);
  if (issues.length) {
    const error = new TypeError(issues.map((issue) => issue.message).join('; '));
    error.code = 'DK_A11Y_TAGS';
    error.issues = issues;
    throw error;
  }
  const selected = new Set(value);
  return SUPPORTED_A11Y_TAGS.filter((tag) => selected.has(tag));
}
