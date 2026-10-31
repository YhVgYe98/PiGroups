import { createHash, randomBytes, randomInt } from 'node:crypto';

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

/** Values of the `mentions` array that mean "everyone in this group". */
export function isAllMention(value: string): boolean {
  return value === 'all' || value === '@all';
}
