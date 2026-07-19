/**
 * Binary AES-256-GCM encrypt/decrypt for E2EE media blobs.
 * Reuses the existing room key (same key used for message encryption).
 *
 * Phase D: adds per-chunk IV mode for progressive video streaming.
 */

export interface EncryptedMediaResult {
  encrypted: ArrayBuffer;
  iv: string; // base64-encoded 12-byte IV
}

export interface EncryptedChunkedResult {
  /** Concatenated ciphertext of all chunks (each chunk ciphertext = plaintext_chunk + 16-byte GCM tag). */
  encrypted: ArrayBuffer;
  /** Base IV from which per-chunk IVs are deterministically derived. */
  ivBase: string;
  /** Per-chunk IVs (base64). Derived deterministically from ivBase + chunkIndex. */
  chunkIvMap: string[];
  /** Number of chunks. */
  totalChunks: number;
  /** Plaintext chunk size (bytes). Last chunk may be smaller. */
  chunkSize: number;
}

// ─── Single-chunk mode (existing, for images and thumbnails) ─────

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

// ─── Per-chunk IV mode (Phase D: progressive video streaming) ─────

const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MiB per chunk
const GCM_TAG_LENGTH = 16; // AES-GCM appends 16-byte auth tag

/**
 * Derive the IV for a specific chunk deterministically from the base IV and chunk index.
 *
 * Scheme: IV_i = ivBase XOR (big-endian 64-bit index, right-aligned in the last 8 bytes)
 * This guarantees a unique IV per chunk while keeping the overhead to a single base IV
 * in the metadata (no need to store the full chunkIvMap on the wire).
 *
 * The first 4 bytes of the IV are left unchanged (they come from the base IV),
 * and the last 8 bytes are XORed with the big-endian chunk index.
 */
export function deriveChunkIV(ivBaseBase64: string, chunkIndex: number): Uint8Array {
  const ivBase = Uint8Array.from(atob(ivBaseBase64), (c) => c.charCodeAt(0));
  const iv = new Uint8Array(12);
  iv.set(ivBase);

  // XOR the last 8 bytes with the chunk index (big-endian)
  let idx = chunkIndex;
  for (let i = 11; i >= 4; i--) {
    iv[i] ^= idx & 0xff;
    idx >>>= 8;
  }

  return iv;
}

/**
 * Calculate the byte offsets for a specific chunk in the concatenated ciphertext.
 * Each chunk's ciphertext = plaintext_chunk + 16-byte GCM tag.
 * The last chunk may have a smaller plaintext size.
 */
export function getChunkCiphertextBounds(
  chunkIndex: number,
  chunkSize: number,
  totalPlaintextSize: number
): { start: number; end: number; plaintextSize: number } {
  const totalFullChunks = Math.ceil(totalPlaintextSize / chunkSize);
  const isLast = chunkIndex === totalFullChunks - 1;
  const plaintextSize = isLast
    ? totalPlaintextSize - chunkIndex * chunkSize
    : chunkSize;

  // Each encrypted chunk = plaintext_chunk + GCM_TAG_LENGTH
  const encryptedChunkSize = chunkSize + GCM_TAG_LENGTH;
  const lastEncryptedChunkSize = isLast ? plaintextSize + GCM_TAG_LENGTH : plaintextSize + GCM_TAG_LENGTH;

  // Actually the issue is that non-last chunks always have chunkSize + 16,
  // and the last chunk has plaintextSize + 16.
  const sizes = Array.from({ length: totalFullChunks }, (_, i) => {
    if (i === totalFullChunks - 1) {
      return (totalPlaintextSize - i * chunkSize) + GCM_TAG_LENGTH;
    }
    return chunkSize + GCM_TAG_LENGTH;
  });

  const start = sizes.slice(0, chunkIndex).reduce((a, b) => a + b, 0);
  const end = start + sizes[chunkIndex];

  return { start, end, plaintextSize };
}

/**
 * Encrypt a buffer in chunks for progressive streaming.
 *
 * Each chunk is encrypted independently with its own derived IV so the
 * receiver can decrypt individual chunks without the full file, enabling
 * HTTP Range requests + MSE progressive playback.
 */
export async function encryptMediaChunked(
  plaintext: ArrayBuffer,
  roomKey: CryptoKey,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): Promise<EncryptedChunkedResult> {
  const totalSize = plaintext.byteLength;
  const ivBase = crypto.getRandomValues(new Uint8Array(12));
  const ivBaseBase64 = btoa(String.fromCharCode(...ivBase));
  const chunks: ArrayBuffer[] = [];
  const chunkIvMap: string[] = [];

  let offset = 0;
  let chunkIndex = 0;

  while (offset < totalSize) {
    const end = Math.min(offset + chunkSize, totalSize);
    const chunk = plaintext.slice(offset, end);

    // Derive IV for this chunk
    const iv = deriveChunkIV(ivBaseBase64, chunkIndex);
    chunkIvMap.push(btoa(String.fromCharCode(...iv)));

    const encryptedChunk = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      roomKey,
      chunk
    );

    chunks.push(encryptedChunk);

    offset = end;
    chunkIndex++;
  }

  // Concatenate all encrypted chunks into one buffer
  const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const concatenated = new Uint8Array(totalLength);
  let concatOffset = 0;
  for (const chunk of chunks) {
    concatenated.set(new Uint8Array(chunk), concatOffset);
    concatOffset += chunk.byteLength;
  }

  return {
    encrypted: concatenated.buffer,
    ivBase: ivBaseBase64,
    chunkIvMap,
    totalChunks: chunkIndex,
    chunkSize,
  };
}

/**
 * Decrypt a single encrypted chunk (for progressive streaming).
 * The IV is derived from the base IV and chunk index.
 */
export async function decryptChunk(
  encryptedChunk: ArrayBuffer,
  roomKey: CryptoKey,
  iv: Uint8Array
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    roomKey,
    encryptedChunk
  );
}

/**
 * Get the total encrypted size when a plaintext is encrypted with chunked mode.
 * Useful for HEAD requests to determine total size on the wire.
 */
export function getEncryptedChunkedSize(
  totalPlaintextSize: number,
  chunkSize: number
): number {
  const totalChunks = Math.ceil(totalPlaintextSize / chunkSize);
  const lastChunkSize = totalPlaintextSize % chunkSize || chunkSize;
  return (totalChunks - 1) * (chunkSize + GCM_TAG_LENGTH) + (lastChunkSize + GCM_TAG_LENGTH);
}

/**
 * Given a desired plaintext byte range, calculate which encrypted chunks to fetch
 * and their ciphertext byte offsets.
 */
export function getRangeForPlaintextRange(
  plaintextStart: number,
  plaintextEnd: number,
  chunkSize: number
): {
  firstChunk: number;
  lastChunk: number;
  ciphertextStart: number;
  ciphertextEnd: number;
} {
  const firstChunk = Math.floor(plaintextStart / chunkSize);
  const lastChunk = Math.floor((plaintextEnd - 1) / chunkSize);

  // Compute ciphertext offset of first chunk
  const ciphertextStart = firstChunk * (chunkSize + GCM_TAG_LENGTH);

  // Compute ciphertext end (end of last chunk)
  // For the last chunk we need to be generous — assume full chunk size
  const chunksBeforeLast = lastChunk;
  const ciphertextEnd = chunksBeforeLast * (chunkSize + GCM_TAG_LENGTH) + (chunkSize + GCM_TAG_LENGTH);

  return { firstChunk, lastChunk, ciphertextStart, ciphertextEnd };
}
