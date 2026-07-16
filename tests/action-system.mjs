import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const project = mkdtempSync(join(tmpdir(), 'axion-action-system-'));
const canonicalProject = realpathSync(project);
const actionScript = extractActionScript(readFileSync(join(root, 'action.yml'), 'utf8'));
assertCiTemplateSafety();

try {
  put('design/tokens.json', JSON.stringify({
    color: {
      text: { primary: { $type: 'color', $value: '#111111' } },
      surface: { page: { $type: 'color', $value: '#ffffff' } },
    },
  }, null, 2));
  put('styles/tokens.css', ':root {\n  --color-surface-page: #ffffff;\n  --color-text-primary: #111111;\n}\n');
  put('index.html', '<!doctype html><html><head><title>Action fixture</title></head><body>Fixture</body></html>');
  put('storybook/index.json', JSON.stringify({
    v: 5,
    entries: {
      'button--default': {
        id: 'button--default', type: 'story', title: 'System/Button', name: 'Default',
        importPath: './Button.stories.tsx',
      },
    },
  }, null, 2));
  put('design/bridge.json', JSON.stringify({
    schema: 'axion-bridge-config/v1',
    connections: [{
      id: 'storybook-main', adapter: 'storybook', role: 'source', required: true,
      trust: 'verified', source: 'storybook/index.json', permissions: ['fs:read', 'network:storybook'],
      options: { expectedSha256: createHash('sha256').update(readFileSync(join(project, 'storybook/index.json'))).digest('hex') },
    }],
  }, null, 2));
  put('dk.config.json', JSON.stringify({
    tokens: { source: 'design/tokens.json', output: { css: 'styles/tokens.css' } },
    targets: ['index.html'],
    bridge: {
      enabled: true, source: 'design/bridge.json', artifactDir: '.axion/custom-evidence',
      freshnessMs: 86_400_000,
    },
    gates: { bridge: { enabled: true } },
  }, null, 2));

  const complete = runAction({
    args: 'verify --gate bridge --no-cache', bridgeSync: true, sarif: true, html: true,
  });
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(complete.outputs['exit-code'], '0', complete.stderr);
  assert.equal(complete.outputs['bridge-ledger-path'], join(canonicalProject, '.axion/custom-evidence/ledger.json'));
  assert.equal(complete.outputs['sarif-path'], join(canonicalProject, 'dk-report.sarif'));
  assert.equal(complete.outputs['html-path'], join(canonicalProject, 'dk-report.html'));
  assert(existsSync(complete.outputs['bridge-ledger-path']));
  assert(existsSync(complete.outputs['sarif-path']));
  assert(existsSync(complete.outputs['html-path']));

  const stale = runAction({
    args: 'bridge status --json', bridgeSync: false, sarif: true, html: true,
    outputName: 'stale-output',
  });
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(stale.outputs['exit-code'], '2', 'stale report.json must not be rendered as current evidence');
  assert.equal(stale.outputs['sarif-path'], '');
  assert.equal(stale.outputs['html-path'], '');
  assert.equal(stale.outputs['bridge-ledger-path'], '');

  mkdirSync(join(project, 'blocked-sarif'));
  const renderFailure = runAction({
    args: 'verify --gate bridge --no-cache', bridgeSync: false, sarif: true, html: false,
    sarifPath: 'blocked-sarif', outputName: 'failed-render-output',
  });
  assert.equal(renderFailure.status, 0, renderFailure.stderr);
  assert.notEqual(renderFailure.outputs['exit-code'], '0', 'render failure must fail closed');
  assert.equal(renderFailure.outputs['sarif-path'], '', 'failed render must never advertise a stale path');

  process.stdout.write('GitHub Action and CI templates: fresh evidence, publish opt-in, complete artifact bundles, credential safety, and render fail-closed passed\n');
} finally {
  rmSync(project, { recursive: true, force: true });
}

