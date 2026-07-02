"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, FileJson, Lock, ShieldAlert, Upload, X } from "lucide-react";
import { useKeyHealth } from "./provider";
import { recoverPrivateKeyFromKit } from "@/lib/crypto";

type Context = "room" | "sign-in" | "banner" | "profile";

interface Props {
  open: boolean;
  onClose: () => void;
  context?: Context;
}

const CONTEXT_MESSAGES: Record<Context, { header: string; body: string }> = {
  "sign-in": {
    header: "Welcome Back",
    body: "Your local encryption key was not found. Restore your identity to access your rooms.",
  },
  room: {
    header: "Room Access Required",
    body: "You need your private key to decrypt messages in this room.",
  },
  banner: {
    header: "Keys Missing",
    body: "Your identity keys are missing. Restore now to send and decrypt messages.",
  },
  profile: {
    header: "Identity Restore",
    body: "Restore your private key from a recovery kit backup.",
  },
};

export function RecoveryDialog({ open, onClose, context = "banner" }: Props) {
  const { refreshKeyStatus } = useKeyHealth();
  const [recoveryFile, setRecoveryFile] = useState<any>(null);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [state, setState] = useState<"idle" | "file_selected" | "restoring" | "success">("idle");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setRecoveryFile(null);
      setPassphrase("");
      setError("");
      setState("idle");
    }
  }, [open]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        if (!json.userId || !json.salt || !json.iv || !json.ciphertext) {
          setError("Invalid recovery kit file structure.");
          return;
        }
        setRecoveryFile(json);
        setError("");
        setState("file_selected");
      } catch {
        setError("Invalid recovery kit file structure.");
      }
    };
    reader.readAsText(file);
  }, []);

  const handleRestore = useCallback(async () => {
    if (!recoveryFile || !passphrase) {
      setError("Please load a valid recovery file and enter the passphrase.");
      return;
    }
    setError("");
    setState("restoring");

    try {
      await recoverPrivateKeyFromKit(recoveryFile, passphrase);
      setState("success");
      await refreshKeyStatus();
      setTimeout(() => onClose(), 1500);
    } catch (err: any) {
      setError("Decryption failed. Please verify the passphrase.");
      setState("file_selected");
    }
  }, [recoveryFile, passphrase, refreshKeyStatus, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const msg = CONTEXT_MESSAGES[context];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recovery-header"
    >
      {/* overlay */}
      <div
        className="absolute inset-0 bg-black/80"
        onClick={onClose}
      />

      {/* container */}
      <div className="relative max-w-md w-full border border-neutral-800 bg-neutral-900 p-6 sm:p-8 flex flex-col gap-6 max-h-[90vh] overflow-y-auto">
        {/* close */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-neutral-500 hover:text-white transition"
          aria-label="Close"
        >
          <X size={18} />
        </button>

        {/* header */}
        <div className="text-center">
          <h2 id="recovery-header" className="text-xl font-bold text-white uppercase tracking-[0.15em]">
            {msg.header}
          </h2>
          <p className="text-neutral-500 text-xs mt-2 uppercase tracking-wider">{msg.body}</p>
        </div>

        {/* error */}
        {error && (
          <div
            className="p-3.5 bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2"
            role="alert"
          >
            <ShieldAlert className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* success */}
        {state === "success" ? (
          <div className="text-center py-6 flex flex-col items-center gap-4">
            <CheckCircle2 className="w-12 h-12 text-neutral-400" />
            <h3 className="text-lg font-bold text-white uppercase tracking-[0.1em]">Identity Restored!</h3>
            <p className="text-neutral-500 text-xs uppercase tracking-wider">Redirecting...</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* file upload */}
            <div className="flex flex-col gap-1.5">
              <label className="text-neutral-400 text-xs font-semibold uppercase tracking-wider">
                Recovery JSON File
              </label>
              <label className="flex flex-col items-center justify-center border border-neutral-800 hover:border-neutral-600 p-6 cursor-pointer bg-black transition-colors gap-2 text-neutral-500">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileChange}
                  className="hidden"
                />
                {recoveryFile ? (
                  <>
                    <FileJson className="w-8 h-8 text-neutral-400" />
                    <span className="text-xs text-neutral-400 font-medium">Loaded backup file</span>
                  </>
                ) : (
                  <>
                    <Upload className="w-8 h-8 text-neutral-600" />
                    <span className="text-xs uppercase tracking-wider">Upload dechat-recovery-kit-*.json</span>
                  </>
                )}
              </label>
            </div>

            {/* passphrase */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="recovery-passphrase"
                className="text-neutral-400 text-xs font-semibold uppercase tracking-wider"
              >
                Encryption Passphrase
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-600" />
                <input
                  id="recovery-passphrase"
                  type="password"
                  autoComplete="off"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Passphrase used during backup"
                  className="w-full bg-black border border-neutral-800 py-3 pl-11 pr-4 text-white text-sm outline-none focus:border-neutral-600 transition-colors"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && state === "file_selected") handleRestore();
                  }}
                />
              </div>
            </div>

            {/* actions */}
            <div className="flex gap-3 mt-4">
              <button
                onClick={onClose}
                className="flex-1 bg-neutral-800 border border-neutral-700 text-neutral-400 py-3 hover:bg-neutral-700 transition-colors text-xs font-semibold uppercase tracking-wider"
              >
                Cancel
              </button>
              <button
                onClick={handleRestore}
                disabled={state !== "file_selected" || !passphrase}
                className="flex-1 bg-white text-black py-3 hover:bg-neutral-200 transition-colors text-xs font-bold uppercase tracking-wider disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {state === "restoring" ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-black border-t-transparent animate-spin" />
                    Restoring...
                  </span>
                ) : (
                  "Restore"
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
