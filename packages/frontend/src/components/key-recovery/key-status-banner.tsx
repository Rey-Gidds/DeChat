"use client";

import React, { useEffect, useState } from "react";
import { useKeyHealth } from "./provider";
import { useSession } from "@/lib/auth-client";
import { Lock, X } from "lucide-react";

const STORAGE_KEY = "dechat_key_banner_dismissed";

export function KeyStatusBanner() {
  const { data: session } = useSession();
  const { state, hasPrivateKey, keyCheckLoading, openUnlock } = useKeyHealth();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(sessionStorage.getItem(STORAGE_KEY) === "true");
  }, []);

  const handleDismiss = () => {
    sessionStorage.setItem(STORAGE_KEY, "true");
    setDismissed(true);
  };

  const show =
    session?.user &&
    state === "locked" &&
    !keyCheckLoading &&
    !hasPrivateKey &&
    !dismissed;

  if (!show) return null;

  return (
    <div className="border-b border-neutral-800/60 bg-neutral-900/80 px-4 py-2.5 backdrop-blur-sm">
      <div className="mx-auto max-w-6xl flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm text-neutral-400 min-w-0">
          <Lock size={13} className="shrink-0 text-neutral-500" />
          <span className="truncate text-xs">
            Your encryption keys are locked on this device.
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={openUnlock}
            className="text-[11px] font-semibold uppercase tracking-wider text-white underline underline-offset-4 transition hover:text-neutral-300 whitespace-nowrap"
          >
            Unlock
          </button>
          <button
            onClick={handleDismiss}
            className="flex h-5 w-5 items-center justify-center rounded-full text-neutral-600 transition hover:bg-neutral-800 hover:text-neutral-300"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
