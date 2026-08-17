"use client";

import { useState } from "react";
import { CheckCircle2, Download, KeyRound, ShieldAlert } from "lucide-react";
import { useKeyHealth } from "./provider";

export function KeygenDialog({ onComplete }: { userId: string; onComplete: () => void }) {
  const { setupEncryption } = useKeyHealth();
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const score = [
    passphrase.length >= 12,
    /[a-z]/.test(passphrase),
    /[A-Z]/.test(passphrase),
    /\d/.test(passphrase),
    /[^A-Za-z0-9]/.test(passphrase),
  ].filter(Boolean).length;

  const strength = score >= 5 ? "Strong" : score >= 3 ? "Medium" : "Weak";
  const strengthColor =
    strength === "Strong" ? "bg-white" : strength === "Medium" ? "bg-neutral-400" : "bg-neutral-700";
  const strengthTextColor =
    strength === "Strong" ? "text-white" : strength === "Medium" ? "text-neutral-300" : "text-neutral-500";

  async function setup() {
    if (passphrase.length < 12) return setError("Use at least 12 characters.");
    if (passphrase !== confirmation) return setError("Passphrases do not match.");
    setLoading(true);
    setError("");
    try {
      setRecoveryKey(await setupEncryption(passphrase));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Setup failed.");
    } finally {
      setLoading(false);
    }
  }

  function download() {
    const blob = new Blob([recoveryKey], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "dechat-recovery-key.txt";
    anchor.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-md rounded-2xl border border-neutral-700/50 bg-neutral-900 p-6 shadow-2xl">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-neutral-800">
            <KeyRound className="h-6 w-6 text-neutral-300" />
          </div>
          <h2 className="text-base font-semibold text-white">Protect your identity</h2>
          <p className="mt-2 text-xs leading-relaxed text-neutral-500">
            This encryption passphrase unlocks your keys on every device. Keep it safe.
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
            <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!recoveryKey ? (
          <div className="space-y-4">
            {/* Passphrase input */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] uppercase tracking-wider text-neutral-500">
                Encryption passphrase
              </label>
              <input
                autoFocus
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Min 12 characters"
                className="w-full rounded-xl border border-neutral-700 bg-neutral-800 px-3 py-3 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-neutral-500 transition-colors"
              />
            </div>

            {/* Strength meter */}
            {passphrase && (
              <div>
                <div className="mb-1.5 flex justify-between text-[10px] uppercase tracking-wider text-neutral-600">
                  <span>Strength</span>
                  <span className={strengthTextColor}>{strength}</span>
                </div>
                <div className="h-1 rounded-full bg-neutral-800">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${strengthColor}`}
                    style={{ width: `${score * 20}%` }}
                  />
                </div>
              </div>
            )}

            {/* Confirm input */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] uppercase tracking-wider text-neutral-500">
                Confirm passphrase
              </label>
              <input
                type="password"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void setup()}
                placeholder="Re-enter passphrase"
                className="w-full rounded-xl border border-neutral-700 bg-neutral-800 px-3 py-3 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-neutral-500 transition-colors"
              />
            </div>

            <button
              onClick={() => void setup()}
              disabled={loading}
              className="w-full rounded-xl bg-white py-3 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:opacity-40"
            >
              {loading ? "Securing keys..." : "Create passphrase"}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Warning box */}
            <div className="rounded-xl border border-neutral-700 bg-neutral-800/60 p-4 text-xs leading-relaxed text-neutral-300">
              <p className="font-medium text-white mb-1">Save your recovery key</p>
              It&apos;s the only way to recover your passphrase if you forget it.
            </div>

            <button
              onClick={download}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-white py-3 text-sm font-semibold text-black transition hover:bg-neutral-200"
            >
              <Download className="h-4 w-4" />
              Download recovery key
            </button>

            <label className="flex items-center gap-2.5 cursor-pointer select-none text-sm text-neutral-400 hover:text-white transition">
              <input
                type="checkbox"
                checked={saved}
                onChange={(e) => setSaved(e.target.checked)}
                className="h-4 w-4 accent-white rounded"
              />
              I saved my recovery key
            </label>

            <button
              onClick={onComplete}
              disabled={!saved}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-neutral-700 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-30"
            >
              <CheckCircle2 className="h-4 w-4" />
              Enter application
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