function put(file, content) {
  const path = join(project, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`);
}

function runAction({
  args, bridgeSync, sarif, html, sarifPath = 'dk-report.sarif', htmlPath = 'dk-report.html',
  outputName = 'github-output',
}) {
  const output = join(project, outputName);
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-c', actionScript], {
    cwd: project,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      DK_BIN: join(root, 'bin/dk.mjs'),
      DK_ENTRY: join(root, 'index.mjs'),
      DK_ARGS: args,
      DK_SARIF: String(sarif),
      DK_SARIF_PATH: sarifPath,
      DK_HTML: String(html),
      DK_HTML_PATH: htmlPath,
      DK_BRIDGE_SYNC: String(bridgeSync),
      DK_BRIDGE_PUBLISH: 'false',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });
  const outputs = {};
  for (const line of readFileSync(output, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at >= 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs };
}

function extractActionScript(source) {
  const marker = '      run: |\n';
  const start = source.indexOf(marker);
  const end = source.indexOf('\n\n    - name: Gate on dk exit code', start);
  assert(start >= 0 && end > start, 'action.yml main run block not found');
  return source.slice(start + marker.length, end)
    .split('\n')
    .map((line) => line.startsWith('        ') ? line.slice(8) : line)
    .join('\n');
}

function assertCiTemplateSafety() {
  const github = readFileSync(join(root, 'templates/integrations/github-actions-bridge.yml'), 'utf8');
  const gitlab = readFileSync(join(root, 'templates/integrations/gitlab-ci-bridge.yml'), 'utf8');
  const azure = readFileSync(join(root, 'templates/integrations/azure-pipelines-bridge.yml'), 'utf8');
  const jenkins = readFileSync(join(root, 'templates/integrations/Jenkinsfile.bridge'), 'utf8');
  const designWorkflow = readFileSync(join(root, '.github/workflows/design.yml'), 'utf8');
  const integrationDocs = readFileSync(join(root, 'docs/integrations.md'), 'utf8');

  assert.match(designWorkflow, /persist-credentials:\s*false/, 'The product workflow must not persist a PR checkout token');
  assert.match(designWorkflow, /include-hidden-files:\s*true/, 'The product workflow must actually upload hidden .dk evidence');
  assert.match(
    integrationDocs,
    /github\.event_name == 'push'[^\n]*steps\.dk\.outputs\.sarif-path != ''/,
    'Code scanning upload must stay limited to a trusted push',
  );
  assert.match(
    integrationDocs,
    /github\.event_name == 'pull_request'[^\n]*steps\.dk\.outputs\.sarif-path != ''/,
    'PR and fork reports must use the read-only artifact path',
  );

  assert.match(
    github,
    /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && vars\.AXION_BRIDGE_PUBLISH == 'true'/,
    'GitHub publish must require explicit opt-in on a trusted main push',
  );
  assert.equal(
    [...github.matchAll(/persist-credentials:\s*false/g)].length,
    2,
    'GitHub evidence and publish checkouts must not persist GITHUB_TOKEN',
  );
  assert.match(github, /AXION_BRIDGE_PRE_SYNC_COMMAND:.*\|\| ':'/, 'GitHub producer hook must default to a no-op');
  assert.equal(
    [...github.matchAll(/bash -euo pipefail -c "\$AXION_BRIDGE_PRE_SYNC_COMMAND"/g)].length,
    2,
    'GitHub must run the producer hook before evidence and publish sync',
  );
  assert.equal(
    [...github.matchAll(/^\s+AXION_BRIDGE_ARTIFACT_DIR: \.dk\/bridge$/gm)].length,
    2,
    'GitHub jobs must define the complete Bridge artifact directory',
  );
  assert.equal(
    [...github.matchAll(/\$\{\{ env\.AXION_BRIDGE_ARTIFACT_DIR \}\}/g)].length,
    2,
    'GitHub artifacts must preserve ledger and immutable objects together',
  );
  assert.equal(
    [...github.matchAll(/include-hidden-files:\s*true/g)].length,
    2,
    'GitHub must explicitly include the hidden .dk evidence directory',
  );
  assert.equal(
    [...github.matchAll(/^\s+AXION_WEBHOOK_ENDPOINT: /gm)].length,
    2,
    'GitHub evidence and publish jobs must inject the private webhook endpoint only through secrets',
  );
  assert.match(
    github,
    /name: Audit Bridge ledger\n\s+if: always\(\)/,
    'GitHub must audit the current run even when preflight or sync fails',
  );
  assert.match(
    github,
    /name: Run full Axion policy\n\s+if: always\(\)/,
    'GitHub must still produce the full policy report after Bridge failure',
  );
  assert.match(
    github,
    /name: Publish and verify sink receipts[\s\S]*?producer_code=\$\?[\s\S]*?status_code=\$\?[\s\S]*?for code in "\$producer_code" "\$publish_code" "\$status_code"/,
    'GitHub must audit publish even when its producer hook fails',
  );
  assert.match(github, /^\s+bridge-publish-status\.json$/m,
    'GitHub publish artifacts must include this run\'s status report');

  assert.match(gitlab, /AXION_BRIDGE_PUBLISH:\s*"false"/, 'GitLab publish must default off');
  assert.match(gitlab, /AXION_BRIDGE_ARTIFACT_DIR:\s*\.dk\/bridge/, 'GitLab must define the Bridge artifact directory');
  assert.equal(
    [...gitlab.matchAll(/^\s+- \$AXION_BRIDGE_ARTIFACT_DIR$/gm)].length,
    3,
    'GitLab jobs must transfer the complete Bridge artifact directory',
  );
  assert.match(gitlab, /AXION_BRIDGE_PRE_SYNC_COMMAND:\s*":"/, 'GitLab producer hook must default to a no-op');
  assert.equal(
    [...gitlab.matchAll(/bash -euo pipefail -c "\$AXION_BRIDGE_PRE_SYNC_COMMAND"/g)].length,
    2,
    'GitLab must run the producer hook before evidence and publish sync',
  );
  assert.match(
    gitlab,
    /\$AXION_BRIDGE_PUBLISH == "true"[^\n]*\$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH[^\n]*\$CI_PIPELINE_SOURCE == "push"/,
    'GitLab publish rule must require explicit opt-in and the default branch',
  );
  assert.match(
    gitlab,
    /doctor_code=\$\?[\s\S]*?status_code=\$\?[\s\S]*?for code in "\$doctor_code" "\$producer_code" "\$sync_code" "\$status_code"/,
    'GitLab must always audit and then preserve the first evidence-stage failure',
  );
  assert.match(gitlab, /axion:verify:[\s\S]*?when: always[\s\S]*?dk verify --full/,
    'GitLab must still produce a full policy report after evidence failure');
  assert.match(
    gitlab,
    /axion:publish:[\s\S]*?producer_code=\$\?[\s\S]*?status_code=\$\?[\s\S]*?for code in "\$producer_code" "\$publish_code" "\$status_code"/,
    'GitLab must audit publish even when its producer hook fails',
  );

  const azureFigmaDefault = azure.indexOf("- name: FIGMA_ACCESS_TOKEN\n    value: ''");
  const azureEndpointDefault = azure.indexOf("- name: AXION_WEBHOOK_ENDPOINT\n    value: ''");
  const azureWebhookDefault = azure.indexOf("- name: AXION_WEBHOOK_TOKEN\n    value: ''");
  const azureOptionalGroup = azure.indexOf('# - group: axion-bridge-secrets');
  assert(azureFigmaDefault >= 0 && azureEndpointDefault >= 0 && azureWebhookDefault >= 0,
    'Azure optional credentials must have safe empty defaults');
  assert.doesNotMatch(azure, /^\s+- group: axion-bridge-secrets/m, 'Azure source-only use must not require a variable group');
  assert(
    azureOptionalGroup > azureFigmaDefault && azureOptionalGroup > azureEndpointDefault && azureOptionalGroup > azureWebhookDefault,
    'Azure optional group must remain disabled by default and follow safe token defaults',
  );
  assert.match(azure, /name: AXION_BRIDGE_PUBLISH\n\s+value: 'false'/, 'Azure publish must default off');
  assert.match(azure, /name: AXION_BRIDGE_ARTIFACT_DIR\n\s+value: \.dk\/bridge/, 'Azure must define the Bridge artifact directory');
  assert.equal(
    [...azure.matchAll(/cp -R "\$AXION_BRIDGE_ARTIFACT_DIR"\/\./g)].length,
    2,
    'Azure artifacts must stage ledger and immutable objects together',
  );
  assert.match(azure, /name: AXION_BRIDGE_PRE_SYNC_COMMAND\n\s+value: ':'/, 'Azure producer hook must default to a no-op');
  assert.equal(
    [...azure.matchAll(/bash -euo pipefail -c "\$AXION_BRIDGE_PRE_SYNC_COMMAND"/g)].length,
    2,
    'Azure must run the producer hook before evidence and publish sync',
  );
  assert.match(
    azure,
    /eq\(variables\['AXION_BRIDGE_PUBLISH'\], 'true'\)[^\n]*eq\(variables\['Build\.SourceBranch'\], 'refs\/heads\/main'\)[^\n]*ne\(variables\['Build\.Reason'\], 'PullRequest'\)/,
    'Azure publish stage must require explicit opt-in on a trusted main build',
  );
  assert.match(
    azure,
    /displayName: Audit Bridge ledger\n\s+condition: succeededOrFailed\(\)/,
    'Azure must audit the current run after preflight or sync failure',
  );
  assert.match(
    azure,
    /displayName: Run full Axion policy\n\s+condition: succeededOrFailed\(\)/,
    'Azure must still produce the full policy report after Bridge failure',
  );

  assert.match(jenkins, /name: 'AXION_BRIDGE_PUBLISH',[\s\S]*?defaultValue: false/, 'Jenkins publish must default off');
  assert.match(jenkins, /expression \{ params\.AXION_BRIDGE_PUBLISH == true \}/, 'Jenkins publish stage must require opt-in');
  assert.match(
    jenkins,
    /expression \{ params\.AXION_BRIDGE_PUBLISH == true \}[\s\S]*?branch 'main'[\s\S]*?not \{ changeRequest\(\) \}/,
    'Jenkins publish must remain limited to a trusted main build',
  );
  assert.match(jenkins, /AXION_BRIDGE_FIGMA_CREDENTIAL_ID = ''/, 'Jenkins Figma credential must be optional');
  assert.match(jenkins, /AXION_BRIDGE_WEBHOOK_ENDPOINT_CREDENTIAL_ID = ''/, 'Jenkins webhook endpoint credential must be optional');
  assert.match(jenkins, /AXION_BRIDGE_WEBHOOK_CREDENTIAL_ID = ''/, 'Jenkins webhook credential must be optional');
  assert.match(jenkins, /AXION_BRIDGE_ARTIFACT_DIR = '\.dk\/bridge'/, 'Jenkins must define the Bridge artifact directory');
  assert.equal(
    [...jenkins.matchAll(/\$\{env\.AXION_BRIDGE_ARTIFACT_DIR\}\/\*\*/g)].length,
    2,
    'Jenkins archives must preserve ledger and immutable objects together',
  );
  assert.match(jenkins, /AXION_BRIDGE_PRE_SYNC_COMMAND = ':'/, 'Jenkins producer hook must default to a no-op');
  assert.equal(
    [...jenkins.matchAll(/sh -eu -c "\$AXION_BRIDGE_PRE_SYNC_COMMAND"/g)].length,
    2,
    'Jenkins must run the producer hook before evidence and publish sync',
  );
  assert.doesNotMatch(
    jenkins,
    /string\(\s*name:\s*'AXION_BRIDGE_(?:FIGMA|WEBHOOK|WEBHOOK_ENDPOINT)_CREDENTIAL_ID'/,
    'Credential IDs must never be user-selectable build parameters',
  );
  assert.doesNotMatch(
    jenkins,
    /credentialsId:\s*'axion-(?:figma-access-token|webhook-token)'/,
    'Jenkins must not require placeholder credentials',
  );
  assert.match(
    jenkins,
    /rm -rf -- "\$AXION_BRIDGE_ARTIFACT_DIR"[\s\S]*?rm -f -- bridge-status\.json bridge-publish-status\.json dk-report\.json/,
    'Jenkins must remove the complete evidence directory left by an earlier workspace build',
  );
  assert.match(
    jenkins,
    /def collectEvidence = \{[\s\S]*?try \{[\s\S]*?bridge sync[\s\S]*?\} finally \{[\s\S]*?bridge status --json/,
    'Jenkins must audit the current run even when preflight, production, or sync fails',
  );
  assert.match(
    jenkins,
    /post \{[\s\S]*?always \{[\s\S]*?dk verify --full --require-gates --json[\s\S]*?archiveArtifacts artifacts: "\$\{env\.AXION_BRIDGE_ARTIFACT_DIR\}\/\*\*,bridge-status\.json,dk-report\.json"/,
    'Jenkins must run and archive full policy diagnostics after evidence failure',
  );
  assert.match(
    jenkins,
    /def publishSinks = \{[\s\S]*?producer_code=\$\?[\s\S]*?status_code=\$\?[\s\S]*?for code in "\$producer_code" "\$publish_code" "\$status_code"/,
    'Jenkins must audit publish even when its producer hook fails',
  );
}
