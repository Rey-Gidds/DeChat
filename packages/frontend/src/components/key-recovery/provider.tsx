"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useSession } from "@/lib/auth-client";
import { hasPrivateKeyInDB } from "@/lib/crypto";

interface KeyHealthContextValue {
  hasPrivateKey: boolean;
  keyCheckLoading: boolean;
  openRecovery: () => void;
  closeRecovery: () => void;
  isRecoveryOpen: boolean;
  refreshKeyStatus: () => Promise<void>;
}

const KeyHealthContext = createContext<KeyHealthContextValue | null>(null);

export function KeyHealthProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const [hasPrivateKey, setHasPrivateKey] = useState(false);
  const [keyCheckLoading, setKeyCheckLoading] = useState(true);
  const [isRecoveryOpen, setIsRecoveryOpen] = useState(false);

  const checkKey = useCallback(async () => {
    if (!session?.user?.id) {
      setHasPrivateKey(false);
      setKeyCheckLoading(false);
      return;
    }
    setKeyCheckLoading(true);
    try {
      const exists = await hasPrivateKeyInDB(session.user.id);
      setHasPrivateKey(exists);
    } catch {
      setHasPrivateKey(false);
    } finally {
      setKeyCheckLoading(false);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    checkKey();
  }, [checkKey]);

  const openRecovery = useCallback(() => setIsRecoveryOpen(true), []);
  const closeRecovery = useCallback(() => setIsRecoveryOpen(false), []);

  const refreshKeyStatus = useCallback(async () => {
    if (!session?.user?.id) return;
    try {
      const exists = await hasPrivateKeyInDB(session.user.id);
      setHasPrivateKey(exists);
    } catch {
      setHasPrivateKey(false);
    }
  }, [session?.user?.id]);

  return (
    <KeyHealthContext.Provider
      value={{
        hasPrivateKey,
        keyCheckLoading,
        openRecovery,
        closeRecovery,
        isRecoveryOpen,
        refreshKeyStatus,
      }}
    >
      {children}
    </KeyHealthContext.Provider>
  );
}

export function useKeyHealth(): KeyHealthContextValue {
  const ctx = useContext(KeyHealthContext);
  if (!ctx) {
    throw new Error("useKeyHealth must be used within a KeyHealthProvider");
  }
  return ctx;
}
