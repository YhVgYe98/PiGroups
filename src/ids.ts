import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const ADJECTIVES = [
  'quiet', 'brave', 'clever', 'steady', 'brisk', 'humble', 'keen', 'lucid',
  'nimble', 'plain', 'rapid', 'solid', 'tidy', 'vivid', 'warm', 'zesty',
];

const NOUNS = [
  'otter', 'falcon', 'maple', 'harbor', 'lemon', 'pebble', 'summit', 'tailor',
  'walnut', 'willow', 'anchor', 'beacon', 'cedar', 'ember', 'glacier', 'quarry',
];

/** `m_` / `h_` followed by 6 hex characters. */
export function newId(prefix: 'm' | 'h'): string {
  return `${prefix}_${randomBytes(3).toString('hex')}`;
}

/** The plaintext token. Only its hash is stored. */
export function newToken(): string {
  return `pgt_${randomBytes(24).toString('hex')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** `adjective-noun-4hex`, used when the creator does not supply a name. */
export function randomName(): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  return `${adjective}-${noun}-${randomBytes(2).toString('hex')}`;
}

/** The one magic value of the `mentions` array: "everyone in this group" (§5.2). */
export function isAllMention(value: string): boolean {
  return value === 'all';
}

/** Constant-time comparison, used for the admin token (§10.2). */
export function tokensMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
