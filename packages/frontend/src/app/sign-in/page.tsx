"use client";

import React, { useState } from "react";
import Image from "next/image";
import { signIn, sendVerificationEmail } from "@/lib/auth-client";
import { hasPrivateKeyInDB, recoverPrivateKeyFromKit } from "@/lib/crypto";
import { useKeyHealth } from "@/components/key-recovery/provider";
import { Lock, Mail, ShieldAlert, KeyRound, ArrowRight, Chrome, Upload, FileJson, CheckCircle2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const { refreshKeyStatus } = useKeyHealth();
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Resend verification email state
  const [showResendVerification, setShowResendVerification] = useState(false);
  const [resendStatus, setResendStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  // Key recovery states
  const [showRestorePrompt, setShowRestorePrompt] = useState(false);
  const [recoveryFile, setRecoveryFile] = useState<any>(null);
  const [recoveryPassphrase, setRecoveryPassphrase] = useState("");
  const [restoreSuccess, setRestoreSuccess] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Please enter your email and password.");
      return;
    }
    setError("");
    setSuccess("");
    setShowResendVerification(false);
    setResendStatus("idle");
    setIsLoading(true);

    try {
      const { data, error: authError } = await signIn.email({
        email,
        password,
      });

      if (authError) {
        throw new Error(authError.message || "Invalid credentials.");
      }

      setSuccess("Successfully signed in!");

      if (data?.user) {
        const exists = await hasPrivateKeyInDB(data.user.id);
        const hasEncryption = (data.user as any).encryptionEnabled;

        if (hasEncryption && !exists) {
          setShowRestorePrompt(true);
          setIsLoading(false);
          return;
        }
      }

      router.push("/");
    } catch (err: any) {
      const msg: string = err.message || "Failed to log in.";
      setError(msg);
      if (/verif/i.test(msg)) {
        setShowResendVerification(true);
      }
      setIsLoading(false);
    }
  };

  const handleResendVerification = async () => {
    if (!email) return;
    setResendStatus("sending");
    try {
      const { error: resendError } = await sendVerificationEmail({
        email,
        callbackURL: "/verify-email",
      });
      if (resendError) throw new Error(resendError.message);
      setResendStatus("sent");
    } catch {
      setResendStatus("failed");
    }
  };

  const handleGoogleLogin = async () => {
    try {
      await signIn.social({
        provider: "google",
        callbackURL: "/",
      });
    } catch (err: any) {
      setError("Google Login failed: " + err.message);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        setRecoveryFile(json);
        setError("");
      } catch (err) {
        setError("Invalid recovery kit file structure.");
      }
    };
    reader.readAsText(file);
  };

  const handleRestoreKey = async () => {
    if (!recoveryFile || !recoveryPassphrase) {
      setError("Please load a valid recovery file and enter the passphrase.");
      return;
    }
    setError("");
    setIsLoading(true);

    try {
      await recoverPrivateKeyFromKit(recoveryFile, recoveryPassphrase);
      setRestoreSuccess(true);
      setTimeout(() => {
        router.push("/");
      }, 1500);
    } catch (err: any) {
      setError("Decryption failed. Please verify the passphrase.");
      setIsLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4 bg-black relative overflow-hidden">
      <div className="w-full max-w-sm rounded-3xl border border-neutral-800/80 bg-neutral-950 p-8 shadow-2xl relative z-10 flex flex-col justify-between min-h-[580px]">
        {!showRestorePrompt ? (
          <div className="flex-1 flex flex-col justify-between">
            {/* Splash Header with Logo */}
            <div className="text-center pt-6 flex flex-col items-center">
              <div className="mb-4 flex h-20 w-20 items-center justify-center">
                <Image
                  src="/icons/dechat_logo_orig.png"
                  alt="DeChat Logo"
                  width={64}
                  height={64}
                  className="object-contain rounded-full"
                />
              </div>
              <h1 className="text-xl font-bold text-white uppercase tracking-[0.25em]">
                DECHAT
              </h1>
              <p className="text-xs text-neutral-500 mt-2 font-medium tracking-wide">
                Private. Encrypted. Temporary.
              </p>
            </div>

            {/* Form & Actions Section */}
            <div className="my-6 space-y-4">
              {error && (
                <div className="flex flex-col gap-2">
                  <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 flex-shrink-0" />
                    <span>{error}</span>
                  </div>

                  {showResendVerification && (
                    <div className="p-3.5 rounded-xl bg-neutral-900 border border-neutral-800 flex flex-col gap-2.5">
                      <p className="text-neutral-400 text-xs leading-relaxed">
                        Your email hasn&apos;t been verified yet. We can resend link to{" "}
                        <span className="text-white font-medium">{email}</span>.
                      </p>

                      {resendStatus === "sent" ? (
                        <div className="flex items-center gap-2 text-neutral-300 text-xs">
                          <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                          Verification email sent! Check inbox.
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={handleResendVerification}
                          disabled={resendStatus === "sending"}
                          className="w-full rounded-xl bg-neutral-800 border border-neutral-700 text-neutral-300 text-xs font-medium py-2 hover:bg-neutral-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${resendStatus === "sending" ? "animate-spin" : ""}`} />
                          {resendStatus === "sending" ? "Sending…" : "Resend Verification"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {success && (
                <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-xs flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                  <span>{success}</span>
                </div>
              )}

              {!showEmailForm ? (
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => setShowEmailForm(true)}
                    className="w-full rounded-2xl bg-white text-black font-semibold py-3.5 px-4 transition-all hover:bg-neutral-200 flex items-center justify-center gap-2.5 text-sm shadow-md"
                  >
                    <Mail className="w-4 h-4" />
                    <span>Continue with Email</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleGoogleLogin}
                    className="w-full rounded-2xl bg-neutral-900 border border-neutral-800 text-neutral-300 font-medium py-3 px-4 transition-all hover:bg-neutral-800 hover:text-white flex items-center justify-center gap-2.5 text-xs"
                  >
                    <Chrome className="w-4 h-4" />
                    <span>Continue with Google</span>
                  </button>
                </div>
              ) : (
                <form onSubmit={handleLogin} className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-neutral-400 text-[10px] font-semibold uppercase tracking-wider">Email</label>
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
                    <div className="flex justify-between items-center">
                      <label className="text-neutral-400 text-[10px] font-semibold uppercase tracking-wider">Password</label>
                      <Link href="/forgot-password" className="text-[10px] text-neutral-400 hover:text-white transition-colors">
                        Forgot?
                      </Link>
                    </div>
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
                    className="w-full rounded-2xl bg-white text-black font-semibold py-3 mt-2 hover:bg-neutral-200 transition-all flex items-center justify-center gap-2 disabled:opacity-40 text-xs shadow"
                  >
                    <span>{isLoading ? "Signing in..." : "Sign In"}</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowEmailForm(false)}
                    className="text-center text-[10px] text-neutral-500 hover:text-neutral-300 transition py-1"
                  >
                    ← Back to choices
                  </button>
                </form>
              )}

              {/* Sign up prompt */}
              <div className="text-center text-xs text-neutral-500 pt-2">
                Already have an account?{" "}
                <Link href="/sign-up" className="text-white font-medium hover:underline">
                  Sign in
                </Link>
              </div>
            </div>

            {/* Bottom Encryption Note */}
            <div className="pt-4 border-t border-neutral-900/80 text-center flex items-center justify-center gap-1.5 text-[10px] text-neutral-600">
              <Lock className="w-3 h-3 text-neutral-600" />
              <span>End-to-end encrypted</span>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col justify-between py-4">
            <div className="text-center">
              <h2 className="text-lg font-bold text-white flex items-center justify-center gap-2">
                <KeyRound className="w-5 h-5 text-neutral-300" />
                Identity Restore
              </h2>
              <p className="text-neutral-500 text-xs mt-1">Restore key to decrypt messages</p>
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {restoreSuccess ? (
              <div className="text-center py-6 flex flex-col items-center gap-3">
                <CheckCircle2 className="w-10 h-10 text-white" />
                <h3 className="text-base font-bold text-white">Identity Restored!</h3>
                <p className="text-neutral-500 text-xs">Entering dashboard...</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3 my-4">
                <p className="text-xs text-neutral-400 leading-relaxed">
                  Your private key is missing. Load your Recovery Kit JSON file and enter your passphrase.
                </p>

                <div className="flex flex-col gap-1">
                  <label className="text-neutral-400 text-[10px] font-semibold uppercase tracking-wider">Recovery JSON File</label>
                  <label className="flex flex-col items-center justify-center border border-neutral-800 hover:border-neutral-700 p-4 rounded-xl cursor-pointer bg-neutral-900 transition-colors gap-1.5 text-neutral-400">
                    <input type="file" accept=".json" onChange={handleFileChange} className="hidden" />
                    {recoveryFile ? (
                      <>
                        <FileJson className="w-6 h-6 text-white" />
                        <span className="text-xs text-white font-medium">Backup file loaded</span>
                      </>
                    ) : (
                      <>
                        <Upload className="w-6 h-6 text-neutral-500" />
                        <span className="text-xs">Upload dechat-recovery-kit-*.json</span>
                      </>
                    )}
                  </label>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-neutral-400 text-[10px] font-semibold uppercase tracking-wider">Passphrase</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
                    <input
                      type="password"
                      value={recoveryPassphrase}
                      onChange={(e) => setRecoveryPassphrase(e.target.value)}
                      placeholder="Passphrase used during backup"
                      className="w-full bg-neutral-900 border border-neutral-800 rounded-xl py-2.5 pl-10 pr-3 text-white text-xs outline-none focus:border-neutral-600 transition-colors"
                    />
                  </div>
                </div>

                <div className="flex gap-2.5 mt-2">
                  <button
                    onClick={() => router.push("/")}
                    className="flex-1 bg-neutral-900 border border-neutral-800 text-neutral-400 py-2.5 rounded-xl hover:bg-neutral-800 transition-colors text-xs font-medium"
                  >
                    Skip
                  </button>
                  <button
                    onClick={handleRestoreKey}
                    className="flex-1 bg-white text-black py-2.5 rounded-xl hover:bg-neutral-200 transition-colors text-xs font-semibold"
                  >
                    Restore
                  </button>
                </div>
              </div>
            )}

            <div className="text-center text-[10px] text-neutral-600 flex items-center justify-center gap-1.5">
              <Lock className="w-3 h-3" />
              <span>End-to-end encrypted</span>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
