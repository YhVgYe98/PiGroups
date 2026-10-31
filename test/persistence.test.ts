import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertOk,
  bootstrapRoot,
  call,
  poll,
  sendMessage,
  spawnMember,
  startServer,
  type Server,
} from './harness.ts';

test('conversation seqs and the consume cursor survive a restart on the same data directory', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pigroups-persist-'));
  let firstServer: Server | undefined;
  let secondServer: Server | undefined;
  try {
    firstServer = await startServer({ dataDir });
    const root = await bootstrapRoot(firstServer);
    const child = await spawnMember(firstServer, root, 'persist-child');

    const replay = await call(firstServer, 'POST', '/v1/members', {
      token: root.token,
      body: { name: 'persist-child', request_id: 'req-persist-child' },
    });
    assertOk(replay, 'replaying POST /v1/members with the same request_id');
    assert.equal(replay.body.member?.id, child.id, 'a replayed request_id returns the original member');
    assert.equal('token' in replay.body, false, 'a replayed request_id does not return a token again');

    const before = await sendMessage(firstServer, root, child.id, 'delivered before the restart');
    const firstBatch = await poll(firstServer, child);
    assert.ok(
      firstBatch.items.some((item: any) => item.kind === 'message' && item.seq === before.seq),
      'the child consumes the message before the restart',
    );

    await firstServer.stop();
    firstServer = undefined;

    secondServer = await startServer({ dataDir });

    const afterRestart = await poll(secondServer, child);
    assert.deepEqual(afterRestart.items, [], 'nothing is redelivered after the restart');

    const after = await sendMessage(secondServer, root, child.id, 'delivered after the restart');
    assert.equal(after.seq, before.seq + 1, 'the conversation seq continues after the restart');

    const deliveredAfter = await poll(secondServer, child);
    const messages = deliveredAfter.items.filter((item: any) => item.kind === 'message');
    assert.equal(messages.length, 1, 'the message posted after the restart is delivered once');
    assert.equal(messages[0].seq, after.seq, 'the delivered message carries the continued seq');
  } finally {
    if (firstServer) await firstServer.stop();
    if (secondServer) await secondServer.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
