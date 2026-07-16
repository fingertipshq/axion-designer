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
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'axion-codex-pack-'));
const consumer = join(root, 'consumer');
const fakeHome = join(root, 'home');
const fakeCodexHome = join(root, 'codex-home');
const npmCache = join(root, 'npm-cache');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
mkdirSync(consumer, { recursive: true });
mkdirSync(fakeHome, { recursive: true });
mkdirSync(fakeCodexHome, { recursive: true });
writeFileSync(join(fakeHome, 'sentinel'), 'unchanged\n');

const env = {
  ...process.env,
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  CODEX_HOME: fakeCodexHome,
  NPM_CONFIG_CACHE: npmCache,
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  DK_LANG: 'en',
  NO_COLOR: '1',
};

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? consumer,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function digestTree(directory) {
  const hash = createHash('sha256');
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const key = relative(directory, path).split('\\').join('/');
      const stat = lstatSync(path);
      hash.update(`${key}\0${stat.isSymbolicLink() ? `link:${readlinkSync(path)}` : stat.isDirectory() ? 'dir' : 'file'}\0`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) hash.update(readFileSync(path));
    }
  };
  walk(directory);
  return hash.digest('hex');
}

try {
  const packed = run(npmCommand, ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: repo });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const packResult = JSON.parse(packed.stdout);
  assert.equal(Array.isArray(packResult), true);
  const tarball = resolve(root, packResult[0].filename);
  assert(existsSync(tarball), 'npm pack must produce a tarball');

  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`);
  const installed = run(npmCommand, [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball,
  ]);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);

  const pkgRoot = join(consumer, 'node_modules', 'axion-designer');
  const cli = join(pkgRoot, 'bin', 'dk.mjs');
  assert(existsSync(cli), 'packed CLI is missing');
  assert(existsSync(join(pkgRoot, '.codex-plugin', 'plugin.json')), 'packed plugin manifest is missing');
  assert(existsSync(join(pkgRoot, '.mcp.json')), 'packed stateless Plugin MCP config is missing');
  assert(existsSync(join(pkgRoot, 'skills', 'dk-design', 'SKILL.md')), 'packed Codex skill is missing');
  assert(existsSync(join(pkgRoot, 'src', 'codex', 'index.mjs')), 'packed Codex API is missing');
  assert(existsSync(join(pkgRoot, 'evals', 'codex', 'cases.json')), 'packed Codex eval cases are missing');
  assert.equal(existsSync(join(pkgRoot, 'templates', 'scaffold', '.dk')), false, 'packed scaffold must not contain runtime evidence');
  assert.match(
    readFileSync(join(pkgRoot, 'skills', 'dk-design', 'agents', 'openai.yaml'), 'utf8'),
    /allow_implicit_invocation:\s*false/,
  );

  const homeBefore = digestTree(fakeHome);
  const codexHomeBefore = digestTree(fakeCodexHome);
  const missing = run(process.execPath, [cli, 'codex', 'status', '--json']);
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).status, 'missing');

  const init = run(process.execPath, [cli, 'codex', 'init', '--json']);
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).status, 'ready');
  assert(existsSync(join(consumer, '.agents', 'skills', 'dk-design', 'SKILL.md')));

  const preflight = run(process.execPath, [
    join(consumer, '.agents', 'skills', 'dk-design', 'scripts', 'preflight.mjs'), '--cwd', consumer,
  ]);
  assert.equal(preflight.status, 0, preflight.stderr);
  const preflightJson = JSON.parse(preflight.stdout);
  assert.equal(preflightJson.runtime.kind, 'project-dependency');
  assert.equal(preflightJson.scope, 'repository');

  const configSideEffect = join(fakeHome, 'axion-js-config-executed');
  writeFileSync(join(consumer, 'dk.config.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "writeFileSync(join(process.env.HOME, 'axion-js-config-executed'), 'executed\\n');",
    'export default {};',
  ].join('\n'));
  const contextResult = run(process.execPath, [cli, 'codex', 'context', '--json']);
  assert.equal(contextResult.status, 0, contextResult.stderr || contextResult.stdout);
  const context = JSON.parse(contextResult.stdout);
  assert.equal(context.schema, 'axion-codex-context/v1');
  assert.equal(context.contextBudget, 12_288);
  assert(context.contextBytes <= 12_288, `packed context is ${context.contextBytes} bytes`);
  assert.equal(Buffer.byteLength(JSON.stringify(context)), context.contextBytes, 'contextBytes must describe the serialized context');
  assert.equal(context.configuration.status, 'requires-trust');
  assert.equal(context.configuration.executable, true);
  assert.equal(context.configuration.trusted, false);
  assert.equal(existsSync(configSideEffect), false, 'packed context must not execute JavaScript config by default');

  writeFileSync(join(consumer, 'smoke.mjs'), [
    "import { CODEX_CONTEXT_MAX_BYTES, inspectCodexIntegration } from 'axion-designer/codex';",
    "const status = inspectCodexIntegration(process.cwd());",
    "if (status.status !== 'ready' || CODEX_CONTEXT_MAX_BYTES !== 12288) process.exit(1);",
  ].join('\n'));
  const smoke = run(process.execPath, ['smoke.mjs']);
  assert.equal(smoke.status, 0, smoke.stderr);

  assert.equal(digestTree(fakeHome), homeBefore, 'packed Codex commands must not write HOME');
  assert.equal(digestTree(fakeCodexHome), codexHomeBefore, 'packed Codex commands must not write CODEX_HOME');
  console.log('Codex pack consumer: PASS (tarball, bounded safe context, subpath API, local install, explicit skill, no global writes)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
