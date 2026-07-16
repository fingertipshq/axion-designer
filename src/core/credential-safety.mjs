const CREDENTIAL_KEY = /(?:^|_)(?:authorization|auth|bearer|cookies?|credentials?|client_credentials?|client_secrets?|passwords?|passwds?|secrets?|tokens?|access_keys?|access_tokens?|api_keys?|private_keys?)(?:$|_)/;
const SENSITIVE_URL_KEY = /^(?:access_?keys?|access_?tokens?|api_?keys?|auth|authorization|bearer|client_?credentials?|client_?secrets?|cookies?|credentials?|keys?|passwords?|passwds?|private_?keys?|secrets?|sigs?|signatures?|tokens?|x-amz-credential|x-amz-signature)$/i;
const HIERARCHICAL_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const CREDENTIAL_ASSIGNMENT = /(?:^|[\s{[,;])["']?(?:authorization|auth|bearer|cookies?|credentials?|client[-_.\s]?credentials?|client[-_.\s]?secrets?|passwords?|passw(?:or)?ds?|secrets?|tokens?|access[-_.\s]?keys?|access[-_.\s]?tokens?|api[-_.\s]?keys?|private[-_.\s]?keys?)["']?\s*(?:=|:)\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/i;
const AUTHORIZATION_VALUE = /\b(?:basic|bearer)\s+[a-z0-9+/_=.-]{4,}/i;
const HIGH_CONFIDENCE_TOKEN = /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/i;

export function normalizeCredentialKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.\s]+/g, '_')
    .toLowerCase();
}

export function isCredentialKey(key) {
  const normalized = normalizeCredentialKey(key);
  // "tokens" is core product vocabulary (design tokens), not necessarily a
  // credential bag. Credential compounds such as accessTokens remain blocked.
  if (/^(?:tokens|design_tokens|dtcg_tokens)$/.test(normalized)) return false;
  return CREDENTIAL_KEY.test(normalized);
}

export function isCredentialEnvReference(key, value) {
  return /env$/i.test(String(key))
    && typeof value === 'string'
    && value.length <= 128
    && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function isSensitiveUrlKey(key) {
  return SENSITIVE_URL_KEY.test(String(key));
}

export function urlCarriesCredentials(value) {
  if (typeof value !== 'string' || !HIERARCHICAL_URL.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    if ([...url.searchParams.keys()].some(isSensitiveUrlKey)) return true;
    const fragment = url.hash.slice(1);
    if (!fragment) return false;
    const fragmentParams = new URLSearchParams(fragment);
    return [...fragmentParams.keys()].some(isSensitiveUrlKey)
      || /(?:^|[?&#;])(?:access_?keys?|access_?tokens?|api_?keys?|auth|authorization|bearer|client_?credentials?|client_?secrets?|cookies?|credentials?|keys?|passwords?|passwds?|private_?keys?|secrets?|sigs?|signatures?|tokens?)=/i.test(fragment);
  } catch {
    return false;
  }
}

export function redactUrlCredentials(value) {
  if (typeof value !== 'string' || !HIERARCHICAL_URL.test(value)) return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveUrlKey(key)) url.searchParams.set(key, '[REDACTED]');
    }
    // Fragments are never sent in HTTP requests and may carry provider tokens.
    // Evidence has no reason to retain them, even when the key is unfamiliar.
    url.hash = '';
    return url.href;
  } catch {
    return value;
  }
}

/** Detect high-confidence credential material embedded in diagnostic text. */
export function textCarriesCredentials(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (CREDENTIAL_ASSIGNMENT.test(value) || AUTHORIZATION_VALUE.test(value) || HIGH_CONFIDENCE_TOKEN.test(value)) return true;
  for (const match of value.matchAll(URL_IN_TEXT)) {
    if (urlCarriesCredentials(match[0])) return true;
  }
  return false;
}

/**
 * Error strings are attacker-controlled adapter output. When a credential
 * pattern is present, replace the entire diagnostic instead of attempting a
 * partial edit that could retain another copy of the same secret.
 */
export function redactCredentialText(value, replacement = '[REDACTED]') {
  return textCarriesCredentials(value) ? replacement : value;
}
