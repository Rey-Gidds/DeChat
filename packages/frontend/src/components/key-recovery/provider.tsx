"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useSession } from "@/lib/auth-client";
import {
  encryptPassphraseRecoveryEnvelope,
  encryptUserKeyPair,
  exportPublicKey,
  exportRecoveryKey,
  generateRecoveryKey,
  generateUserKeyPair,
  getUserKeyPair,
  hasPrivateKeyInDB,
  savePrivateKey,
  saveUserKeyPair,
  decryptUserKeyPair,
  importRecoveryKey,
  decryptPassphraseRecoveryEnvelope,
  importPublicKey,
  getPrivateKey,
  type RecoveryKeyEnvelope,
} from "@/lib/crypto";
import { createKeyEnvelope, fetchKeyEnvelope, type KeyEnvelopeRecord } from "@/lib/key-envelope-api";

export type KeyState = "checking" | "setup-required" | "locked" | "unlocked" | "recovering" | "error";

interface KeyHealthContextValue {
  state: KeyState;
  hasPrivateKey: boolean;
  keyCheckLoading: boolean;
  envelope: KeyEnvelopeRecord | null;
  error: string;
  openRecovery: () => void;
  closeRecovery: () => void;
  openUnlock: () => void;
  closeUnlock: () => void;
  isRecoveryOpen: boolean;
  isUnlockOpen: boolean;
  refreshKeyStatus: () => Promise<void>;
  setupEncryption: (passphrase: string) => Promise<string>;
  unlockEncryption: (passphrase: string) => Promise<void>;
  recoverPassphrase: (recoveryKey: string) => Promise<string>;
}

const KeyHealthContext = createContext<KeyHealthContextValue | null>(null);

export function KeyHealthProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const [state, setState] = useState<KeyState>("checking");
  const [hasPrivateKey, setHasPrivateKey] = useState(false);
  const [keyCheckLoading, setKeyCheckLoading] = useState(true);
  const [envelope, setEnvelope] = useState<KeyEnvelopeRecord | null>(null);
  const [error, setError] = useState("");
  const [isRecoveryOpen, setIsRecoveryOpen] = useState(false);
  const [isUnlockOpen, setIsUnlockOpen] = useState(false);

  const refreshKeyStatus = useCallback(async () => {
    if (!session?.user?.id) {
      setState("checking");
      setHasPrivateKey(false);
      setKeyCheckLoading(false);
      return;
    }
    setKeyCheckLoading(true);
    setError("");
    try {
      const [record, localPair, legacyKey] = await Promise.all([
        fetchKeyEnvelope(),
        getUserKeyPair(session.user.id),
        hasPrivateKeyInDB(session.user.id),
      ]);
      setEnvelope(record);
      const local = Boolean(localPair || legacyKey);
      setHasPrivateKey(local);
      const nextState = record.configured ? (local ? "unlocked" : "locked") : "setup-required";
      setState(nextState);
      setIsUnlockOpen(nextState === "locked");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to check encryption status");
      setState("error");
    } finally {
      setKeyCheckLoading(false);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    void refreshKeyStatus();
  }, [refreshKeyStatus]);

  const setupEncryption = useCallback(async (passphrase: string) => {
    if (!session?.user?.id) throw new Error("You must be signed in");
    const legacyPrivateKey = await getPrivateKey(session.user.id);
    const legacyPublicKey = (session.user as any).publicKey as string | undefined;
    const keyPair = legacyPrivateKey
      ? { publicKey: legacyPublicKey ? await importPublicKey(legacyPublicKey) : (await generateUserKeyPair()).publicKey, privateKey: legacyPrivateKey }
      : await generateUserKeyPair();
    const recoveryKey = await generateRecoveryKey();
    const [publicKey, keyEnvelope, recoveryEnvelope] = await Promise.all([
      exportPublicKey(keyPair.publicKey),
      encryptUserKeyPair(keyPair, passphrase),
      encryptPassphraseRecoveryEnvelope(passphrase, recoveryKey),
    ]);
    const recoveryKeyText = await exportRecoveryKey(recoveryKey);
    await createKeyEnvelope({ publicKey, keyEnvelope, recoveryEnvelope });
    await saveUserKeyPair(session.user.id, { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey });
    await savePrivateKey(session.user.id, keyPair.privateKey);
    setHasPrivateKey(true);
    setEnvelope({ configured: true, version: 1, updatedAt: new Date().toISOString(), keyEnvelope, recoveryEnvelope });
    setState("unlocked");
    return recoveryKeyText;
  }, [session?.user?.id]);

  const unlockEncryption = useCallback(async (passphrase: string) => {
    if (!session?.user?.id || !envelope?.keyEnvelope) throw new Error("Encryption is not configured");
    const pair = await decryptUserKeyPair(envelope.keyEnvelope, passphrase);
    await saveUserKeyPair(session.user.id, pair);
    await savePrivateKey(session.user.id, pair.privateKey);
    setHasPrivateKey(true);
    setState("unlocked");
    setIsUnlockOpen(false);
  }, [envelope, session?.user?.id]);

  const recoverPassphrase = useCallback(async (recoveryKeyText: string) => {
    if (!envelope?.recoveryEnvelope) throw new Error("Recovery is not configured");
    const key = await importRecoveryKey(recoveryKeyText.trim());
    const passphrase = await decryptPassphraseRecoveryEnvelope(envelope.recoveryEnvelope as RecoveryKeyEnvelope, key);
    setState("recovering");
    return passphrase;
  }, [envelope]);

  return (
    <KeyHealthContext.Provider value={{
      state,
      hasPrivateKey,
      keyCheckLoading,
      envelope,
      error,
      openRecovery: () => { setIsRecoveryOpen(true); setState("recovering"); },
      closeRecovery: () => { setIsRecoveryOpen(false); void refreshKeyStatus(); },
      openUnlock: () => setIsUnlockOpen(true),
      closeUnlock: () => setIsUnlockOpen(false),
      isRecoveryOpen,
      isUnlockOpen,
      refreshKeyStatus,
      setupEncryption,
      unlockEncryption,
      recoverPassphrase,
    }}>
      {children}
    </KeyHealthContext.Provider>
  );
}

export function useKeyHealth(): KeyHealthContextValue {
  const context = useContext(KeyHealthContext);
  if (!context) throw new Error("useKeyHealth must be used within a KeyHealthProvider");
  return context;
}
