"use client";

import React, { useState } from "react";
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
  
  // States for E2EE keys setup modal
  const [step, setStep] = useState(1); // 1 = Registration form, 2 = Generating keys, 3 = Recovery kit setup, 4 = Complete
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
    setStep(2); // Show "Generating cryptographic keys" step

    try {
      // 1. Generate client-side keypair
      const keyPair = await generateUserKeyPair();
      const pubKeyBase64 = await exportPublicKey(keyPair.publicKey);

      // 2. Register user with public key
      const { data, error: authError } = await signUp.email({
        email,
        password,
        name: username, // Better Auth standard field is name
        // We can pass username as additional metadata or rely on name
        publicKey: pubKeyBase64,
        callbackURL: "/sign-in",
      } as any);

      if (authError) {
        throw new Error(authError.message || "Failed to register account.");
      }

      if (data?.user) {
        // 3. Save Private Key to client IndexedDB
        await savePrivateKey(data.user.id, keyPair.privateKey);
        
        setTempUserId(data.user.id);
        setTempPrivateKey(keyPair.privateKey);
        setIsLoading(false);
        setStep(3); // Go to Recovery kit step
      }
    } catch (err: any) {
      setError(err.message || "Something went wrong.");
      setStep(1);
      setIsLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 relative overflow-hidden bg-black">
      <div className="max-w-md w-full p-8 border border-neutral-800 bg-neutral-900 relative z-10 flex flex-col gap-6">
        {step === 1 && (
          <>
            <div className="text-center">
              <h2 className="text-2xl font-bold text-white uppercase tracking-[0.15em]">Create Account</h2>
              <p className="text-neutral-500 text-xs mt-2 uppercase tracking-wider">Initialize your E2EE identity</p>
            </div>

            {error && (
              <div className="p-3.5 bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleRegister} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-neutral-400 text-xs font-semibold uppercase tracking-wider">Username</label>
                <div className="relative">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-600" />
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="DechatUser"
                    className="w-full bg-black border border-neutral-800 py-3 pl-11 pr-4 text-white text-sm outline-none focus:border-neutral-600 transition-colors"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-neutral-400 text-xs font-semibold uppercase tracking-wider">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-600" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="user@dechat.org"
                    className="w-full bg-black border border-neutral-800 py-3 pl-11 pr-4 text-white text-sm outline-none focus:border-neutral-600 transition-colors"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-neutral-400 text-xs font-semibold uppercase tracking-wider">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-600" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-black border border-neutral-800 py-3 pl-11 pr-4 text-white text-sm outline-none focus:border-neutral-600 transition-colors"
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full bg-white text-black font-semibold py-3 mt-4 hover:bg-neutral-200 transition-colors flex items-center justify-center gap-2 uppercase tracking-wider text-sm"
              >
                <span>Generate Keys & Sign Up</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <div className="text-center text-xs text-neutral-600 uppercase tracking-wider">
              Already have an account?{" "}
              <Link href="/sign-in" className="text-white hover:underline">
                Sign In
              </Link>
            </div>
          </>
        )}

        {step === 2 && (
          <div className="text-center py-8 flex flex-col items-center gap-4">
            <div className="relative w-16 h-16 flex items-center justify-center">
              <div className="absolute inset-0 border-2 border-neutral-700" />
              <div className="absolute inset-0 border-2 border-white border-t-transparent animate-spin" />
              <KeyRound className="w-6 h-6 text-neutral-400" />
            </div>
            <h3 className="text-lg font-bold text-white mt-2 uppercase tracking-[0.1em]">Generating Identity</h3>
            <p className="text-neutral-500 text-xs uppercase tracking-wider max-w-xs">
              Generating your E2EE keypairs. Your private key stays on your device.
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-6">
            <div className="text-center">
              <h2 className="text-xl font-bold text-white uppercase tracking-[0.15em]">Security Kit Backup</h2>
              <p className="text-neutral-500 text-xs mt-2 uppercase tracking-wider">Export your encrypted identity backup</p>
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
          <div className="text-center py-8 flex flex-col items-center gap-4">
            <CheckCircle2 className="w-16 h-16 text-neutral-400" />
            <h3 className="text-xl font-bold text-white uppercase tracking-[0.15em]">Setup Complete!</h3>
            <p className="text-neutral-500 text-xs uppercase tracking-wider max-w-xs">
              Verification email sent! Check your email before logging in.
            </p>
            <Link
              href="/sign-in"
              className="mt-6 bg-white text-black font-semibold px-8 py-3 hover:bg-neutral-200 transition-colors uppercase tracking-wider text-sm"
            >
              Go to Sign In
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
