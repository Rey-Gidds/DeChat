"use client";

import { useEffect, useState } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { useKeyHealth } from "./provider";

export function UnlockDialog() {
  const { isUnlockOpen, closeUnlock, openRecovery, unlockEncryption } = useKeyHealth();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isUnlockOpen) {
      setPassphrase("");
      setError("");
    }
  }, [isUnlockOpen]);

  if (!isUnlockOpen) return null;

  async function unlock() {
    if (!passphrase) return setError("Enter your encryption passphrase.");
    setLoading(true);
    setError("");
    try {
      await unlockEncryption(passphrase);
    } catch {
      setError("That passphrase could not unlock your keys.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-sm rounded-2xl border border-neutral-700/50 bg-neutral-900 p-6 shadow-2xl">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-neutral-800">
            <Lock className="h-6 w-6 text-neutral-300" />
          </div>
          <h2 className="text-base font-semibold text-white">Unlock encryption</h2>
          <p className="mt-2 text-xs leading-relaxed text-neutral-500">
            Enter your encryption passphrase to load your identity keys.
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
            <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Input */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] uppercase tracking-wider text-neutral-500">
            Encryption passphrase
          </label>
          <input
            autoFocus
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void unlock()}
            placeholder="Enter your passphrase"
            className="w-full rounded-xl border border-neutral-700 bg-neutral-800 px-3 py-3 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-neutral-500 transition-colors"
          />
        </div>

        {/* Unlock button */}
        <button
          onClick={() => void unlock()}
          disabled={loading}
          className="mt-4 w-full rounded-xl bg-white py-3 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:opacity-40"
        >
          {loading ? "Unlocking..." : "Unlock app"}
        </button>

        {/* Forgot passphrase link */}
        <button
          onClick={() => { closeUnlock(); openRecovery(); }}
          className="mt-4 w-full text-xs text-neutral-600 hover:text-neutral-300 transition underline underline-offset-4"
        >
          Forgot passphrase?
        </button>
      </div>
    </div>
  );
}
