import { decryptMessage, encryptMessage } from "./crypto";
import type { ReplyToInfo } from "./models";

/**
 * Encrypts a preview snippet (up to 60 chars) for embedding in a replyTo subdocument.
 * For media types, returns null fields (icon is deterministic).
 */
export async function encryptMessagePreview(
  text: string | null,
  messageType: "text" | "image" | "video" | "gif",
  roomKey: CryptoKey
): Promise<{
  previewIv: string | null;
  previewCiphertext: string | null;
  previewAuthTag: string | null;
}> {
  if (messageType !== "text") {
    return { previewIv: null, previewCiphertext: null, previewAuthTag: null };
  }

  const truncated = (text ?? "").slice(0, 60);
  const encrypted = await encryptMessage(truncated, roomKey);
  return {
    previewIv: encrypted.iv,
    previewCiphertext: encrypted.ciphertext,
    previewAuthTag: encrypted.authTag,
  };
}

/**
 * Decrypts a reply preview from a replyTo subdocument.
 * The preview was encrypted with the reply message's own key version ($V_{reply}).
 * For media types, returns a deterministic icon label (no decryption needed).
 * Falls back to "message unavailable" if decryption fails or the key is missing.
 */
export async function decryptReplyPreview(
  replyTo: ReplyToInfo,
  roomKey: CryptoKey | null
): Promise<string> {
  if (replyTo.messageType !== "text") {
    const label: Record<string, string> = {
      image: "📷 Image",
      video: "🎬 Video",
      gif: "📹 GIF",
    };
    return label[replyTo.messageType] ?? "📎 Media";
  }

  if (!roomKey) {
    return "message unavailable";
  }

  try {
    return await decryptMessage(
      {
        ciphertext: replyTo.previewCiphertext!,
        iv: replyTo.previewIv!,
        authTag: replyTo.previewAuthTag!,
      },
      roomKey
    );
  } catch {
    return "message unavailable";
  }
}
