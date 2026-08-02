/**
 * Cryptographic helpers for Client-Side Key Management (E2EE)
 */

export const DB_NAME = "dechat-crypto-store";
const STORE_NAME = "private-keys";
const ROOM_KEY_STORE = "room-keys";
export const DB_VERSION = 7;
const ROOM_KEY_VERSIONS_STORE = "room-key-versions";
const OUTBOX_STORE = "message-outbox";
const UNREAD_COUNTS_STORE = "unread-counts";

// Initialize IndexedDB for secure local private key storage
function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(ROOM_KEY_STORE)) {
        db.createObjectStore(ROOM_KEY_STORE);
      }
      if (!db.objectStoreNames.contains(ROOM_KEY_VERSIONS_STORE)) {
        db.createObjectStore(ROOM_KEY_VERSIONS_STORE);
      }

      // NEW in v4: durable message outbox
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const outboxStore = db.createObjectStore(OUTBOX_STORE, {
          keyPath: "clientMessageId",
        });
        outboxStore.createIndex("by-room", "roomId", { unique: false });
        outboxStore.createIndex("by-next-retry", "nextRetryAt", { unique: false });
        outboxStore.createIndex("by-status", "status", { unique: false });
        outboxStore.createIndex("by-room-status", ["roomId", "status"], { unique: false });
        outboxStore.createIndex("by-failed-at", "failedAt", { unique: false });
      }

      // NEW in v5: message-cache and room-cache-meta
      if (!db.objectStoreNames.contains("message-cache")) {
        const msgStore = db.createObjectStore("message-cache", { keyPath: "id" });
        msgStore.createIndex("by-room", "roomId", { unique: false });
      }
      if (!db.objectStoreNames.contains("room-cache-meta")) {
        db.createObjectStore("room-cache-meta", { keyPath: "roomId" });
      }

      // NEW in v6: unread counts store (global WS migration)
      if (!db.objectStoreNames.contains(UNREAD_COUNTS_STORE)) {
        db.createObjectStore(UNREAD_COUNTS_STORE, { keyPath: "roomId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Generates an RSA-OAEP 2048-bit keypair for E2EE key exchange
 */
export async function generateUserKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true, // must be extractable for backup recovery kit downloads
    ["decrypt", "unwrapKey"]
  );
}

/**
 * Exports a public key to JWK format and encodes it as Base64 for database storage
 */
export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("jwk", publicKey);
  // Ensure key_ops includes what we import this key for later (encrypt + wrapKey).
  (exported as any).key_ops = ["encrypt", "wrapKey"];
  return btoa(JSON.stringify(exported));
}

/**
 * Imports a public key from Base64 JWK representation
 */
export async function importPublicKey(base64Jwk: string): Promise<CryptoKey> {
  const jwk = JSON.parse(atob(base64Jwk));
  // WebCrypto requires JWK `key_ops` to be a superset of the requested usages.
  if (!Array.isArray(jwk.key_ops)) {
    jwk.key_ops = ["encrypt", "wrapKey"];
  } else {
    const ops = new Set<string>(jwk.key_ops);
    ops.add("encrypt");
    ops.add("wrapKey");
    jwk.key_ops = Array.from(ops);
  }
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    true,
    ["encrypt", "wrapKey"]
  );
}

/**
 * Saves a private key securely in IndexedDB mapped to the user ID
 */
