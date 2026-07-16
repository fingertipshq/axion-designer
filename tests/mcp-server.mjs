import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  AXION_MCP_RESOURCE_LIMIT,
  AXION_MCP_TOOL_LIMIT,
} from '../src/mcp/index.mjs';
import { emptyArtifactLedger } from '../src/bridge/runtime.mjs';
import { createReferenceSystem } from '../src/reference/index.mjs';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CLI = join(ROOT, 'bin', 'dk.mjs');
const MCP_BIN = join(ROOT, 'bin', 'dk-mcp.mjs');
const EXPECTED_RESOURCES = [
  'approval_history',
  'bridge_status',
  'codex_context',
  'design_intelligence',
  'direction',
  'latest_report',
  'proof',
  'reference_status',
  'system_graph',
  'tokens',
];
const EXPECTED_TOOLS = [
  'bridge_status',
  'bridge_sync',
  'design_recommend',
  'explain_findings',
  'proof',
  'reference_compare',
  'reference_status',
  'system_graph',
  'verify',
];
const FORBIDDEN_TOOL_PARTS = ['accept', 'approval', 'baseline', 'lock', 'source', 'write'];

const workspace = mkdtempSync(join(tmpdir(), 'axion-mcp-e2e-'));
const project = join(workspace, 'project');
const openClients = [];

