import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const failures = [];

const repositoryUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
if (!repositoryUrl || /OWNER|example\.com/i.test(repositoryUrl)) {
  failures.push('package.json needs the real public repository URL');
}
if (!pkg.homepage || /OWNER|example\.com/i.test(pkg.homepage)) {
  failures.push('package.json needs the real project homepage');
}
if (!pkg.bugs?.url || /OWNER|example\.com/i.test(pkg.bugs.url)) {
  failures.push('package.json needs the real issue-tracker URL');
}

const distributionSurfaces = [
  'action.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  'docs/integrations.md',
  'README.md',
  'README.zh-TW.md',
];
for (const file of distributionSurfaces) {
  if (/OWNER\/axion-designer/.test(read(file))) failures.push(`${file} still contains OWNER/axion-designer`);
}

if (failures.length) {
  process.stderr.write(
    `release identity is incomplete:\n- ${failures.join('\n- ')}\n\n` +
    'Set the public GitHub account, replace OWNER/axion-designer, and add the real package URLs before publishing.\n',
  );
  process.exitCode = 1;
} else {
  process.stdout.write('release identity passed: package and distribution surfaces point at real public locations\n');
}
