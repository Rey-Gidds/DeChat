/**
 * Optimistic ↔ persisted message reconciliation helpers.
 *
 * Builds temporary UiMessage entries from OutboxEntry for instant display,
 * then replaces them with the server-persisted message on ACK.
 */

import type { OutboxEntry } from "@/lib/outbox-db";
import type { UiMessage } from "@/components/chat/message-list";
import { getOutboxEntriesByRoom } from "@/lib/outbox-db";
import type { ReplyToInfo, MediaMetadata } from "./models";

export function buildOptimisticUiMessage(
  entry: OutboxEntry,
  currentUserId: string
): UiMessage {
  return {
    id: `optimistic:${entry.clientMessageId}`,
    clientMessageId: entry.clientMessageId,
    senderId: entry.senderId,
    body: entry.displayBody,
    createdAt: new Date(entry.createdAt).toISOString(),
    isOwn: entry.senderId === currentUserId,
    senderName: null,
    senderUserIndex: null,
    messageType: entry.messageType,
    status: entry.status.toLowerCase() as "pending" | "retrying" | "failed",
    replyTo: entry.replyTo,
  };
}

/**
 * Reconciles an optimistic message with the server-persisted version.
 * The caller must provide the already-decrypted body text.
 */
export function reconcileOptimisticMessage(
  clientMessageId: string,
  persistedMessage: { id: string; createdAt: string; senderName?: string | null; senderUserIndex?: number | null; senderPfp?: string | null; messageType?: "text" | "image" | "video" | "gif"; replyTo?: ReplyToInfo | null; mediaMetadata?: MediaMetadata },
  decryptedBody: string,
  currentUserId: string,
  setMessages: React.Dispatch<React.SetStateAction<UiMessage[]>>
): void {
  setMessages((prev) =>
    prev.map((m) =>
      m.id === `optimistic:${clientMessageId}`
        ? {
            id: persistedMessage.id,
            senderId: currentUserId,
            body: decryptedBody,
            createdAt: persistedMessage.createdAt,
            isOwn: true,
            senderName: persistedMessage.senderName ?? null,
            senderUserIndex: persistedMessage.senderUserIndex ?? null,
            senderPfp: persistedMessage.senderPfp ?? null,
            messageType: persistedMessage.messageType ?? "text",
            replyTo: persistedMessage.replyTo ?? null,
            mediaMetadata: persistedMessage.mediaMetadata ?? m.mediaMetadata,
          }
        : m
    )
  );
}

/**
 * Ciphertext fingerprint for EC-02 implicit reconciliation.
 * Uses first 16 chars of ciphertext + first 8 chars of iv — 24 chars total.
 * Collision probability is negligible for same-session messages.
 */
export function makeCipherprint(
  ciphertext: string,
  iv: string
): string {
  return ciphertext.slice(0, 16) + iv.slice(0, 8);
}

/**
 * Attempts to find an outbox entry matching a broadcast message's cipherprint.
 * Used when the ACK was lost but the broadcast arrived (EC-02).
 */
export async function findOutboxEntryByCipherprint(
  roomId: string,
  ciphertext: string,
  iv: string
): Promise<OutboxEntry | null> {
  const fingerprint = makeCipherprint(ciphertext, iv);
  const entries = await getOutboxEntriesByRoom(roomId);
  return (
    entries.find(
      (e) => makeCipherprint(e.ciphertext, e.iv) === fingerprint
    ) ?? null
  );
}

/**
 * Loads outbox entries for a room and builds optimistic UiMessages.
 * Used when opening a room — appends outbox entries below persisted messages.
 */
export async function loadOptimisticMessages(
  roomId: string,
  currentUserId: string
): Promise<UiMessage[]> {
  const entries = await getOutboxEntriesByRoom(roomId);
  return entries.map((e) => buildOptimisticUiMessage(e, currentUserId));
}