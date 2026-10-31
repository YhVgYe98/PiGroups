import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';

const DEFAULT_PORT = 7717;

function listenPort(): number {
  const parsed = Number.parseInt(process.env.PORT ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

const dataDir = process.env.PIGROUPS_DATA ?? './.data';
const db = openDatabase(dataDir);
const app = createApp({ db, startedAt: Date.now() });

const server = serve({ fetch: app.fetch, port: listenPort() }, (info) => {
  console.log(`listening on ${info.port}`);
}) as unknown as { close: () => void; closeAllConnections?: () => void };

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections?.();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
