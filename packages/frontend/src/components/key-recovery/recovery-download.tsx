"use client";

import React, { useState } from "react";
import { downloadRecoveryKit } from "@/lib/crypto";
import { Download, Lock, ShieldAlert } from "lucide-react";

interface Props {
  userId: string;
  privateKey: CryptoKey;
  onComplete?: () => void;
}

export function RecoveryDownload({ userId, privateKey, onComplete }: Props) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleDownload = async () => {
    if (!passphrase || !confirmPassphrase) {
      setError("Please enter and confirm your passphrase.");
      return;
    }
    if (passphrase.length < 8) {
      setError("Passphrase must be at least 8 characters.");
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError("Passphrases do not match.");
      return;
    }
    setError("");
    setLoading(true);

    try {
      await downloadRecoveryKit(userId, privateKey, passphrase);
      setPassphrase("");
      setConfirmPassphrase("");
      onComplete?.();
    } catch (err: any) {
      setError("Failed to encrypt recovery kit: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Info banner */}
      <div className="rounded-xl border border-neutral-700 bg-neutral-800/60 p-4 text-xs leading-relaxed text-neutral-400">
        If you clear browser data, your local private key will be lost. Protect your identity by
        downloading an encrypted <strong className="text-neutral-200">Recovery Kit</strong>.
      </div>

      {/* Passphrase input */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="rd-passphrase" className="text-[10px] uppercase tracking-wider text-neutral-500">
          Passphrase for key encryption
        </label>
        <div className="relative">
          <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-600" />
          <input
            id="rd-passphrase"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Min 8 characters"
            className="w-full rounded-xl border border-neutral-700 bg-neutral-800 py-3 pl-11 pr-4 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-neutral-500 transition-colors"
          />
        </div>
      </div>

      {/* Confirm passphrase input */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="rd-confirm" className="text-[10px] uppercase tracking-wider text-neutral-500">
          Confirm passphrase
        </label>
        <div className="relative">
          <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-600" />
          <input
            id="rd-confirm"
            type="password"
            autoComplete="off"
            value={confirmPassphrase}
            onChange={(e) => setConfirmPassphrase(e.target.value)}
            placeholder="Re-enter passphrase"
            onKeyDown={(e) => { if (e.key === "Enter") void handleDownload(); }}
            className="w-full rounded-xl border border-neutral-700 bg-neutral-800 py-3 pl-11 pr-4 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-neutral-500 transition-colors"
          />
        </div>
      </div>

      {/* Download button */}
      <button
        onClick={() => void handleDownload()}
        disabled={loading}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-white py-3 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {loading ? (
          <>
            <span className="inline-block h-4 w-4 rounded-full border-2 border-black border-t-transparent animate-spin" />
            Encrypting...
          </>
        ) : (
          <>
            <Download className="h-4 w-4" />
            Download Recovery Kit
          </>
        )}
      </button>
    </div>
  );
}
