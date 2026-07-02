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
      {error && (
        <div className="p-3.5 bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-neutral-800 border border-neutral-700 p-4 text-xs text-neutral-400 leading-relaxed uppercase tracking-wider">
        If you clear browser data, your local private key will be lost. Protect your identity by
        downloading an encrypted <strong>Recovery Kit</strong>.
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="rd-passphrase"
          className="text-neutral-400 text-xs font-semibold uppercase tracking-wider"
        >
          Passphrase for Key Encryption
        </label>
        <div className="relative">
          <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-600" />
          <input
            id="rd-passphrase"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Enter a strong passphrase (min 8 chars)"
            className="w-full bg-black border border-neutral-800 py-3 pl-11 pr-4 text-white text-sm outline-none focus:border-neutral-600 transition-colors"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="rd-confirm"
          className="text-neutral-400 text-xs font-semibold uppercase tracking-wider"
        >
          Confirm Passphrase
        </label>
        <div className="relative">
          <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-600" />
          <input
            id="rd-confirm"
            type="password"
            autoComplete="off"
            value={confirmPassphrase}
            onChange={(e) => setConfirmPassphrase(e.target.value)}
            placeholder="Re-enter passphrase"
            className="w-full bg-black border border-neutral-800 py-3 pl-11 pr-4 text-white text-sm outline-none focus:border-neutral-600 transition-colors"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleDownload();
            }}
          />
        </div>
      </div>

      <button
        onClick={handleDownload}
        disabled={loading}
        className="w-full bg-white text-black font-semibold py-3 mt-2 hover:bg-neutral-200 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed uppercase tracking-wider text-sm"
      >
        {loading ? (
          <span className="flex items-center gap-2">
            <span className="inline-block w-4 h-4 border-2 border-black border-t-transparent animate-spin" />
            Encrypting...
          </span>
        ) : (
          <>
            <Download className="w-4 h-4" />
            <span>Download Recovery Kit</span>
          </>
        )}
      </button>
    </div>
  );
}
