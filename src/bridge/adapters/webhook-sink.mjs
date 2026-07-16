import {
  assertInputEnvelope,
  canonicalDigest,
  createAdapterEnvelope,
  defineManifest,
  isLoopbackHostname,
  isPlainObject,
  parseJsonBytes,
  redactSecrets,
  runtimeAdapter,
  safeFetch,
  sha256,
  validateHttpUrl,
} from './common.mjs';

export const capabilities = Object.freeze(['webhook.delivery.publish']);

export const manifest = defineManifest({
  id: 'webhook-sink',
  version: '1.0.0',
  kind: 'sink',
  capabilities,
  permissions: {
    discover: [],
    collect: [],
    publish: ['network:webhook-allowlist', 'env:AXION_WEBHOOK_ENDPOINT', 'env:AXION_WEBHOOK_TOKEN'],
  },
});

function allowedOrigins(ctx) {
  if (!Array.isArray(ctx.allowlist) || ctx.allowlist.length === 0) {
    throw new Error('webhook-sink requires a non-empty HTTPS origin allowlist.');
  }
  return ctx.allowlist.map((entry) => {
    if (typeof entry !== 'string' || entry.includes('*')) throw new Error('Webhook allowlist entries must be exact origins without wildcards.');
    const url = validateHttpUrl(entry, {
      label: 'Webhook allowlist entry',
      allowHttpLoopback: ctx.testMode === true,
      httpsOnly: ctx.testMode !== true,
    });
    if (url.pathname !== '/' || url.search || url.hash) throw new Error('Webhook allowlist entries must be origins, not paths or query URLs.');
    return url.origin;
  });
}

function responseSummary(bytes, contentType) {
  if (!/\bjson\b/i.test(contentType ?? '') || bytes.length === 0) return {};
  try {
    const parsed = parseJsonBytes(bytes, 'Webhook response');
    if (!isPlainObject(parsed)) return {};
    const responseUrl = typeof parsed.url === 'string' ? confidentialUrlReference(parsed.url) : null;
    return {
      id: ['string', 'number'].includes(typeof parsed.id) ? parsed.id : null,
      status: typeof parsed.status === 'string' ? parsed.status : null,
      ...(responseUrl ? { url: responseUrl } : {}),
    };
  } catch {
    return {};
  }
}

function confidentialUrlReference(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return { origin: url.origin, sha256: sha256(url.href) };
  } catch {
    return null;
  }
}

export async function publish(ctx = {}, envelope) {
  assertInputEnvelope(envelope);
  const env = isPlainObject(ctx.env) ? ctx.env : process.env;
  const endpointEnv = ctx.endpointEnv ?? 'AXION_WEBHOOK_ENDPOINT';
  if (typeof endpointEnv !== 'string' || endpointEnv.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(endpointEnv)) {
    throw new Error('webhook endpointEnv must name a bounded portable environment variable.');
  }
  const inlineEndpoint = typeof ctx.endpoint === 'string' && ctx.endpoint.trim() ? ctx.endpoint : null;
  if (inlineEndpoint && ctx.testMode !== true && ctx.allowInlineEndpoint !== true) {
    throw new Error('Webhook endpoint URLs must come from endpointEnv unless allowInlineEndpoint is explicitly enabled for a public URL.');
  }
  const endpointValue = inlineEndpoint ?? env[endpointEnv];
  if (typeof endpointValue !== 'string' || !endpointValue.trim()) {
    throw new Error(`${endpointEnv} is required for webhook delivery.`);
  }
  const origins = allowedOrigins(ctx);
  const endpoint = validateHttpUrl(endpointValue, {
    label: 'Webhook endpoint',
    allowHttpLoopback: ctx.testMode === true,
    httpsOnly: ctx.testMode !== true,
    allowedOrigins: origins,
  });
  if (endpoint.protocol !== 'https:' && !(ctx.testMode === true && isLoopbackHostname(endpoint.hostname))) {
    throw new Error('Webhook delivery requires HTTPS outside explicit loopback tests.');
  }
  const authToken = env.AXION_WEBHOOK_TOKEN;
  if (typeof authToken !== 'string' || !authToken.trim()) {
    throw new Error('AXION_WEBHOOK_TOKEN is required for webhook delivery.');
  }
  const endpointSha256 = sha256(endpoint.href);
  const idempotencyKey = ctx.idempotencyKey ?? `axion-${await canonicalDigest({
    endpoint: endpoint.href,
    envelopeDigest: envelope.digest,
  })}`;
  if (!/^[A-Za-z0-9._:-]{8,255}$/.test(idempotencyKey)) {
    throw new Error('Webhook idempotency key must contain 8-255 safe characters.');
  }
  const redactedEnvelope = redactSecrets(envelope, {
    secretValues: [authToken, ...(Array.isArray(ctx.secretValues) ? ctx.secretValues : [])],
    additionalKeys: ctx.redactKeys,
  });
  const delivery = {
    schema: 'axion-bridge-webhook-delivery/v1',
    idempotencyKey,
    sourceEnvelopeDigest: envelope.digest,
    redacted: true,
    envelope: redactedEnvelope,
  };
  const requestBytes = Buffer.from(JSON.stringify(delivery));
  const result = await safeFetch(endpoint.href, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'User-Agent': 'axion-designer-bridge',
      Authorization: `Bearer ${authToken}`,
    },
    body: requestBytes,
    timeoutMs: ctx.timeoutMs,
    maxBytes: ctx.maxResponseBytes ?? 1024 * 1024,
    fetchImpl: ctx.fetch,
    signal: ctx.signal,
    validateUrlOptions: {
      label: 'Webhook endpoint',
      allowHttpLoopback: ctx.testMode === true,
      httpsOnly: ctx.testMode !== true,
      allowedOrigins: origins,
    },
  });
  if (result.response.status < 200 || result.response.status >= 300) {
    throw new Error(`Webhook endpoint returned HTTP ${result.response.status}.`);
  }
  const response = responseSummary(result.bytes, result.response.headers.get('content-type'));
  return createAdapterEnvelope({
    manifest,
    capability: 'webhook.delivery.publish',
    operation: 'publish',
    trust: 'verified',
    status: 'passed',
    repository: {
      remote: envelope.binding.repository ?? undefined,
      commit: envelope.binding.commit ?? undefined,
    },
    coverage: {
      complete: true,
      deliveriesAttempted: 1,
      deliveriesAccepted: 1,
    },
    artifacts: [{
      kind: 'webhook-response',
      uri: `${endpoint.origin}/`,
      mediaType: result.response.headers.get('content-type') ?? 'application/octet-stream',
      bytes: result.bytes.length,
      digest: `sha256:${sha256(result.bytes)}`,
    }],
    metadata: {
      endpointOrigin: endpoint.origin,
      endpointSha256,
      httpStatus: result.response.status,
      idempotencyKey,
      requestSha256: sha256(requestBytes),
      sourceEnvelopeId: envelope.id,
      sourceEnvelopeDigest: envelope.digest,
      redacted: true,
      authTokenPersisted: false,
      response,
    },
    now: ctx.now,
    maxAgeMs: ctx.maxAgeMs ?? 10 * 60_000,
    idSeed: { endpointSha256, idempotencyKey, sourceEnvelopeDigest: envelope.digest },
  });
}

export default runtimeAdapter({ manifest, publish });
