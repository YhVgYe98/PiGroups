import type { DatabaseSync } from 'node:sqlite';
import type { Principal } from './context.ts';
import {
  type DmRef,
  type GroupRef,
  type MemberRow,
  conversationLastAt,
  conversationLastSeq,
  dmConvIdsOf,
  hasLiveChildren,
  liveChildren,
  allDmConvIds,
  getMember,
  parseDmConv,
  peerOf,
  senderName,
} from './store.ts';

export interface MemberView {
  id: string;
  name: string;
  parent_id: string | null;
  status: string;
  is_root: boolean;
  child_count: number;
  groups: GroupRef[];
  last_seen_at: number | null;
  created_at: number;
}

/** Groups this member belongs to: the one it owns, and its parent's (§3.3). */
export function groupRefsOf(db: DatabaseSync, member: MemberRow): GroupRef[] {
  const groups: GroupRef[] = [];
  if (hasLiveChildren(db, member.id)) groups.push({ to: `g:${member.id}`, owner: member.id });
  if (member.status === 'alive' && member.parent_id !== null) {
    const parent = getMember(db, member.parent_id);
    if (parent && parent.status === 'alive') groups.push({ to: `g:${parent.id}`, owner: parent.id });
  }
  return groups;
}

export function memberView(db: DatabaseSync, member: MemberRow): MemberView {
  return {
    id: member.id,
    name: member.name,
    parent_id: member.parent_id,
    status: member.status,
    is_root: member.is_root === 1,
    child_count: liveChildren(db, member.id).length,
    groups: groupRefsOf(db, member),
    last_seen_at: member.last_seen_at,
    created_at: member.created_at,
  };
}

export function dmRefsOf(db: DatabaseSync, memberId: string): DmRef[] {
  const refs: DmRef[] = [];
  for (const convId of dmConvIdsOf(db, memberId)) {
    const peer = peerOf(convId, memberId);
    if (peer !== undefined) refs.push({ to: convId, peer });
  }
  return refs;
}

export interface ConversationItem {
  to: string;
  kind: 'group' | 'dm';
  label: string;
  owner?: string;
  peer?: string;
  last_message_seq: number;
  last_at: number | null;
}

function groupConversation(db: DatabaseSync, owner: MemberRow): ConversationItem {
  return {
    to: `g:${owner.id}`,
    kind: 'group',
    label: owner.name,
    owner: owner.id,
    last_message_seq: conversationLastSeq(db, `g:${owner.id}`),
    last_at: conversationLastAt(db, `g:${owner.id}`),
  };
}

function dmConversation(db: DatabaseSync, convId: string, memberId: string): ConversationItem {
  const peer = peerOf(convId, memberId);
  const item: ConversationItem = {
    to: convId,
    kind: 'dm',
    label: peer !== undefined ? senderName(db, peer, 'member') : convId,
    last_message_seq: conversationLastSeq(db, convId),
    last_at: conversationLastAt(db, convId),
  };
  if (peer !== undefined) item.peer = peer;
  return item;
}

function sortConversations(items: ConversationItem[]): ConversationItem[] {
  return items.sort((left, right) => {
    const leftAt = left.last_at ?? -1;
    const rightAt = right.last_at ?? -1;
    if (leftAt !== rightAt) return rightAt - leftAt;
    return left.to < right.to ? -1 : left.to > right.to ? 1 : 0;
  });
}

/** `GET /v1/conversations` (§10.4). Unread is not the platform's: each client keeps its own (§10.4). */
export function conversationItems(db: DatabaseSync, principal: Principal): ConversationItem[] {
  if (principal.kind === 'human') {
    const items: ConversationItem[] = [];
    const owners = db
      .prepare(
        `SELECT * FROM members o
         WHERE o.status = 'alive'
           AND EXISTS (SELECT 1 FROM members c WHERE c.parent_id = o.id AND c.status = 'alive')
         ORDER BY o.created_at, o.id`,
      )
      .all() as unknown as MemberRow[];
    for (const owner of owners) items.push(groupConversation(db, owner));
    for (const convId of allDmConvIds(db)) {
      const parsed = parseDmConv(convId);
      if (!parsed) continue;
      const label = `${senderName(db, parsed.a, 'member')} & ${senderName(db, parsed.b, 'member')}`;
      items.push({
        to: convId,
        kind: 'dm',
        label,
        last_message_seq: conversationLastSeq(db, convId),
        last_at: conversationLastAt(db, convId),
      });
    }
    return sortConversations(items);
  }

  const member = principal.member;
  const items: ConversationItem[] = [];
  if (hasLiveChildren(db, member.id)) {
    items.push(groupConversation(db, member));
  }
  if (member.parent_id !== null) {
    const parent = getMember(db, member.parent_id);
    if (parent && parent.status === 'alive' && hasLiveChildren(db, parent.id)) {
      items.push(groupConversation(db, parent));
    }
  }
  for (const convId of dmConvIdsOf(db, member.id)) {
    items.push(dmConversation(db, convId, member.id));
  }
  return sortConversations(items);
}
