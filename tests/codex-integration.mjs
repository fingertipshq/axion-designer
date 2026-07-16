#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReferenceSystem } from '../src/reference/index.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repo, 'bin', 'dk.mjs');
const root = mkdtempSync(join(tmpdir(), 'axion-codex-'));
const fakeHome = join(root, 'home');
const fakeCodexHome = join(root, 'codex-home');
mkdirSync(fakeHome, { recursive: true });
mkdirSync(fakeCodexHome, { recursive: true });
writeFileSync(join(fakeHome, 'sentinel'), 'unchanged\n');

function run(cwd, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      DK_LANG: 'en',
      NO_COLOR: '1',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CODEX_HOME: fakeCodexHome,
      XDG_CACHE_HOME: join(root, 'xdg-cache'),
    },
  });
}

function digestTree(directory, options = {}) {
  const hash = createHash('sha256');
  const ignored = new Set((options.ignore ?? []).map((path) => resolve(path)));
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (ignored.has(resolve(path))) continue;
      const key = relative(directory, path).split('\\').join('/');
      hash.update(`${key}\0${entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : entry.isDirectory() ? 'dir' : 'file'}\0`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(readFileSync(path));
    }
  };
  walk(directory);
  return hash.digest('hex');
}

try {
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'index.html'), '<!doctype html><title>Project</title>\n');

  const homeBefore = digestTree(fakeHome);
  const codexHomeBefore = digestTree(fakeCodexHome);

  const homeStatus = run(fakeHome, ['codex', 'status', '--json']);
  assert.equal(homeStatus.status, 2);
  assert.equal(JSON.parse(homeStatus.stdout).scopeGuard.status, 'forbidden');
  const homeInstall = run(fakeHome, ['codex', 'init', '--json']);
  assert.equal(homeInstall.status, 2);
  assert.equal(JSON.parse(homeInstall.stdout).code, 'DK_CODEX_SCOPE');
  assert.equal(JSON.parse(run(fakeHome, ['codex', 'context', '--json']).stdout).code, 'DK_CODEX_SCOPE');
  assert.equal(JSON.parse(run(fakeHome, ['codex', 'mcp', '--json']).stdout).code, 'DK_CODEX_SCOPE');
  assert.equal(digestTree(fakeHome), homeBefore, 'home-directory integration refusal writes nothing');
  assert.equal(digestTree(fakeCodexHome), codexHomeBefore, 'global-scope refusal leaves CODEX_HOME untouched');

  const missing = run(project, ['codex', 'status', '--json']);
  assert.equal(missing.status, 2, 'missing repo integration is setup-required');
  assert.equal(JSON.parse(missing.stdout).status, 'missing');
  assert.equal(JSON.parse(missing.stdout).runtime.status, 'missing');
  const missingRuntimeInstall = run(project, ['codex', 'init', '--json']);
  assert.equal(missingRuntimeInstall.status, 2);
  assert.equal(JSON.parse(missingRuntimeInstall.stdout).code, 'DK_CODEX_RUNTIME');
  assert.equal(existsSync(join(project, '.agents')), false, 'runtime refusal writes no partial integration');

  mkdirSync(join(project, 'node_modules'), { recursive: true });
  const fakeDependency = join(project, 'node_modules', 'axion-designer');
  mkdirSync(join(fakeDependency, 'bin'), { recursive: true });
  writeFileSync(join(fakeDependency, 'package.json'), `${JSON.stringify({ name: 'axion-designer', version: '1.0.0' })}\n`);
  writeFileSync(join(fakeDependency, 'bin', 'dk.mjs'), '// forged same-version runtime\n');
  const forgedRuntime = run(project, ['codex', 'init', '--json']);
  assert.equal(forgedRuntime.status, 2);
  assert.equal(JSON.parse(forgedRuntime.stdout).code, 'DK_CODEX_RUNTIME');
  rmSync(fakeDependency, { recursive: true, force: true });
  symlinkSync(repo, join(project, 'node_modules', 'axion-designer'), 'dir');

  const installed = run(project, ['codex', 'init', '--json']);
  assert.equal(installed.status, 0, installed.stderr);
  const installJson = JSON.parse(installed.stdout);
  assert.equal(installJson.changed, true);
  assert.equal(installJson.scope, 'repository');
  assert.equal(installJson.activation, 'explicit');
  assert.equal(installJson.isolation.installerWritesGlobalConfig, false);
  assert.equal(installJson.runtime.status, 'ready');
  const skillRoot = join(project, '.agents', 'skills', 'dk-design');
  assert(existsSync(join(skillRoot, 'SKILL.md')));
  assert.match(readFileSync(join(skillRoot, 'agents', 'openai.yaml'), 'utf8'), /allow_implicit_invocation:\s*false/);
  assert.equal(JSON.parse(readFileSync(join(skillRoot, '.axion-install.json'), 'utf8')).scope, 'repository');
  const installedPreflight = spawnSync(process.execPath, [join(skillRoot, 'scripts', 'preflight.mjs'), '--cwd', project], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, CODEX_HOME: fakeCodexHome },
  });
  assert.equal(installedPreflight.status, 0, installedPreflight.stderr);
  assert.equal(JSON.parse(installedPreflight.stdout).runtime.kind, 'project-dependency');
  mkdirSync(join(project, '.agents', 'bin'), { recursive: true });
  writeFileSync(join(project, '.agents', 'bin', 'dk.mjs'), 'throw new Error("must never execute");\n');
  const antiHijackPreflight = spawnSync(process.execPath, [join(skillRoot, 'scripts', 'preflight.mjs'), '--cwd', project], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, CODEX_HOME: fakeCodexHome },
  });
  assert.equal(antiHijackPreflight.status, 0, antiHijackPreflight.stderr);
  assert(!JSON.parse(antiHijackPreflight.stdout).runtime.args[0].includes('/.agents/bin/'),
    'preflight never considers a repository-controlled .agents/bin runtime');
  rmSync(join(project, '.agents', 'bin'), { recursive: true, force: true });
  assert.equal(digestTree(fakeHome), homeBefore, 'Codex init never writes HOME');
  assert.equal(digestTree(fakeCodexHome), codexHomeBefore, 'Codex init never writes CODEX_HOME');

  const ready = run(project, ['codex', 'status', '--json']);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).status, 'ready');
  const repeated = run(project, ['codex', 'init', '--json']);
  assert.equal(repeated.status, 0);
  assert.equal(JSON.parse(repeated.stdout).changed, false, 'repeat init is idempotent');

  // Monorepo: a nested package may consume the matching Axion runtime hoisted
  // to its containing Git workspace, but integration still belongs to the
  // nested package and must not spill into workspace/global state.
  const monorepo = join(root, 'monorepo');
  const nested = join(monorepo, 'packages', 'web');
  mkdirSync(nested, { recursive: true });
  const gitInit = spawnSync('git', ['init', '--quiet'], { cwd: monorepo, encoding: 'utf8' });
  assert.equal(gitInit.status, 0, gitInit.stderr || 'git init failed for monorepo fixture');
  writeFileSync(join(monorepo, 'package.json'), `${JSON.stringify({ private: true, workspaces: ['packages/*'] }, null, 2)}\n`);
  writeFileSync(join(nested, 'package.json'), `${JSON.stringify({ name: '@fixture/web', private: true }, null, 2)}\n`);
  writeFileSync(join(nested, 'index.html'), '<!doctype html><title>Nested package</title>\n');
  mkdirSync(join(monorepo, 'node_modules'), { recursive: true });
  symlinkSync(repo, join(monorepo, 'node_modules', 'axion-designer'), 'dir');
  const nestedAgents = join(nested, '.agents');
  const monorepoBefore = digestTree(monorepo, { ignore: [nestedAgents] });
  const monorepoHomeBefore = digestTree(fakeHome);
  const monorepoCodexHomeBefore = digestTree(fakeCodexHome);

  const bundledExternalPreflight = spawnSync(process.execPath, [
    join(repo, 'skills', 'dk-design', 'scripts', 'preflight.mjs'), '--cwd', nested,
  ], {
    cwd: nested,
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, CODEX_HOME: fakeCodexHome },
  });
  assert.equal(bundledExternalPreflight.status, 0, bundledExternalPreflight.stderr);
  const bundledExternalJson = JSON.parse(bundledExternalPreflight.stdout);
  assert.equal(bundledExternalJson.status, 'ready');
  assert.equal(bundledExternalJson.repository, realpathSync(nested));
  assert.equal(bundledExternalJson.runtime.kind, 'bundled-plugin');
  assert.equal(bundledExternalJson.runtime.args[0], join(repo, 'bin', 'dk.mjs'));
  assert.equal(bundledExternalJson.globalWrites, false);

  const bundledGlobalPreflight = spawnSync(process.execPath, [
    join(repo, 'skills', 'dk-design', 'scripts', 'preflight.mjs'), '--cwd', fakeHome,
  ], {
    cwd: nested,
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, CODEX_HOME: fakeCodexHome },
  });
  assert.equal(bundledGlobalPreflight.status, 2);
  assert.match(JSON.parse(bundledGlobalPreflight.stdout).issue, /home directory is global scope/);

  const nestedInstall = run(nested, ['codex', 'init', '--json']);
  assert.equal(nestedInstall.status, 0, nestedInstall.stderr || nestedInstall.stdout);
  const nestedInstallJson = JSON.parse(nestedInstall.stdout);
  assert.equal(nestedInstallJson.changed, true);
  assert.equal(nestedInstallJson.project, 'web');
  assert.equal(nestedInstallJson.scope, 'repository');
  assert.equal(nestedInstallJson.runtime.status, 'ready');
  assert.equal(nestedInstallJson.runtime.kind, 'project-dependency');
  assert.match(nestedInstallJson.runtime.path, /^\.\.\/\.\.\/node_modules\/axion-designer\/bin\/dk\.mjs$/);
  assert(existsSync(join(nestedAgents, 'skills', 'dk-design', 'SKILL.md')));
  assert(!existsSync(join(monorepo, '.agents')), 'hoisted workspace root receives no Codex integration');
  assert(!existsSync(join(monorepo, 'packages', '.agents')), 'workspace package container receives no Codex integration');

  const nestedSkill = join(nestedAgents, 'skills', 'dk-design');
  const nestedPreflight = spawnSync(process.execPath, [join(nestedSkill, 'scripts', 'preflight.mjs'), '--cwd', nested], {
    cwd: nested,
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, CODEX_HOME: fakeCodexHome },
  });
  assert.equal(nestedPreflight.status, 0, nestedPreflight.stderr || nestedPreflight.stdout);
  const nestedPreflightJson = JSON.parse(nestedPreflight.stdout);
  assert.equal(nestedPreflightJson.status, 'ready');
  assert.equal(nestedPreflightJson.repository, realpathSync(nested));
  assert.equal(nestedPreflightJson.runtime.kind, 'project-dependency');
  assert.equal(nestedPreflightJson.runtime.args[0], join(repo, 'bin', 'dk.mjs'));
  const nestedStatus = run(nested, ['codex', 'status', '--json']);
  assert.equal(nestedStatus.status, 0, nestedStatus.stderr || nestedStatus.stdout);
  assert.equal(JSON.parse(nestedStatus.stdout).status, 'ready');

  assert.equal(digestTree(monorepo, { ignore: [nestedAgents] }), monorepoBefore,
    'nested init changes only the nested package .agents directory');
  assert.equal(digestTree(fakeHome), monorepoHomeBefore, 'monorepo init leaves HOME untouched');
  assert.equal(digestTree(fakeCodexHome), monorepoCodexHomeBefore, 'monorepo init leaves CODEX_HOME untouched');

  rmSync(join(project, 'node_modules', 'axion-designer'));
  const runtimeLost = run(project, ['codex', 'status', '--json']);
  assert.equal(runtimeLost.status, 2);
  assert.equal(JSON.parse(runtimeLost.stdout).status, 'invalid');
  assert.equal(JSON.parse(runtimeLost.stdout).runtime.status, 'missing');
  symlinkSync(repo, join(project, 'node_modules', 'axion-designer'), 'dir');

  writeFileSync(join(skillRoot, 'references', 'taste.md'), '\ncustomized\n', { flag: 'a' });
  const stale = run(project, ['codex', 'status', '--json']);
  assert.equal(stale.status, 2);
  assert.equal(JSON.parse(stale.stdout).status, 'invalid');
  assert.match(JSON.parse(stale.stdout).skill.issue, /install receipt/);
  const refused = run(project, ['codex', 'init']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Refusing to overwrite/);

  const trap = join(root, 'trap');
  const outside = join(root, 'outside-skill');
  mkdirSync(join(trap, '.agents', 'skills'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'outside\n');
  symlinkSync(outside, join(trap, '.agents', 'skills', 'dk-design'), 'dir');
  const trapped = run(trap, ['codex', 'status', '--json']);
  assert.equal(trapped.status, 2);
  assert.equal(JSON.parse(trapped.stdout).status, 'invalid');
  assert.match(JSON.parse(trapped.stdout).skill.issue, /escapes the repository/);
  assert.equal(run(trap, ['codex', 'init']).status, 2);
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'outside\n');

  const broken = join(root, 'broken');
  mkdirSync(join(broken, '.agents', 'skills'), { recursive: true });
  symlinkSync(join(root, 'missing-skill'), join(broken, '.agents', 'skills', 'dk-design'), 'dir');
  const brokenStatus = run(broken, ['codex', 'status', '--json']);
  assert.equal(brokenStatus.status, 2);
  assert.equal(JSON.parse(brokenStatus.stdout).status, 'invalid');
  assert.match(JSON.parse(brokenStatus.stdout).skill.issue, /target is missing/);
  assert.equal(run(broken, ['codex', 'init']).status, 2);

  for (const lane of ['auto', 'explore', 'refine', 'reconstruct', 'reimagine', 'verify']) {
    const prompt = run(repo, ['codex', 'prompt', lane, '--json']);
    assert.equal(prompt.status, 0);
    const parsed = JSON.parse(prompt.stdout);
    assert.equal(parsed.lane, lane);
    assert.match(parsed.prompt, /\$dk-design/);
  }
  const unknownPrompt = run(repo, ['codex', 'prompt', 'unknown', '--json']);
  assert.equal(unknownPrompt.status, 2);
  assert.equal(JSON.parse(unknownPrompt.stdout).code, 'DK_CODEX_LANE');
  assert.equal(JSON.parse(run(repo, ['codex', 'prompt', 'EXPLORE', '--json']).stdout).lane, 'explore');

  const repoBeforeContext = digestTree(join(repo, 'skills'));
  const context = run(repo, ['codex', 'context', '--json']);
  assert.equal(context.status, 0, context.stderr);
  const contextJson = JSON.parse(context.stdout);
  assert.equal(contextJson.schema, 'axion-codex-context/v1');
  const actualContextBytes = Buffer.byteLength(JSON.stringify(contextJson));
  assert.equal(contextJson.contextBytes, actualContextBytes, 'reported contextBytes includes its own metadata fields');
  assert(actualContextBytes <= contextJson.contextBudget, `${actualContextBytes} exceeds context budget`);
  assert.equal(contextJson.authority.forbiddenGlobalWrites.includes('~/.codex'), true);
  assert.equal(contextJson.configuration.status, 'requires-trust');
  assert.equal(contextJson.configuration.trusted, false);
  assert(['explore', 'refine', 'verify'].includes(contextJson.suggestedLane.lane));
  assert.equal(digestTree(join(repo, 'skills')), repoBeforeContext, 'context is read-only');

  const referenceContextProject = join(root, 'reference-context');
  mkdirSync(join(referenceContextProject, 'src'), { recursive: true });
  writeFileSync(join(referenceContextProject, 'src', 'App.tsx'), 'export function App() { return <main>Home</main>; }\n');
  writeFileSync(join(referenceContextProject, 'home.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ));
  createReferenceSystem(referenceContextProject).registerReferences([{
    id: 'home',
    path: 'home.png',
    provenance: { type: 'user-provided', source: 'local:home.png', author: 'test user' },
    licence: { status: 'owned', identifier: 'test-owned' },
    viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
    authorizedScope: {
      projectPaths: ['src/**'], routes: ['/'],
      operations: ['decompose', 'map-components', 'plan-reconstruction', 'reconstruct', 'compare'],
    },
  }]);
  const referenceContext = run(referenceContextProject, ['codex', 'context', '--json']);
  assert.equal(referenceContext.status, 0, referenceContext.stderr);
  const referenceContextJson = JSON.parse(referenceContext.stdout);
  assert.equal(referenceContextJson.evidence.references.status, 'incomplete');
  assert.equal(referenceContextJson.evidence.references.references[0].stages.decomposition, 'missing');
  assert.equal(referenceContextJson.suggestedLane.lane, 'reconstruct');
  assert(referenceContextJson.nextCommands.includes('dk reference status --json'));

  const executableConfigProject = join(root, 'executable-config');
  mkdirSync(executableConfigProject);
  const sideEffect = join(executableConfigProject, 'CONFIG_EXECUTED');
  writeFileSync(join(executableConfigProject, 'dk.config.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sideEffect)}, 'executed\\n');\nexport default {};\n`);
  const safeContext = run(executableConfigProject, ['codex', 'context', '--json']);
  assert.equal(safeContext.status, 0, safeContext.stderr);
  assert.equal(JSON.parse(safeContext.stdout).configuration.status, 'requires-trust');
  assert.equal(existsSync(sideEffect), false, 'default Codex context never executes project JavaScript');
  const trustedContext = run(executableConfigProject, ['codex', 'context', '--json', '--trust-project-config']);
  assert.equal(trustedContext.status, 0, trustedContext.stderr);
  assert.equal(JSON.parse(trustedContext.stdout).configuration.status, 'trusted-executable');
  assert.equal(existsSync(sideEffect), true, 'executable config runs only after the explicit trust flag');

  const driftProject = join(root, 'binding-drift');
  mkdirSync(join(driftProject, 'design'), { recursive: true });
  mkdirSync(join(driftProject, 'node_modules'), { recursive: true });
  symlinkSync(repo, join(driftProject, 'node_modules', 'axion-designer'), 'dir');
  for (const name of ['tokens.json', 'direction.lock.json', 'approval-history.json']) {
    writeFileSync(join(driftProject, 'design', name), readFileSync(join(repo, 'design', name)));
  }
  const driftDirection = JSON.parse(readFileSync(join(repo, 'design', 'direction.json'), 'utf8'));
  driftDirection.bindings.accent = 'color.state.warning';
  writeFileSync(join(driftProject, 'design', 'direction.json'), `${JSON.stringify(driftDirection, null, 2)}\n`);
  const driftContext = run(driftProject, ['codex', 'context', '--json']);
  assert.equal(driftContext.status, 0, driftContext.stderr);
  assert.equal(JSON.parse(driftContext.stdout).direction.lock.directionMatches, true);
  assert.equal(JSON.parse(driftContext.stdout).direction.lock.bindingsMatch, false);
  assert.equal(JSON.parse(driftContext.stdout).direction.lock.status, 'drifted');
  assert.equal(JSON.parse(driftContext.stdout).suggestedLane.lane, 'verify');

  const unsafeProject = join(root, 'unsafe-context');
  mkdirSync(join(unsafeProject, 'design'), { recursive: true });
  mkdirSync(join(unsafeProject, '.dk'), { recursive: true });
  const secretArtifact = join(root, 'outside-context-secret.json');
  writeFileSync(secretArtifact, JSON.stringify({ secret: 'AXION_MUST_NOT_LEAK_OUTSIDE_JSON' }));
  symlinkSync(secretArtifact, join(unsafeProject, 'design', 'direction.json'));
  symlinkSync(secretArtifact, join(unsafeProject, '.dk', 'report.json'));
  const unsafeContext = run(unsafeProject, ['codex', 'context', '--json']);
  assert.equal(unsafeContext.status, 0, unsafeContext.stderr);
  assert.equal(JSON.parse(unsafeContext.stdout).direction.status, 'invalid');
  assert.equal(JSON.parse(unsafeContext.stdout).evidence.report.status, 'invalid');
  assert(!unsafeContext.stdout.includes('AXION_MUST_NOT_LEAK_OUTSIDE_JSON'));

  const mcp = run(repo, ['codex', 'mcp', '--json']);
  assert.equal(mcp.status, 0);
  const mcpJson = JSON.parse(mcp.stdout);
  assert.equal(mcpJson.scope, 'repository');
  assert.equal(mcpJson.cwd, repo);
  assert.equal(mcpJson.fixedRoot, true);
  assert.equal(mcpJson.writesConfig, false);
  assert.equal(mcpJson.primaryResource, 'axion://codex/context');
  assert.deepEqual(mcpJson.args.slice(-2), ['--root', repo]);

  const appParent = join(root, 'apps');
  mkdirSync(appParent);
  const created = run(appParent, ['new', 'a']);
  assert.equal(created.status, 0, created.stderr);
  const app = join(appParent, 'a');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  symlinkSync(repo, join(app, 'node_modules', 'axion-designer'), 'dir');
  assert.equal(existsSync(join(app, '.dk')), false, 'new project starts without inherited runtime evidence');
  assert.equal(run(app, ['report', '--json']).status, 2, 'no report exists before the first local verification');
  assert(existsSync(join(app, '.gitignore')));
  const verified = run(app, ['verify', '--summary']);
  assert.equal(verified.status, 0, verified.stderr);
  assert(existsSync(join(app, '.dk', 'report.json')), 'first local verification creates project-owned evidence');
  const freshContext = run(app, ['codex', 'context', '--json', '--trust-project-config']);
  assert.equal(freshContext.status, 0, freshContext.stderr);
  assert.equal(JSON.parse(freshContext.stdout).evidence.report.freshness.status, 'current');
  writeFileSync(join(app, 'index.html'), '\n<!-- source changed after verification -->\n', { flag: 'a' });
  const staleContext = run(app, ['codex', 'context', '--json', '--trust-project-config']);
  assert.equal(staleContext.status, 0, staleContext.stderr);
  assert.equal(JSON.parse(staleContext.stdout).evidence.report.status, 'stale');
  assert.match(JSON.parse(staleContext.stdout).evidence.report.freshness.reasons.join(' '), /source files changed/);

  const templateEvidence = join(repo, 'templates', 'scaffold', '.dk');
  assert.equal(existsSync(templateEvidence), false, 'shipped scaffold contains no runtime evidence directory');
  assert.equal(readFileSync(join(fakeHome, 'sentinel'), 'utf8'), 'unchanged\n');
  assert.equal(digestTree(fakeCodexHome), codexHomeBefore, 'all Codex commands leave CODEX_HOME untouched');

  console.log('Codex integration: PASS (repo-only explicit skill, bounded context, no global writes, clean scaffold)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
