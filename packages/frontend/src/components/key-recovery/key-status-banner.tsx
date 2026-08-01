"use client";

import React, { useEffect, useState } from "react";
import { useKeyHealth } from "./provider";
import { useSession } from "@/lib/auth-client";
import { X } from "lucide-react";

const STORAGE_KEY = "dechat_key_banner_dismissed";

export function KeyStatusBanner() {
  const { data: session } = useSession();
  const { hasPrivateKey, keyCheckLoading, openRecovery } = useKeyHealth();
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissed state on mount — sessionStorage clears on tab close
  useEffect(() => {
    setDismissed(sessionStorage.getItem(STORAGE_KEY) === "true");
  }, []);

  const handleDismiss = () => {
    sessionStorage.setItem(STORAGE_KEY, "true");
    setDismissed(true);
  };

  const show =
    session?.user &&
    (session.user as any).encryptionEnabled &&
    !keyCheckLoading &&
    !hasPrivateKey &&
    !dismissed;

  if (!show) return null;

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-3">
      <div className="mx-auto max-w-[480px] flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm text-amber-200 min-w-0">
          <span className="shrink-0">⚠</span>
          <span className="truncate">
            Encryption keys missing — your messages can't be decrypted.
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={openRecovery}
            className="text-xs font-bold uppercase tracking-wider text-amber-200 hover:text-white underline underline-offset-4 transition whitespace-nowrap"
          >
            Restore your identity →
          </button>
          <button
            onClick={handleDismiss}
            className="text-amber-400/60 hover:text-amber-200 transition"
            aria-label="Dismiss"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