try {
  const scaffold = spawnSync(process.execPath, [CLI, 'new', 'project'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(scaffold.status, 0, scaffold.stderr || scaffold.stdout);

  const primary = await connect(['--root', project]);
  openClients.push(primary.client);

  const listedResources = await primary.client.listResources();
  const resourceNames = listedResources.resources.map((resource) => resource.name).sort();
  assert.deepEqual(resourceNames, EXPECTED_RESOURCES);

  const listedTools = await primary.client.listTools();
  const toolNames = listedTools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, EXPECTED_TOOLS);
  for (const tool of listedTools.tools) {
    assert(!FORBIDDEN_TOOL_PARTS.some((part) => tool.name.includes(part)), `forbidden tool exposed: ${tool.name}`);
    const properties = Object.keys(tool.inputSchema?.properties ?? {});
    assert(!properties.some((key) => ['cwd', 'root', 'path', 'source'].includes(key)), `${tool.name} can override project scope`);
  }

  for (const resource of listedResources.resources) {
    const result = await primary.client.readResource({ uri: resource.uri });
    assert.equal(result.contents.length, 1);
    assert.equal(result.contents[0].mimeType, 'application/json');
    assert(Buffer.byteLength(result.contents[0].text) <= AXION_MCP_RESOURCE_LIMIT, `${resource.name} exceeded resource cap`);
    assert.doesNotThrow(() => JSON.parse(result.contents[0].text));
    if (resource.name === 'codex_context') {
      const payload = JSON.parse(result.contents[0].text);
      assert.equal(payload.resource, 'codex_context');
      assert.equal(payload.data.schema, 'axion-codex-context/v1');
      assert.equal(payload.data.direction.approvals.path, 'design/approval-history.json');
    }
  }

  const verify = parseTool(await primary.client.callTool({
    name: 'verify',
    arguments: { noCache: true },
  }));
  assert.equal(verify.result.isError, undefined, verify.text);
  assert.equal(verify.payload.tool, 'verify');
  assert.equal(verify.payload.status, 'passed');
  assert.equal(verify.payload.exitCode, 0);
  assert(Buffer.byteLength(verify.text) <= AXION_MCP_TOOL_LIMIT);

  const recommendation = parseTool(await primary.client.callTool({
    name: 'design_recommend',
    arguments: {
      brief: 'A dashboard for operations analysts to monitor incidents, compare trends, and resolve workflow errors.',
      stack: 'next',
      density: 'compact',
    },
  }));
  assert.equal(recommendation.payload.data.schema, 'axion-design-recommendation/v1');
  assert.equal(recommendation.payload.data.status, 'ready');
  assert.equal(recommendation.payload.data.directions.length, 3);

  const reference = parseTool(await primary.client.callTool({ name: 'reference_status', arguments: {} }));
  assert.equal(reference.payload.data.schema, 'axion-reference-status/v1');
  assert.equal(reference.payload.data.status, 'missing');

  const referenceBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  writeFileSync(join(project, 'reference.png'), referenceBytes);
  writeFileSync(join(project, 'render.png'), referenceBytes);
  const referenceSystem = createReferenceSystem(project, { clock: () => '2026-07-16T00:00:00.000Z' });
  referenceSystem.registerReferences([{
    id: 'home', path: 'reference.png',
    provenance: { type: 'user-provided', source: 'MCP authorized fixture', author: 'test' },
    licence: { status: 'owned', identifier: 'test-owned' },
    viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
    authorizedScope: {
      projectPaths: ['index.html'], routes: ['/'],
      operations: ['decompose', 'map-components', 'plan-reconstruction', 'reconstruct', 'compare'],
    },
  }]);
  referenceSystem.writeVisualDecomposition({
    referenceId: 'home', authoredBy: { type: 'codex', name: 'MCP test', model: null },
    global: {
      summary: 'One page.', layout: ['single page'], palette: ['neutral'],
      typography: ['system'], spacing: ['compact'],
    },
    regions: [{
      id: 'page', label: 'Page', role: 'page', bounds: { x: 0, y: 0, width: 1, height: 1, unit: 'px' },
      description: 'Full page.', confidence: 1,
      visual: { layout: 'single page', colors: ['neutral'], typography: ['system'], spacing: ['compact'], assets: [] },
      evidence: ['full pixel'],
    }], assumptions: [], unresolved: [],
  });
  referenceSystem.writeComponentMapping({
    referenceId: 'home', authoredBy: { type: 'codex', name: 'MCP test', model: null },
    mappings: [{
      id: 'page', regionIds: ['page'], target: { projectPath: 'index.html', exportName: null, route: '/' },
      strategy: 'adapt', rationale: 'The scaffold page owns this region.', confidence: 1,
    }], unmappedRegions: [],
  });
  referenceSystem.writeReconstructionPlan({
    referenceId: 'home', authoredBy: { type: 'codex', name: 'MCP test', model: null },
    rules: { assetReuse: 'exact-or-cropped' },
    steps: [
      {
        id: 'build', order: 1, title: 'Adapt page', action: 'modify', targets: ['index.html'],
        mappingIds: ['page'], dependsOn: [], acceptance: ['Real DOM is retained.'],
      },
      {
        id: 'verify', order: 2, title: 'Verify page', action: 'verify', targets: [],
        mappingIds: ['page'], dependsOn: ['build'], acceptance: ['Comparison is current.'],
      },
    ],
    verification: {
      viewports: [{ name: 'reference', width: 1, height: 1, deviceScaleFactor: 1 }],
      implementationFiles: ['index.html'], requiredComparisons: 1,
    },
  });
  const beforeComparison = parseTool(await primary.client.callTool({ name: 'reference_status', arguments: {} }));
  assert.equal(beforeComparison.payload.data.status, 'incomplete');
  const missingImplementationFiles = await primary.client.callTool({
    name: 'reference_compare', arguments: { referenceId: 'home', candidate: 'render.png' },
  });
  assert.equal(missingImplementationFiles.isError, true);
  assert.match(missingImplementationFiles.content[0].text, /implementationFiles|required/i);
  const wrongImplementationFiles = parseTool(await primary.client.callTool({
    name: 'reference_compare',
    arguments: { referenceId: 'home', candidate: 'render.png', implementationFiles: ['index.html', 'styles/tokens.css'] },
  }));
  assert.equal(wrongImplementationFiles.result.isError, true);
  assert.match(wrongImplementationFiles.payload.error, /exactly match/);
  const comparedReference = parseTool(await primary.client.callTool({
    name: 'reference_compare',
    arguments: { referenceId: 'home', candidate: 'render.png', implementationFiles: ['index.html'] },
  }));
  assert.equal(comparedReference.result.isError, undefined, comparedReference.text);
  assert.equal(comparedReference.payload.status, 'review');
  assert.equal(comparedReference.payload.data.capture.status, 'unattested');
  assert.equal(comparedReference.payload.data.reconstructionPlan.path, '.dk/reference/reconstruction-plan.home.json');
  const completeReference = parseTool(await primary.client.callTool({ name: 'reference_status', arguments: {} }));
  assert.equal(completeReference.payload.data.status, 'needs-repair');

  const graph = parseTool(await primary.client.callTool({
    name: 'system_graph',
    arguments: { includeGenerated: false },
  }));
  assert.equal(graph.result.isError, undefined, graph.text);
  assert.equal(graph.payload.data.schema, 'dk-system-graph/v1');

  const explanation = parseTool(await primary.client.callTool({
    name: 'explain_findings',
    arguments: { ruleIds: ['slop/hardcoded-color'] },
  }));
  assert.equal(explanation.payload.explanations[0].registered, true);
  assert.equal(explanation.payload.explanations[0].ruleId, 'slop/hardcoded-color');

  const bridge = parseTool(await primary.client.callTool({ name: 'bridge_status', arguments: {} }));
  if (bridge.payload.bridge.available) {
    assert.equal(bridge.payload.bridge.reason, 'not-synced');
    assert.equal(bridge.payload.bridge.policyStatus, 'passed');
  } else {
    assert.equal(bridge.payload.bridge.reason, 'core-not-installed');
  }

  const bridgeSync = parseTool(await primary.client.callTool({ name: 'bridge_sync', arguments: { dryRun: true } }));
  assert.equal(bridgeSync.payload.dryRun, true);
  assert.equal(bridgeSync.payload.changed, false);
  assert.equal(bridgeSync.payload.status, 'planned');
  assert.equal(bridgeSync.payload.plan.schema, 'axion-bridge-doctor/v1');

  if (bridge.payload.bridge.available) {
    // A valid ledger and a failed connection policy are independent states.
    // The CLI exits 1 here, but MCP must not mislabel valid bytes as tampering.
    const configPath = join(project, 'dk.config.mjs');
    const configSource = readFileSync(configPath, 'utf8');
    const gateEnabledConfig = configSource.replace(
      '  gates: {\n',
      '  gates: {\n    bridge: { enabled: true },\n',
    );
    assert.notEqual(gateEnabledConfig, configSource, 'scaffold config exposes a gates block for the fixture');
    writeFileSync(configPath, gateEnabledConfig);
    writeFileSync(join(project, 'design', 'bridge.json'), `${JSON.stringify({
      schema: 'axion-bridge-config/v1',
      connections: [{
        id: 'required-source', adapter: 'artifact', role: 'source', required: true,
        trust: 'linked', permissions: ['fs:read', 'network:artifact-origin'],
      }],
    }, null, 2)}\n`);
    const bridgeDir = join(project, '.dk', 'bridge');
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(join(bridgeDir, 'ledger.json'), `${JSON.stringify(emptyArtifactLedger({ root: project, commit: null }), null, 2)}\n`);
    const policyFailed = parseTool(await primary.client.callTool({ name: 'bridge_status', arguments: {} }));
    assert.equal(policyFailed.payload.bridge.configured, true,
      'MCP treats gates.bridge.enabled as an effective Bridge enablement signal');
    assert.equal(policyFailed.payload.bridge.reason, 'ledger-valid');
    assert.equal(policyFailed.payload.bridge.policyStatus, 'failed');
    assert.equal(policyFailed.payload.bridge.status.ledger.ok, true);
    assert.equal(policyFailed.payload.bridge.status.summary.requiredFailed, 1);

    writeFileSync(join(bridgeDir, 'ledger.json'), '{}\n');
    const invalidLedger = parseTool(await primary.client.callTool({ name: 'bridge_status', arguments: {} }));
    assert.equal(invalidLedger.payload.bridge.reason, 'ledger-invalid');
    assert.equal(invalidLedger.payload.bridge.policyStatus, 'failed');
    assert.equal(invalidLedger.payload.bridge.status.ledger.ok, false);

    // A valid raw ledger must never mask a CLI config exit 2. Duplicate IDs
    // are a stable configFatal fixture produced by loadConfig itself.
    writeFileSync(join(bridgeDir, 'ledger.json'), `${JSON.stringify(emptyArtifactLedger({ root: project, commit: null }), null, 2)}\n`);
    writeFileSync(join(project, 'design', 'bridge.json'), `${JSON.stringify({
      schema: 'axion-bridge-config/v1',
      connections: [{
        id: 'duplicate-source', adapter: 'artifact', role: 'source', required: false,
        trust: 'linked', permissions: ['fs:read', 'network:artifact-origin'],
      }, {
        id: 'duplicate-source', adapter: 'artifact', role: 'source', required: false,
        trust: 'linked', permissions: ['fs:read', 'network:artifact-origin'],
      }],
    }, null, 2)}\n`);
    const configFailed = parseTool(await primary.client.callTool({ name: 'bridge_status', arguments: {} }));
    assert.equal(configFailed.payload.bridge.reason, 'config-error');
    assert.equal(configFailed.payload.bridge.configStatus, 'config-error');
    assert.equal(configFailed.payload.bridge.policyStatus, 'config-error');
    assert.equal(configFailed.payload.bridge.status.status, 'config-error');
    assert(configFailed.payload.bridge.connections.every((connection) => connection.status === 'config-error'));
    assert.equal(configFailed.payload.bridge.status.ledger, null,
      'MCP must not fall back to the pre-existing valid raw ledger');
    assert(configFailed.payload.bridge.configIssues.some((issue) => issue.path === 'bridge.source.connections[1].id'));

    const configFailedResource = JSON.parse((await primary.client.readResource({
      uri: 'axion://bridge/status',
    })).contents[0].text);
    assert.equal(configFailedResource.data.reason, 'config-error');
    assert.equal(configFailedResource.data.status.ledger, null);
    const configFailedPlan = parseTool(await primary.client.callTool({
      name: 'bridge_sync', arguments: { dryRun: true },
    }));
    assert.equal(configFailedPlan.payload.status, 'config-error');
    assert.equal(configFailedPlan.payload.reason, 'config-error');
    rmSync(join(bridgeDir, 'ledger.json'));

    writeFileSync(join(project, 'design', 'bridge.json'), `${JSON.stringify({
      schema: 'axion-bridge-config/v1',
      connections: [{
        id: 'required-preflight', adapter: 'artifact', role: 'source', required: true,
        trust: 'linked', permissions: [],
      }],
    }, null, 2)}\n`);
    const failedPreflight = parseTool(await primary.client.callTool({
      name: 'bridge_sync', arguments: { dryRun: true },
    }));
    assert.equal(failedPreflight.payload.status, 'preflight-failed');
    assert.equal(failedPreflight.payload.reason, 'doctor-failed');

    writeFileSync(join(project, 'design', 'bridge.json'), `${JSON.stringify({
      schema: 'axion-bridge-config/v1',
      connections: [{
        id: 'optional-preflight', adapter: 'artifact', role: 'source', required: false,
        trust: 'linked', permissions: [],
      }],
    }, null, 2)}\n`);
    const warningPreflight = parseTool(await primary.client.callTool({
      name: 'bridge_sync', arguments: { dryRun: true },
    }));
    assert.equal(warningPreflight.payload.status, 'planned-with-warnings');
  }

  // A custom adapter is executable repository code. Read-only MCP preflight
  // must surface it for manual review without importing the module.
  const customSideEffect = join(workspace, 'custom-adapter-was-imported');
  writeFileSync(join(project, 'custom-adapter.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(customSideEffect)}, 'unsafe import side effect');
export const manifest = { id: 'custom-proof', version: '1.0.0', lifecycle: ['collect'], permissions: { collect: [] } };
export async function collect() { return []; }
`);
  writeFileSync(join(project, 'design', 'bridge.json'), `${JSON.stringify({
    schema: 'axion-bridge-config/v1',
    connections: [{
      id: 'custom-proof', adapter: 'custom-proof', role: 'source', required: false,
      module: 'custom-adapter.mjs', permissions: [],
    }],
  }, null, 2)}\n`);
  const customPlan = parseTool(await primary.client.callTool({ name: 'bridge_sync', arguments: { dryRun: true } }));
  assert.equal(customPlan.payload.status, 'manual-review-required');
  assert.equal(customPlan.payload.reason, 'custom-adapter-executable');
  assert.deepEqual(customPlan.payload.connections, ['custom-proof']);
  assert.equal(existsSync(customSideEffect), false, 'MCP dry-run imported executable custom adapter code');

  // Network access must be explicit. The policy failure is returned as an MCP
  // tool error and cannot corrupt the protocol stream.
  const remoteProof = parseTool(await primary.client.callTool({
    name: 'proof',
    arguments: { app: 'https://example.com' },
  }));
  assert.equal(remoteProof.result.isError, true);
  assert.match(remoteProof.payload.error, /Remote App Proof is disabled/);

  const unconfiguredProof = parseTool(await primary.client.callTool({
    name: 'proof',
    arguments: {},
  }));
  assert.equal(unconfiguredProof.result.isError, true);
  assert.equal(unconfiguredProof.payload.exitCode, 2);
  assert.match(unconfiguredProof.payload.diagnostics, /requires a real Web app proof contract|需要真實 Web App 證據設定/);
  // A request after child stderr proves that diagnostics stayed inside the
  // tool result instead of contaminating the server's protocol stdout.
  assert.equal(parseTool(await primary.client.callTool({ name: 'bridge_status', arguments: {} })).payload.status, 'ok');

  // Executable project config may print to stdout. It runs in a quarantined
  // child, so a subsequent resource request still completes over clean stdio.
  const configPath = join(project, 'dk.config.mjs');
  writeFileSync(configPath, `console.log('CONFIG_NOISE_MUST_NOT_REACH_MCP');\n${readFileSync(configPath, 'utf8')}`);
  const directionAfterNoise = await primary.client.readResource({ uri: 'axion://direction' });
  assert.doesNotThrow(() => JSON.parse(directionAfterNoise.contents[0].text));
  const contextAfterNoise = await primary.client.readResource({ uri: 'axion://codex/context' });
  const contextAfterNoisePayload = JSON.parse(contextAfterNoise.contents[0].text);
  assert.equal(contextAfterNoisePayload.data.schema, 'axion-codex-context/v1');
  assert.equal(
    contextAfterNoisePayload.data.contextBytes,
    Buffer.byteLength(JSON.stringify(contextAfterNoisePayload.data)),
    'MCP Codex context reports the complete compact payload size',
  );
  const bridgeAfterNoise = parseTool(await primary.client.callTool({ name: 'bridge_status', arguments: {} }));
  assert.equal(bridgeAfterNoise.payload.bridge.reason, 'not-synced',
    'project config stdout cannot force MCP into a raw-ledger fallback or invalid-output state');
  assert.equal(bridgeAfterNoise.payload.bridge.policyStatus, 'incomplete');

  // A symlinked configured artifact cannot escape the fixed root.
  const tokenPath = join(project, 'design', 'tokens.json');
  const outsideTokenPath = join(workspace, 'outside-secret.json');
  writeFileSync(outsideTokenPath, JSON.stringify({ secret: 'MCP_MUST_NOT_READ_THIS' }));
  rmSync(tokenPath);
  symlinkSync(outsideTokenPath, tokenPath);
  const escapedTokens = await primary.client.readResource({ uri: 'axion://tokens' });
  const escapedText = escapedTokens.contents[0].text;
  const escapedPayload = JSON.parse(escapedText);
  assert.equal(escapedPayload.available, false);
  assert(!escapedText.includes('MCP_MUST_NOT_READ_THIS'));

  await primary.client.close();
  openClients.splice(openClients.indexOf(primary.client), 1);
  assert(!primary.stderr().includes('CONFIG_NOISE_MUST_NOT_REACH_MCP'));

  // Force both protocol content caps low enough to exercise truncation and
  // output-limit handling while retaining valid JSON responses.
  const capped = await connect([
    '--root', project,
    '--max-resource-bytes', '4096',
    '--max-tool-bytes', '8192',
  ]);
  openClients.push(capped.client);
  const cappedGraph = await capped.client.readResource({ uri: 'axion://system-graph' });
  assert(Buffer.byteLength(cappedGraph.contents[0].text) <= 4096);
  assert.equal(JSON.parse(cappedGraph.contents[0].text).schema, 'axion-mcp-truncated/v1');
  const cappedTool = parseTool(await capped.client.callTool({ name: 'system_graph', arguments: {} }));
  assert(Buffer.byteLength(cappedTool.text) <= 8192);
  const cappedStatus = cappedTool.payload.status ?? cappedTool.payload.summary?.status;
  assert(['output-limit', 'passed'].includes(cappedStatus), cappedTool.text);
  await capped.client.close();
  openClients.splice(openClients.indexOf(capped.client), 1);

  // A one-millisecond process budget deterministically proves that tool
  // subprocesses are killed and surfaced as MCP errors rather than hanging.
  const timed = await connect(['--root', project, '--timeout-ms', '1']);
  openClients.push(timed.client);
  const timedVerify = parseTool(await timed.client.callTool({ name: 'verify', arguments: {} }));
  assert.equal(timedVerify.result.isError, true);
  assert.equal(timedVerify.payload.status, 'timeout');
  assert.equal(timedVerify.payload.timeoutMs, 1);
  await timed.client.close();
  openClients.splice(openClients.indexOf(timed.client), 1);

  // Plugin-safe mode has no project evidence or mutation surface. It exposes
  // only the offline corpus and recommendation tool.
  const intelligenceOnly = await connect(['--intelligence-only']);
  openClients.push(intelligenceOnly.client);
  assert.deepEqual((await intelligenceOnly.client.listResources()).resources.map((entry) => entry.name), ['design_intelligence']);
  assert.deepEqual((await intelligenceOnly.client.listTools()).tools.map((entry) => entry.name), ['design_recommend']);
  const unclear = parseTool(await intelligenceOnly.client.callTool({
    name: 'design_recommend', arguments: { brief: 'Make it nice' },
  }));
  assert.equal(unclear.payload.data.status, 'needs-clarification');
  assert.deepEqual(unclear.payload.data.directions, []);
  await intelligenceOnly.client.close();
  openClients.splice(openClients.indexOf(intelligenceOnly.client), 1);

  process.stdout.write('mcp-server: official SDK stdio E2E passed\n');
} finally {
  await Promise.allSettled(openClients.map((client) => client.close()));
  rmSync(workspace, { recursive: true, force: true });
}

async function connect(extraArgs) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN, ...extraArgs],
    cwd: ROOT,
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += chunk.toString('utf8'); });
  const client = new Client({ name: 'axion-mcp-e2e', version: '1.0.0' });
  await client.connect(transport);
  return { client, stderr: () => diagnostics };
}

function parseTool(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  const text = result.content[0].text;
  return { result, text, payload: JSON.parse(text) };
}
