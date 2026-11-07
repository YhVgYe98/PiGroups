// The coverage index is generated from the test declarations, so it cannot drift
// into a second, stale list. Every test file must be classified in catalog.config.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { renderCatalog } from './catalog.ts';

test('the test catalog is current and every case is classified', () => {
  const expected = renderCatalog();
  const actual = readFileSync(new URL('./CATALOG.md', import.meta.url), 'utf8');
  assert.equal(actual, expected, 'test/CATALOG.md is stale; run `npm run test:catalog`');
});
