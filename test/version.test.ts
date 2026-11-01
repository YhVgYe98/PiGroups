import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { assertOk, call, startServer } from './harness.ts';

const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

type PackageManifest = { version: string };

/**
 * The drift guard for §16. `package.json` is the only place the number is
 * written, so the process that answers `/v1/health` has to agree with the file
 * on disk. If a future change hardcodes a version in the code instead, the two
 * diverge and this test turns red.
 */
test('GET /v1/health reports the same version as package.json', async () => {
  const manifest = JSON.parse(await readFile(PACKAGE_JSON, 'utf8')) as PackageManifest;
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'package.json carries a x.y.z version');

  const server = await startServer();
  try {
    const health = await call(server, 'GET', '/v1/health');
    assertOk(health, 'GET /v1/health');
    assert.equal(
      health.body.version,
      manifest.version,
      'GET /v1/health must report the version in package.json',
    );
    assert.equal(
      health.body.server_version,
      manifest.version,
      'the response envelope must carry the version in package.json',
    );
  } finally {
    await server.stop();
  }
});
