import { discoverProofSurfaces } from '../system/indexer.mjs';
import { sha256 } from './image.mjs';
import { readRegularFileInside, scopeAllowsRoute } from './safety.mjs';

const APP_PROOF_PATH = '.dk/proof/app-proof.json';
const APP_PROOF_LEDGER_PATH = '.dk/report.json';
const MAX_PROOF_BYTES = 8 * 1024 * 1024;
// App Proof schema v2 does not expose a DPR field. Its runner creates a
// Playwright context without deviceScaleFactor, whose defined default is 1.
// Do not infer or accept any other DPR until the proof contract records it.
const APP_PROOF_V2_DEVICE_SCALE_FACTOR = 1;
const HEX_64 = /^[a-f0-9]{64}$/i;
const HEX_16 = /^[a-f0-9]{16}$/i;

export function buildAppProofCaptureAttestation(projectRoot, input) {
  const candidatePath = input?.candidatePath;
  const candidate = input?.candidate;
  const reference = input?.reference;
  const viewport = input?.viewport;
  if (typeof candidatePath !== 'string' || !candidate
      || typeof candidate.sha256 !== 'string' || !Number.isInteger(candidate.bytes)) {
    return unattested('Candidate capture metadata is incomplete.');
  }

  let firstProof;
  let firstLedger;
  let proof;
  let ledger;
  try {
    firstProof = readRegularFileInside(projectRoot, APP_PROOF_PATH, {
      label: 'App Proof artifact', maxBytes: MAX_PROOF_BYTES,
    });
    firstLedger = readRegularFileInside(projectRoot, APP_PROOF_LEDGER_PATH, {
      label: 'App Proof evidence ledger', maxBytes: MAX_PROOF_BYTES,
    });
    proof = JSON.parse(firstProof.bytes.toString('utf8'));
    ledger = JSON.parse(firstLedger.bytes.toString('utf8'));
  } catch (error) {
    return unattested(`Candidate is not backed by readable App Proof evidence: ${safeDetail(error, projectRoot)}`);
  }

  // This is the existing product trust boundary, not a local JSON-shape
  // shortcut. It validates complete coverage, successful cases, durable
  // screenshot bytes, the passing a11y gate, ledger timestamps, and source
  // freshness before Reference is allowed to select one case.
  let trusted;
  try { trusted = discoverProofSurfaces(projectRoot); }
  catch (error) {
    return unattested(`App Proof trust verification failed: ${safeDetail(error, projectRoot)}`);
  }
  if (trusted?.appProof?.status !== 'complete') {
    const detail = trusted?.appProof?.reason || `status is ${trusted?.appProof?.status ?? 'unknown'}`;
    return unattested(`App Proof is not current, complete, and ledger-attested: ${safeDetail(detail, projectRoot)}`);
  }

  // Close the read/verify time-of-check window. The trusted boundary and the
  // fields copied into the comparison must describe the same proof and ledger
  // bytes; a concurrent change fails closed.
  let proofLoaded;
  let ledgerLoaded;
  try {
    proofLoaded = readRegularFileInside(projectRoot, APP_PROOF_PATH, {
      label: 'App Proof artifact', maxBytes: MAX_PROOF_BYTES,
    });
    ledgerLoaded = readRegularFileInside(projectRoot, APP_PROOF_LEDGER_PATH, {
      label: 'App Proof evidence ledger', maxBytes: MAX_PROOF_BYTES,
    });
  } catch (error) {
    return unattested(`App Proof evidence changed during verification: ${safeDetail(error, projectRoot)}`);
  }
  const proofSha256 = sha256(firstProof.bytes);
  const ledgerSha256 = sha256(firstLedger.bytes);
  if (proofSha256 !== sha256(proofLoaded.bytes) || ledgerSha256 !== sha256(ledgerLoaded.bytes)) {
    return unattested('App Proof evidence changed during verification.');
  }
  if (trusted.appProof.configHash !== proof.configHash
      || trusted.appProof.finishedAt !== proof.finishedAt) {
    return unattested('The trusted App Proof summary does not match the selected artifact bytes.');
  }

  const successful = Array.isArray(proof.results)
    ? proof.results.filter((result) => result?.error == null && result?.screenshot)
    : [];
  const matched = successful.filter((result) => result.screenshot.path === candidatePath);
  if (matched.length !== 1) {
    const copiedBytes = successful.some((result) => result.screenshot.sha256 === candidate.sha256
      && result.screenshot.bytes === candidate.bytes);
    return unattested(copiedBytes
      ? 'Candidate bytes match App Proof, but the candidate path is not the successful case screenshot path; copied images are not capture attestation.'
      : 'Candidate path does not identify exactly one successful App Proof screenshot case.');
  }

  const result = matched[0];
  const shot = result.screenshot;
  if (candidate.format !== 'png' || candidate.mediaType !== 'image/png'
      || shot.sha256 !== candidate.sha256 || shot.bytes !== candidate.bytes) {
    return unattested('Candidate bytes and media metadata do not match the successful App Proof screenshot.');
  }
  if (!record(result.matrix)
      || !['route', 'state', 'viewport', 'theme'].every((key) => nonempty(result.matrix[key]))) {
    return unattested('The successful App Proof case does not bind every route/state/viewport/theme dimension.');
  }

  const coverageViewport = proof.coverage?.viewports?.find((entry) => entry?.name === result.matrix.viewport);
  if (!coverageViewport || coverageViewport.width !== shot.width || coverageViewport.height !== shot.height) {
    return unattested('The App Proof case viewport contradicts its coverage contract or screenshot metadata.');
  }
  if (shot.fullPage !== true || shot.path !== `.dk/proof/screenshots/${result.id}.png`) {
    return unattested('The App Proof screenshot path or full-page capture contract is invalid.');
  }
  if (!sameViewport(reference?.viewport, viewport)
      || viewport.name !== coverageViewport.name
      || viewport.width !== coverageViewport.width || viewport.height !== coverageViewport.height) {
    return unattested('Reference, reconstruction plan, and App Proof case viewports must have identical width and height.');
  }
  if (reference.viewport.deviceScaleFactor !== APP_PROOF_V2_DEVICE_SCALE_FACTOR
      || viewport.deviceScaleFactor !== APP_PROOF_V2_DEVICE_SCALE_FACTOR) {
    return unattested('App Proof v2 can attest only DPR 1; the reference or reconstruction plan declares another DPR.');
  }

  let parsedUrl;
  try { parsedUrl = new URL(result.url); }
  catch { return unattested('The successful App Proof case URL is invalid.'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    return unattested('The successful App Proof case URL is not a safe HTTP(S) route.');
  }
  const routePath = `${parsedUrl.pathname}${parsedUrl.search}` || '/';
  const declaredRoutes = reference?.authorizedScope?.routes ?? [];
  if (declaredRoutes.length && !scopeAllowsRoute(reference.authorizedScope, routePath)) {
    return unattested(`The App Proof route ${routePath} is outside the reference authorized scope.`);
  }

  if (!timestamp(proof.startedAt) || !timestamp(proof.finishedAt)
      || Date.parse(proof.finishedAt) < Date.parse(proof.startedAt)) {
    return unattested('App Proof does not contain a valid capture time window.');
  }
  if (!timestamp(ledger.generatedAt) || Date.parse(ledger.generatedAt) < Date.parse(proof.finishedAt)) {
    return unattested('The App Proof evidence ledger does not postdate the capture.');
  }
  if (ledger.version !== 2 || typeof ledger.partial !== 'boolean'
      || !nonempty(ledger.runtimeVersion) || !HEX_16.test(ledger.configHash ?? '')
      || !(ledger.sourceFingerprint === null || HEX_16.test(ledger.sourceFingerprint ?? ''))
      || (!ledger.partial && ledger.sourceFingerprint === null)) {
    return unattested('The App Proof evidence ledger lacks a verifiable runtime/config/source freshness envelope.');
  }
  if (!HEX_64.test(proof.configHash ?? '')) {
    return unattested('The App Proof config hash is invalid.');
  }

  return {
    status: 'attested',
    reason: null,
    proof: {
      path: APP_PROOF_PATH,
      sha256: proofSha256,
      configHash: proof.configHash,
      startedAt: proof.startedAt,
      finishedAt: proof.finishedAt,
    },
    ledger: {
      path: APP_PROOF_LEDGER_PATH,
      sha256: ledgerSha256,
      generatedAt: ledger.generatedAt,
      runtimeVersion: ledger.runtimeVersion,
      configHash: ledger.configHash,
      sourceFingerprint: ledger.sourceFingerprint,
      partial: ledger.partial,
    },
    case: {
      id: result.id,
      url: parsedUrl.href,
      route: { name: result.matrix.route, path: routePath },
      state: result.matrix.state,
      theme: result.matrix.theme,
      viewport: {
        name: result.matrix.viewport,
        width: coverageViewport.width,
        height: coverageViewport.height,
        deviceScaleFactor: APP_PROOF_V2_DEVICE_SCALE_FACTOR,
      },
      // App Proof v2 records a run window rather than a per-screenshot clock.
      // finishedAt is the conservative durable completion bound for this shot.
      capturedAt: proof.finishedAt,
      screenshot: {
        path: shot.path,
        sha256: shot.sha256,
        bytes: shot.bytes,
        width: shot.width,
        height: shot.height,
        fullPage: true,
      },
    },
  };
}

function unattested(reason) {
  return {
    status: 'unattested', reason: oneLine(reason), proof: null, ledger: null, case: null,
  };
}

function sameViewport(left, right) {
  return left && right
    && left.width === right.width
    && left.height === right.height
    && left.deviceScaleFactor === right.deviceScaleFactor;
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function oneLine(value) {
  return String(value?.message ?? value ?? 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 800);
}
function safeDetail(value, projectRoot) {
  return oneLine(value).split(String(projectRoot)).join('<project-root>');
}
