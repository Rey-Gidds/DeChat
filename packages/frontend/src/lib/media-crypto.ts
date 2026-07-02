/**
 * Binary AES-256-GCM encrypt/decrypt for E2EE media blobs.
 * Reuses the existing room key (same key used for message encryption).
 */

export interface EncryptedMediaResult {
  encrypted: ArrayBuffer;
  iv: string; // base64-encoded 12-byte IV
}

/**
 * Encrypt a binary blob with the room AES-256-GCM key.
 * The IV is returned separately — it must be sent inside the encrypted message
 * metadata so the receiver can decrypt.
 */
export async function encryptMedia(
  plaintext: ArrayBuffer,
  roomKey: CryptoKey
): Promise<EncryptedMediaResult> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    roomKey,
    plaintext
  );
  return {
    encrypted: encryptedBuffer,
    iv: btoa(String.fromCharCode(...iv)),
  };
}

/**
 * Decrypt a binary blob fetched from CDN using the room key and IV.
 * AES-GCM provides authenticated encryption — tampered blobs or wrong keys
 * will cause a runtime error.
 */
export async function decryptMedia(
  encrypted: ArrayBuffer,
  roomKey: CryptoKey,
  ivBase64: string
): Promise<ArrayBuffer> {
  const iv = Uint8Array.from(atob(ivBase64), (c) => c.charCodeAt(0));
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    roomKey,
    encrypted
  );
}