export async function savePrivateKey(userId: string, privateKey: CryptoKey): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(privateKey, userId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Retrieves the local private key from IndexedDB mapped to the user ID
 */
export async function getPrivateKey(userId: string): Promise<CryptoKey | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(userId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Generates and downloads an encrypted Backup / Recovery Kit of the private key.
 * Encrypted using AES-256-GCM derived from a user-supplied password.
 */
export async function downloadRecoveryKit(
  userId: string,
  privateKey: CryptoKey,
  passphrase: string
): Promise<void> {
  // Export private key to JWK string
  const exportedPrivateKey = await crypto.subtle.exportKey("jwk", privateKey);
  // Some browsers export `key_ops` too narrowly. Ensure it can be imported with the
  // usages we request later (decrypt + unwrapKey).
  (exportedPrivateKey as any).key_ops = ["decrypt", "unwrapKey"];
  const privateKeyString = JSON.stringify(exportedPrivateKey);
  
  // Derivation of key from passphrase using PBKDF2
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  // Encrypt the private key JWK string
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
    },
    aesKey,
    enc.encode(privateKeyString)
  );

  const recoveryData = {
    userId,
    salt: btoa(String.fromCharCode(...salt)),
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  };

  // Trigger file download
  const blob = new Blob([JSON.stringify(recoveryData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dechat-recovery-kit-${userId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Generates a raw AES-256-GCM room key for message encryption.
 */
export async function generateRoomKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

/**
 * Wraps a room AES key with a member's RSA public key (RSA-OAEP).
 */
export async function wrapRoomKeyForPublicKey(
  roomKey: CryptoKey,
  recipientPublicKey: CryptoKey
): Promise<string> {
  const wrapped = await crypto.subtle.wrapKey(
    "raw",
    roomKey,
    recipientPublicKey,
    { name: "RSA-OAEP" }
  );
  return btoa(String.fromCharCode(...new Uint8Array(wrapped)));
}

/**
 * Unwraps a room AES key using the member's RSA private key.
 */
export async function unwrapRoomKey(
  encryptedRoomKeyBase64: string,
  privateKey: CryptoKey
): Promise<CryptoKey> {
  const wrapped = Uint8Array.from(atob(encryptedRoomKeyBase64), (c) =>
    c.charCodeAt(0)
  );
  return crypto.subtle.unwrapKey(
    "raw",
    wrapped,
    privateKey,
    { name: "RSA-OAEP" },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function saveRoomKey(
  roomId: string,
  roomKey: CryptoKey
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ROOM_KEY_STORE, "readwrite");
    const store = transaction.objectStore(ROOM_KEY_STORE);
    const request = store.put(roomKey, roomId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getRoomKey(roomId: string): Promise<CryptoKey | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ROOM_KEY_STORE, "readonly");
    const store = transaction.objectStore(ROOM_KEY_STORE);
    const request = store.get(roomId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function removeRoomKey(roomId: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ROOM_KEY_STORE, "readwrite");
    const store = transaction.objectStore(ROOM_KEY_STORE);
    const request = store.delete(roomId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Creator flow: generate room key, wrap for self, persist locally.
 */
export async function setupCreatorRoomKey(
  roomId: string,
  userId: string,
  publicKeyBase64: string
): Promise<string> {
  const roomKey = await generateRoomKey();
  const publicKey = await importPublicKey(publicKeyBase64);
  const encryptedRoomKey = await wrapRoomKeyForPublicKey(roomKey, publicKey);
  await saveRoomKey(roomId, roomKey);
  return encryptedRoomKey;
}

/**
 * Member flow: unwrap server-stored key and persist locally.
 */
export async function unlockRoomKeyFromMembership(
  roomId: string,
  userId: string,
  encryptedRoomKey: string
): Promise<CryptoKey> {
  const privateKey = await getPrivateKey(userId);
  if (!privateKey) {
    throw new Error("Private key not found. Restore from your recovery kit.");
  }
  const roomKey = await unwrapRoomKey(encryptedRoomKey, privateKey);
  await saveRoomKey(roomId, roomKey);
  return roomKey;
}

/**
 * Admin approval flow: wrap existing local room key for a joiner.
 * Reads the latest room key from the versioned store (room-key-versions).
 */
export async function wrapRoomKeyForMember(
  roomId: string,
  memberPublicKeyBase64: string
): Promise<string> {
  // Try the latest versioned key first
  const latestVersion = await getLatestRoomKeyVersion(roomId);
  let roomKey: CryptoKey | null = null;
  if (latestVersion !== null) {
    roomKey = await getRoomKeyVersion(roomId, latestVersion);
  }
  // Fall back to legacy room-keys store
  if (!roomKey) {
    roomKey = await getRoomKey(roomId);
  }
  if (!roomKey) {
    throw new Error("Room key not found locally. Re-open the room as admin.");
  }
  const memberPublicKey = await importPublicKey(memberPublicKeyBase64);
  return wrapRoomKeyForPublicKey(roomKey, memberPublicKey);
}

/**
 * Quick existence check — returns true if a private key exists in IndexedDB
 * for the given userId. Does NOT load the full CryptoKey object.
 */
export async function hasPrivateKeyInDB(userId: string): Promise<boolean> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.count(userId);
    request.onsuccess = () => resolve(request.result > 0);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Parses a recovery kit JSON file, derives the AES key from the passphrase,
 * decrypts the private key JWK, imports it as a CryptoKey, and saves it to
 * IndexedDB. Returns the imported CryptoKey on success.
 */
export async function recoverPrivateKeyFromKit(
  recoveryFile: { userId: string; salt: string; iv: string; ciphertext: string },
  passphrase: string
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const salt = new Uint8Array(
    atob(recoveryFile.salt).split("").map((c) => c.charCodeAt(0))
  );
  const iv = new Uint8Array(
    atob(recoveryFile.iv).split("").map((c) => c.charCodeAt(0))
  );
  const ciphertext = new Uint8Array(
    atob(recoveryFile.ciphertext).split("").map((c) => c.charCodeAt(0))
  );

  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext
  );

  const dec = new TextDecoder();
  const jwk = JSON.parse(dec.decode(decryptedBuffer));

  if (!Array.isArray(jwk.key_ops)) {
    jwk.key_ops = ["decrypt", "unwrapKey"];
  } else {
    const ops = new Set<string>(jwk.key_ops);
    ops.add("decrypt");
    ops.add("unwrapKey");
    jwk.key_ops = Array.from(ops);
  }

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt", "unwrapKey"]
  );

  await savePrivateKey(recoveryFile.userId, privateKey);
  return privateKey;
}

export interface EncryptedMessagePayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * Encrypts a plaintext message with the room AES key (AES-256-GCM).
 */
export async function encryptMessage(
  plaintext: string,
  roomKey: CryptoKey
): Promise<EncryptedMessagePayload> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    roomKey,
    enc.encode(plaintext)
  );

  const combined = new Uint8Array(ciphertextBuffer);
  const tagLength = 16;
  const ciphertext = combined.slice(0, combined.length - tagLength);
  const authTag = combined.slice(combined.length - tagLength);

  return {
    ciphertext: btoa(String.fromCharCode(...ciphertext)),
    iv: btoa(String.fromCharCode(...iv)),
    authTag: btoa(String.fromCharCode(...authTag)),
  };
}

/**
 * Decrypts a ciphertext envelope with the room AES key.
 */
export async function decryptMessage(
  payload: EncryptedMessagePayload,
  roomKey: CryptoKey
): Promise<string> {
  const ciphertext = Uint8Array.from(atob(payload.ciphertext), (c) =>
    c.charCodeAt(0)
  );
  const iv = Uint8Array.from(atob(payload.iv), (c) => c.charCodeAt(0));
  const authTag = Uint8Array.from(atob(payload.authTag), (c) =>
    c.charCodeAt(0)
  );

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    roomKey,
    combined
  );

  return new TextDecoder().decode(decrypted);
}

// ---------------------------------------------------------------------------
// Version-aware room key storage (IndexedDB "room-key-versions" store)
// ---------------------------------------------------------------------------

function roomKeyVersionKey(roomId: string, version: number): string {
  return `${roomId}:${version}`;
}

export async function storeRoomKeyVersion(
  roomId: string,
  version: number,
  key: CryptoKey
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROOM_KEY_VERSIONS_STORE, "readwrite");
    const store = tx.objectStore(ROOM_KEY_VERSIONS_STORE);
    const req = store.put(key, roomKeyVersionKey(roomId, version));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getRoomKeyVersion(
  roomId: string,
  version: number
): Promise<CryptoKey | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROOM_KEY_VERSIONS_STORE, "readonly");
    const store = tx.objectStore(ROOM_KEY_VERSIONS_STORE);
    const req = store.get(roomKeyVersionKey(roomId, version));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllRoomKeyVersions(
  roomId: string
): Promise<Map<number, CryptoKey>> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROOM_KEY_VERSIONS_STORE, "readonly");
    const store = tx.objectStore(ROOM_KEY_VERSIONS_STORE);
    const prefix = `${roomId}:`;
    const req = store.openCursor();
    const map = new Map<number, CryptoKey>();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(map);
        return;
      }
      if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) {
        const versionStr = cursor.key.slice(prefix.length);
        const version = parseInt(versionStr, 10);
        if (!Number.isNaN(version)) {
          map.set(version, cursor.value as CryptoKey);
        }
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getLatestRoomKeyVersion(
  roomId: string
): Promise<number | null> {
  const map = await getAllRoomKeyVersions(roomId);
  if (map.size === 0) return null;
  let max = -1;
  for (const v of map.keys()) {
    if (v > max) max = v;
  }
  return max;
}

export async function deleteAllRoomKeyVersions(
  roomId: string
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROOM_KEY_VERSIONS_STORE, "readwrite");
    const store = tx.objectStore(ROOM_KEY_VERSIONS_STORE);
    const prefix = `${roomId}:`;
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) {
        cursor.delete();
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
