// The platform is published as an npm server package, not as a Pi package. Its
// manifest is the install contract: public, licensed, versioned, and with an entry
// point that a consumer can actually run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, any>;

test('the platform package is public and licensed', () => {
  assert.equal(pkg.private, false);
  assert.equal(pkg.license, 'MIT');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof pkg.description, 'string');
  assert.equal(pkg.repository.type, 'git');
  assert.match(pkg.repository.url, /^git\+https:/);
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(changelog, /^## 0\.7\.2\b/m, 'the changelog has this release');
});

test('the package exposes a runnable bin and the package metadata', () => {
  assert.equal(pkg.bin.pigroups, 'bin/pigroups.js');
  assert.ok(existsSync(new URL('../bin/pigroups.js', import.meta.url)));
  assert.match(readFileSync(new URL('../bin/pigroups.js', import.meta.url), 'utf8'), /^#!\/usr\/bin\/env node/);
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.ok(existsSync(new URL('../src/main.ts', import.meta.url)));
});

test('the tarball list contains only shipping files', () => {
  assert.deepEqual(
    [...pkg.files].sort(),
    ['dist', 'bin', 'README.md', 'CHANGELOG.md', 'LICENSE', 'docs/设计说明.md', 'docs/概念稿.md'].sort(),
  );
  assert.equal(pkg.files.includes('test'), false);
  assert.equal(pkg.files.includes('AGENTS.md'), false);
});
