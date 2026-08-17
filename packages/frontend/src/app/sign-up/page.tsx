"use client";

import React, { useState } from "react";
import Image from "next/image";
import { signUp } from "@/lib/auth-client";
import { generateUserKeyPair, exportPublicKey, savePrivateKey } from "@/lib/crypto";
import { RecoveryDownload } from "@/components/key-recovery/recovery-download";
import { Lock, Mail, User, ShieldAlert, KeyRound, ArrowRight, CheckCircle2 } from "lucide-react";
import Link from "next/link";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState(1);
  const [tempUserId, setTempUserId] = useState("");
  const [tempPrivateKey, setTempPrivateKey] = useState<CryptoKey | null>(null);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || !username) {
      setError("Please fill out all fields.");
      return;
    }
    setError("");
    setIsLoading(true);
    setStep(2);

    try {
      const keyPair = await generateUserKeyPair();
      const pubKeyBase64 = await exportPublicKey(keyPair.publicKey);

      const { data, error: authError } = await signUp.email({
        email,
        password,
        name: username,
        publicKey: pubKeyBase64,
        callbackURL: "/sign-in",
      } as any);

      if (authError) {
        throw new Error(authError.message || "Failed to register account.");
      }

      if (data?.user) {
        await savePrivateKey(data.user.id, keyPair.privateKey);
        setTempUserId(data.user.id);
        setTempPrivateKey(keyPair.privateKey);
        setIsLoading(false);
        setStep(3);
      }
    } catch (err: any) {
      setError(err.message || "Something went wrong.");
      setStep(1);
      setIsLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4 bg-black overflow-hidden">
      <div className="w-full max-w-sm rounded-3xl border border-neutral-800/80 bg-neutral-950 p-8 shadow-2xl relative z-10 flex flex-col gap-6">

        {step === 1 && (
          <>
            {/* Header */}
            <div className="text-center flex flex-col items-center pt-4">
              <div className="mb-4 flex h-16 w-16 items-center justify-center">
                <Image src="/icons/dechat_logo_orig.png" alt="DeChat" width={48} height={48} className="object-contain rounded-full" />
              </div>
              <h1 className="text-lg font-bold text-white uppercase tracking-[0.2em]">DECHAT</h1>
              <p className="text-xs text-neutral-500 mt-1">Create your encrypted identity</p>
            </div>

            {error && (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleRegister} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Username</label>
                <div className="relative">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="DechatUser"
                    className="w-full bg-neutral-900 border border-neutral-800 rounded-xl py-2.5 pl-10 pr-3 text-white text-xs outline-none focus:border-neutral-600 transition-colors"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="user@dechat.org"
                    className="w-full bg-neutral-900 border border-neutral-800 rounded-xl py-2.5 pl-10 pr-3 text-white text-xs outline-none focus:border-neutral-600 transition-colors"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-neutral-900 border border-neutral-800 rounded-xl py-2.5 pl-10 pr-3 text-white text-xs outline-none focus:border-neutral-600 transition-colors"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full rounded-2xl bg-white text-black font-semibold py-3 mt-3 hover:bg-neutral-200 transition-all flex items-center justify-center gap-2 text-xs shadow disabled:opacity-40"
              >
                <span>Generate Keys & Sign Up</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <div className="text-center text-xs text-neutral-500">
              Already have an account?{" "}
              <Link href="/sign-in" className="text-white font-medium hover:underline">
                Sign In
              </Link>
            </div>

            <div className="text-center flex items-center justify-center gap-1.5 text-[10px] text-neutral-600 border-t border-neutral-900 pt-4 -mt-2">
              <Lock className="w-3 h-3" />
              <span>End-to-end encrypted</span>
            </div>
          </>
        )}

        {step === 2 && (
          <div className="text-center py-10 flex flex-col items-center gap-5">
            <div className="relative w-16 h-16 flex items-center justify-center">
              <div className="absolute inset-0 rounded-full border-2 border-neutral-800" />
              <div className="absolute inset-0 rounded-full border-2 border-white border-t-transparent animate-spin" />
              <KeyRound className="w-6 h-6 text-neutral-300" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white mb-1.5">Generating Identity</h3>
              <p className="text-neutral-500 text-xs leading-relaxed max-w-[200px] mx-auto">
                Creating your E2EE keypairs. Your private key stays on this device.
              </p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-5">
            <div className="text-center">
              <h2 className="text-base font-bold text-white">Security Kit Backup</h2>
              <p className="text-neutral-500 text-xs mt-1">Export your encrypted identity backup</p>
            </div>
            {tempPrivateKey && (
              <RecoveryDownload
                userId={tempUserId}
                privateKey={tempPrivateKey}
                onComplete={() => setStep(4)}
              />
            )}
          </div>
        )}

        {step === 4 && (
          <div className="text-center py-10 flex flex-col items-center gap-5">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-900 border border-neutral-800">
              <CheckCircle2 className="w-8 h-8 text-white" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white mb-1.5">Setup Complete!</h3>
              <p className="text-neutral-500 text-xs leading-relaxed max-w-[220px] mx-auto">
                Verification email sent. Check your email before logging in.
              </p>
            </div>
            <Link
              href="/sign-in"
              className="rounded-2xl bg-white text-black font-semibold px-8 py-3 hover:bg-neutral-200 transition-all text-xs shadow"
            >
              Go to Sign In
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
