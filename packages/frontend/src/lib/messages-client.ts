import type { RealtimeRoomMessage } from "./socket-client";

export type EncryptedMessageRecord = RealtimeRoomMessage;

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) {
    const message =
      typeof data?.error === "string" ? data.error : "Request failed";
    throw new Error(message);
  }
  return data as T;
}

export async function fetchMessageHistory(
  roomId: string,
  options: { cursor?: string; limit?: number; direction?: "older" | "newer" } = {}
) {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.direction === "newer") params.set("direction", "newer");

  const res = await fetch(
    `/api/rooms/${roomId}/messages?${params.toString()}`,
    { credentials: "include" }
  );

  return parseJson<{
    messages: EncryptedMessageRecord[];
    nextCursor: string | null;
  }>(res);
}

export async function syncMessagesSince(
  roomId: string,
  since: string,
  sinceId?: string
) {
  const params = new URLSearchParams({ since });
  if (sinceId) params.set("sinceId", sinceId);

  const res = await fetch(
    `/api/rooms/${roomId}/messages?${params.toString()}`,
    { credentials: "include" }
  );

  return parseJson<{ messages: EncryptedMessageRecord[] }>(res);
}

export interface ResumeResponse {
  strategy: "UP_TO_DATE" | "DELTA" | "REPLACE";
  messages: EncryptedMessageRecord[];
}

export async function resumeSync(
  roomId: string,
  newestCachedMessageId?: string,
  newestCachedCreatedAt?: string
): Promise<ResumeResponse> {
  const params = new URLSearchParams();
  if (newestCachedMessageId) params.set("newestCachedMessageId", newestCachedMessageId);
  if (newestCachedCreatedAt) params.set("newestCachedCreatedAt", newestCachedCreatedAt);

  const res = await fetch(
    `/api/rooms/${roomId}/messages/resume?${params.toString()}`,
    { credentials: "include" }
  );

  return parseJson<ResumeResponse>(res);
}

export interface MessagesAroundResponse {
  messages: EncryptedMessageRecord[];
  targetMessageId: string;
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor: string | null;
  newerCursor: string | null;
  reason?: string;
}

export async function fetchMessagesAround(
  roomId: string,
  messageId: string,
  limit = 25
): Promise<MessagesAroundResponse> {
  const params = new URLSearchParams({ messageId, limit: String(limit) });
  const res = await fetch(
    `/api/rooms/${roomId}/messages/around?${params.toString()}`,
    { credentials: "include" }
  );
  return parseJson<MessagesAroundResponse>(res);
}
