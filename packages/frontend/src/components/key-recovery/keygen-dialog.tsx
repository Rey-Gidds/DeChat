"use client";

import React, { useState, useEffect } from "react";
import { Lock, ShieldAlert, KeyRound, Download, CheckCircle2 } from "lucide-react";
import { generateUserKeyPair, exportPublicKey, savePrivateKey, downloadRecoveryKit } from "@/lib/crypto";

interface KeygenDialogProps {
  userId: string;
  onComplete: () => void;
}

type Step = 1 | 2 | 3; // 1 = Passcode, 2 = Generation & Download, 3 = Complete

export function KeygenDialog({ userId, onComplete }: KeygenDialogProps) {
  const [step, setStep] = useState<Step>(1);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [generatedKey, setGeneratedKey] = useState<CryptoKey | null>(null);

  // Passcode strength logic
  const getPasscodeStrength = (pass: string) => {
    if (!pass) return { score: 0, label: "None", color: "bg-neutral-800" };
    let score = 0;
    if (pass.length >= 8) score += 1;
    if (/[A-Z]/.test(pass)) score += 1;
    if (/[a-z]/.test(pass)) score += 1;
    if (/[0-9]/.test(pass)) score += 1;
    if (/[^A-Za-z0-9]/.test(pass)) score += 1;

    if (score <= 2) return { score, label: "Weak", color: "bg-red-500" };
    if (score <= 4) return { score, label: "Medium", color: "bg-amber-500" };
    return { score, label: "Strong", color: "bg-green-500" };
  };

  const strength = getPasscodeStrength(passphrase);

  const handleNextStep = () => {
    if (!passphrase || !confirmPassphrase) {
      setError("Please fill out both passcode fields.");
      return;
    }
    if (passphrase.length < 8) {
      setError("Passcode must be at least 8 characters.");
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError("Passcodes do not match.");
      return;
    }
    setError("");
    setStep(2);
  };

  // Generate E2EE keys on step 2 load
  useEffect(() => {
    if (step === 2) {
      const runKeyGen = async () => {
        setLoading(true);
        try {
          // 1. Generate client-side keypair
          const keyPair = await generateUserKeyPair();
          const pubKeyBase64 = await exportPublicKey(keyPair.publicKey);

          // 2. Register user public key and set encryptionEnabled to true
          const res = await fetch("/api/me/public-key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ publicKey: pubKeyBase64 }),
          });

          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "Failed to update public key on the server.");
          }

          // 3. Save Private Key to client IndexedDB
          await savePrivateKey(userId, keyPair.privateKey);
          setGeneratedKey(keyPair.privateKey);
        } catch (err: any) {
          setError(err.message || "Key generation failed.");
          setStep(1);
        } finally {
          setLoading(false);
        }
      };
      runKeyGen();
    }
  }, [step, userId]);

  const handleDownloadAndFinish = async () => {
    if (!generatedKey) return;
    setError("");
    try {
      await downloadRecoveryKit(userId, generatedKey, passphrase);
      setDownloaded(true);
      setStep(3);
    } catch (err: any) {
      setError("Failed to download recovery kit: " + err.message);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="keygen-header"
    >
      {/* Absolute overlay preventing user interaction */}
      <div className="absolute inset-0 bg-black/90 backdrop-blur-md" />

      {/* Container */}
      <div className="relative max-w-md w-full border border-neutral-800 bg-neutral-950 p-6 sm:p-8 flex flex-col gap-6 max-h-[90vh] overflow-y-auto z-10 shadow-2xl">
        {/* Header */}
        <div className="text-center">
          <div className="inline-flex p-3 bg-neutral-900 border border-neutral-800 rounded-full mb-3">
            <KeyRound className="w-6 h-6 text-white" />
          </div>
          <h2 id="keygen-header" className="text-xl font-bold text-white uppercase tracking-[0.15em]">
            Enable End-to-End Encryption
          </h2>
          <p className="text-neutral-500 text-xs mt-2 uppercase tracking-wider">
            Secure your chats and protect your privacy
          </p>
        </div>

        {/* Error alert */}
        {error && (
          <div className="p-3.5 bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2" role="alert">
            <ShieldAlert className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Step 1: Create Passcode */}
        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div className="bg-neutral-900 border border-neutral-800 p-4 text-xs text-neutral-400 leading-relaxed uppercase tracking-wider">
              Create a passcode to encrypt your Recovery Kit. You will need this passcode to restore your account on a new device.
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="keygen-passphrase" className="text-neutral-400 text-xs font-semibold uppercase tracking-wider">
                Passcode
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-600" />
                <input
                  id="keygen-passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter passcode (min 8 characters)"
                  className="w-full bg-black border border-neutral-800 py-3 pl-11 pr-4 text-white text-sm outline-none focus:border-neutral-600 transition-colors"
                />
              </div>
            </div>

            {/* Strength indicator */}
            {passphrase.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-[10px] uppercase tracking-wider">
                  <span className="text-neutral-500">Passcode Strength</span>
                  <span className={strength.label === "Strong" ? "text-green-400 font-bold" : strength.label === "Medium" ? "text-amber-400 font-bold" : "text-red-400 font-bold"}>
                    {strength.label}
                  </span>
                </div>
                <div className="h-1.5 w-full bg-neutral-900 border border-neutral-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${strength.color}`}
                    style={{ width: `${(strength.score / 5) * 100}%` }}
                  />
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="keygen-confirm" className="text-neutral-400 text-xs font-semibold uppercase tracking-wider">
                Confirm Passcode
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-600" />
                <input
                  id="keygen-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  placeholder="Re-enter passcode"
                  className="w-full bg-black border border-neutral-800 py-3 pl-11 pr-4 text-white text-sm outline-none focus:border-neutral-600 transition-colors"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleNextStep();
                  }}
                />
              </div>
            </div>

            <button
              onClick={handleNextStep}
              className="w-full bg-white text-black font-semibold py-3 mt-4 hover:bg-neutral-200 transition-colors flex items-center justify-center gap-2 uppercase tracking-wider text-sm"
            >
              Continue
            </button>
          </div>
        )}

        {/* Step 2: Keygen and Recovery Kit Download */}
        {step === 2 && (
          <div className="text-center py-4 flex flex-col items-center gap-6">
            {loading ? (
              <div className="flex flex-col items-center gap-4">
                <div className="relative w-12 h-12 flex items-center justify-center">
                  <div className="absolute inset-0 border-2 border-neutral-800" />
                  <div className="absolute inset-0 border-2 border-white border-t-transparent animate-spin" />
                </div>
                <h3 className="text-sm font-bold text-white uppercase tracking-[0.1em]">Generating Cryptographic Keys</h3>
                <p className="text-neutral-500 text-[10px] uppercase tracking-wider max-w-xs leading-relaxed">
                  Creating secure RSA-OAEP 2048-bit E2EE keys on your device.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4 w-full">
                <div className="bg-neutral-900 border border-neutral-800 p-4 text-xs text-neutral-400 leading-relaxed uppercase tracking-wider text-left">
                  Your cryptographic keys have been generated successfully! Download your Recovery Kit to complete the setup.
                </div>

                <button
                  onClick={handleDownloadAndFinish}
                  disabled={!generatedKey}
                  className="w-full bg-white text-black font-semibold py-3 hover:bg-neutral-200 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 uppercase tracking-wider text-sm"
                >
                  <Download className="w-4 h-4" />
                  <span>Download Recovery Kit</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Setup Complete */}
        {step === 3 && (
          <div className="text-center py-6 flex flex-col items-center gap-4">
            <CheckCircle2 className="w-12 h-12 text-white" />
            <h3 className="text-lg font-bold text-white uppercase tracking-[0.1em]">Setup Complete!</h3>
            <p className="text-neutral-500 text-xs uppercase tracking-wider max-w-xs">
              E2EE key generation is done and your Recovery Kit is saved.
            </p>
            <button
              onClick={onComplete}
              className="w-full bg-white text-black font-bold py-3 mt-4 hover:bg-neutral-200 transition-colors uppercase tracking-wider text-sm"
            >
              Enter Application
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
