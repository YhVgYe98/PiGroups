import type { DatabaseSync } from 'node:sqlite';
import type { HumanRow, MemberRow } from './store.ts';
import type { PollHub } from './feed.ts';

export type Principal =
  | { kind: 'member'; member: MemberRow }
  | { kind: 'human'; human: HumanRow };

export interface AppEnv {
  Variables: {
    principal: Principal;
  };
}

export interface AppContext {
  db: DatabaseSync;
  hub: PollHub;
  startedAt: number;
}
