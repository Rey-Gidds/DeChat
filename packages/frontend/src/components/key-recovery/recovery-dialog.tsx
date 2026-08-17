"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Copy, KeyRound, Lock, ShieldAlert, X } from "lucide-react";
import { useKeyHealth } from "./provider";

type Context = "room" | "sign-in" | "banner" | "profile";
interface Props { open: boolean; onClose: () => void; context?: Context; }

export function RecoveryDialog({ open, onClose }: Props) {
  const { recoverPassphrase, unlockEncryption } = useKeyHealth();
  const [recoveryKey, setRecoveryKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [enteredPassphrase, setEnteredPassphrase] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setRecoveryKey("");
      setPassphrase("");
      setEnteredPassphrase("");
      setRevealed(false);
      setCopied(false);
      setError("");
    }
  }, [open]);

  if (!open) return null;

  async function recover() {
    if (!recoveryKey.trim()) return setError("Enter your saved recovery key.");
    setLoading(true);
    setError("");
    try {
      setPassphrase(await recoverPassphrase(recoveryKey));
      setRevealed(true);
    } catch {
      setError("That recovery key could not recover your passphrase.");
    } finally {
      setLoading(false);
    }
  }

  async function unlock() {
    setLoading(true);
    setError("");
    if (enteredPassphrase !== passphrase) {
      setLoading(false);
      return setError("Enter the recovered passphrase exactly as shown.");
    }
    try {
      await unlockEncryption(passphrase);
      onClose();
    } catch {
      setError("The recovered passphrase could not unlock your keys.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(passphrase).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-sm rounded-2xl border border-neutral-700/50 bg-neutral-900 p-6 shadow-2xl">
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-full text-neutral-600 transition hover:bg-neutral-800 hover:text-white"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-neutral-800">
            <KeyRound className="h-6 w-6 text-neutral-300" />
          </div>
          <h2 className="text-base font-semibold text-white">Recover passphrase</h2>
          <p className="mt-2 text-xs leading-relaxed text-neutral-500">
            Use the recovery key you saved during encryption setup.
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
            <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!revealed ? (
          <>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] uppercase tracking-wider text-neutral-500">Recovery key</label>
              <textarea
                autoFocus
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
                className="min-h-24 w-full resize-none rounded-xl border border-neutral-700 bg-neutral-800 p-3 text-xs text-white outline-none placeholder:text-neutral-600 focus:border-neutral-500 transition-colors"
                placeholder="Paste your recovery key here..."
              />
            </div>
            <button
              onClick={() => void recover()}
              disabled={loading}
              className="mt-4 w-full rounded-xl bg-white py-3 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:opacity-40"
            >
              {loading ? "Recovering..." : "Recover passphrase"}
            </button>
          </>
        ) : (
          <>
            {/* Revealed passphrase box */}
            <div className="rounded-xl border border-neutral-700 bg-neutral-800 p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] uppercase tracking-wider text-neutral-500">Your passphrase</p>
                <button
                  onClick={() => void handleCopy()}
                  className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-neutral-400 hover:text-white transition"
                >
                  <Copy className="h-3 w-3" />
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <code className="break-all text-sm text-white">{passphrase}</code>
              {revealed && (
                <div className="mt-3 flex items-center gap-1.5 text-xs text-neutral-400">
                  <CheckCircle2 className="h-3.5 w-3.5 text-neutral-400" />
                  Recovery verified
                </div>
              )}
            </div>

            <p className="mt-4 text-xs text-neutral-500">Enter it below to unlock your identity keys.</p>

            <div className="mt-3 flex flex-col gap-1.5">
              <label className="text-[10px] uppercase tracking-wider text-neutral-500">Passphrase</label>
              <input
                autoFocus
                type="password"
                value={enteredPassphrase}
                onChange={(e) => setEnteredPassphrase(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void unlock()}
                placeholder="Re-enter passphrase to unlock"
                className="w-full rounded-xl border border-neutral-700 bg-neutral-800 px-3 py-3 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-neutral-500 transition-colors"
              />
            </div>

            <button
              onClick={() => void unlock()}
              disabled={loading}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-white py-3 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:opacity-40"
            >
              <Lock className="h-4 w-4" />
              {loading ? "Unlocking..." : "Unlock identity"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
