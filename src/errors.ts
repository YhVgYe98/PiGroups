/** The error contract of `docs/设计说明.md` §10.1. */
export class ApiError extends Error {
  status: number;
  code: string;
  detail: Record<string, unknown>;

  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function badRequest(message: string, detail: Record<string, unknown> = {}): ApiError {
  return new ApiError(400, 'bad_request', message, detail);
}

export function unknownMention(memberId: string): ApiError {
  return new ApiError(400, 'unknown_mention', `mention target is not a member of the group: ${memberId}`, { member_id: memberId });
}

export function invalidCmd(length: number): ApiError {
  return new ApiError(400, 'invalid_cmd', 'cmd must be a string of 1-200 characters', { length });
}

export function invalidToken(): ApiError {
  return new ApiError(401, 'invalid_token', 'token missing or not recognised');
}

export function forbidden(message = 'not allowed by structure'): ApiError {
  return new ApiError(403, 'forbidden', message);
}

export function notFound(message = 'member not found'): ApiError {
  return new ApiError(404, 'not_found', message);
}

export function noSuchGroup(ownerId: string): ApiError {
  return new ApiError(404, 'no_such_group', 'group does not exist', { owner: ownerId });
}

export function pollInProgress(): ApiError {
  return new ApiError(409, 'poll_in_progress', 'this member already has a poll waiting');
}

export function nameTaken(name: string): ApiError {
  return new ApiError(409, 'name_taken', `name already used: ${name}`, { name });
}

export function rootProtected(): ApiError {
  return new ApiError(409, 'root_protected', 'the root member cannot be deleted');
}

export function alreadyBootstrapped(): ApiError {
  return new ApiError(409, 'already_bootstrapped', 'this workspace already has a root member');
}

export function memberGone(memberId: string): ApiError {
  return new ApiError(410, 'member_gone', 'member is gone', { member_id: memberId });
}

export function payloadTooLarge(limit: number, size: number): ApiError {
  return new ApiError(413, 'payload_too_large', `payload exceeds ${limit} bytes`, { limit, size });
}
