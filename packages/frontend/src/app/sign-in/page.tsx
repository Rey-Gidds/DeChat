"use client";

import React, { useState } from "react";
import { signIn, sendVerificationEmail } from "@/lib/auth-client";
import { hasPrivateKeyInDB, recoverPrivateKeyFromKit } from "@/lib/crypto";
import { useKeyHealth } from "@/components/key-recovery/provider";
import { Lock, Mail, ShieldAlert, KeyRound, ArrowRight, Chrome, Upload, FileJson, CheckCircle2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const { refreshKeyStatus } = useKeyHealth();
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
      
      // Determine if local private key is present for this session
      if (data?.user) {
        const exists = await hasPrivateKeyInDB(data.user.id);
        const hasEncryption = (data.user as any).encryptionEnabled;
        
        if (hasEncryption && !exists) {
          // Present Recovery Kit restoration popup
          setShowRestorePrompt(true);
          setIsLoading(false);
          return;
        }
      }

      router.push("/");
    } catch (err: any) {
      const msg: string = err.message || "Failed to log in.";
      setError(msg);
      // Detect unverified email errors from better-auth
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
    <main className="flex min-h-screen flex-col items-center justify-center p-6 relative overflow-hidden bg-black">
      <div className="max-w-md w-full p-8 border border-neutral-800 bg-neutral-900 relative z-10 flex flex-col gap-6">
        {!showRestorePrompt ? (
          <>
            <div className="text-center">
              <h2 className="text-2xl font-bold text-white uppercase tracking-[0.15em]">Welcome Back</h2>
              <p className="text-neutral-500 text-xs mt-2 uppercase tracking-wider">Authenticate to enter rooms</p>
            </div>

            {error && (
              <div className="flex flex-col gap-2">
                <div className="p-3.5 bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 flex-shrink-0" />
                  <span>{error}</span>
                </div>

                {showResendVerification && (
                  <div className="p-4 bg-neutral-800 border border-neutral-700 flex flex-col gap-3">
                    <p className="text-neutral-400 text-xs leading-relaxed">
                      Your email hasn&apos;t been verified yet. We can resend the link to{" "}
                      <span className="text-white font-medium">{email}</span>.
                    </p>

                    {resendStatus === "sent" ? (
                      <div className="flex items-center gap-2 text-neutral-400 text-xs">
                        <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                        Verification email sent! Check your inbox.
                      </div>
                    ) : (
                      <>
                        {resendStatus === "failed" && (
                          <p className="text-red-400 text-xs">Failed to send. Please try again.</p>
                        )}
                        <button
                          type="button"
                          onClick={handleResendVerification}
                          disabled={resendStatus === "sending"}
                          className="w-full bg-neutral-800 border border-neutral-700 text-neutral-300 text-xs font-semibold py-2.5 hover:bg-neutral-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50 uppercase tracking-wider"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${resendStatus === "sending" ? "animate-spin" : ""}`} />
                          {resendStatus === "sending" ? "Sending…" : "Resend Verification Email"}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {success && (
              <div className="p-3.5 bg-green-500/10 border border-green-500/20 text-green-400 text-sm flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                <span>{success}</span>
              </div>
            )}

            <form onSubmit={handleLogin} className="flex flex-col gap-4">
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
                <div className="flex justify-between items-center">
                  <label className="text-neutral-400 text-xs font-semibold uppercase tracking-wider">Password</label>
                  <Link href="/forgot-password" className="text-xs text-neutral-400 hover:text-white transition-colors uppercase tracking-wider">
                    Forgot?
                  </Link>
                </div>
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
                disabled={isLoading}
                className="w-full bg-white text-black font-semibold py-3 mt-4 hover:bg-neutral-200 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 uppercase tracking-wider text-sm"
              >
                <span>Login</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <div className="relative my-2 flex items-center justify-center">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-neutral-800" />
              </div>
              <span className="relative bg-neutral-900 px-3 text-xs text-neutral-600 uppercase tracking-wider">Or</span>
            </div>

            <button
              onClick={handleGoogleLogin}
              className="w-full bg-neutral-800 border border-neutral-700 text-neutral-300 font-semibold py-3 hover:bg-neutral-700 hover:text-white transition-colors flex items-center justify-center gap-3 uppercase tracking-wider text-sm"
            >
              <Chrome className="w-4 h-4" />
              <span>Sign in with Google</span>
            </button>

            <div className="text-center text-xs text-neutral-600 uppercase tracking-wider">
              No account?{" "}
              <Link href="/sign-up" className="text-white hover:underline">
                Sign Up
              </Link>
            </div>
          </>
        ) : (
          <>
            <div className="text-center">
              <h2 className="text-xl font-bold text-white flex items-center justify-center gap-2 uppercase tracking-[0.15em]">
                <KeyRound className="w-5 h-5" />
                Identity Restore
              </h2>
              <p className="text-neutral-500 text-xs mt-2 uppercase tracking-wider">Restore key to decrypt messages</p>
            </div>

            {error && (
              <div className="p-3.5 bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {restoreSuccess ? (
              <div className="text-center py-6 flex flex-col items-center gap-4">
                <CheckCircle2 className="w-12 h-12 text-neutral-400" />
                <h3 className="text-lg font-bold text-white uppercase tracking-[0.1em]">Identity Restored!</h3>
                <p className="text-neutral-500 text-xs uppercase tracking-wider">Entering dashboard...</p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <p className="text-xs text-neutral-500 leading-relaxed uppercase tracking-wider">
                  Your private key is missing. Load your Recovery Kit JSON file and enter the passphrase set during registration.
                </p>

                <div className="flex flex-col gap-1.5">
                  <label className="text-neutral-400 text-xs font-semibold uppercase tracking-wider">Recovery JSON File</label>
                  <label className="flex flex-col items-center justify-center border border-neutral-800 hover:border-neutral-600 p-6 cursor-pointer bg-black transition-colors gap-2 text-neutral-500">
                    <input type="file" accept=".json" onChange={handleFileChange} className="hidden" />
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

                <div className="flex flex-col gap-1.5">
                  <label className="text-neutral-400 text-xs font-semibold uppercase tracking-wider">Passphrase</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-600" />
                    <input
                      type="password"
                      value={recoveryPassphrase}
                      onChange={(e) => setRecoveryPassphrase(e.target.value)}
                      placeholder="Passphrase used during backup"
                      className="w-full bg-black border border-neutral-800 py-3 pl-11 pr-4 text-white text-sm outline-none focus:border-neutral-600 transition-colors"
                    />
                  </div>
                </div>

                <div className="flex gap-3 mt-4">
                  <button
                    onClick={() => router.push("/")}
                    className="flex-1 bg-neutral-800 border border-neutral-700 text-neutral-400 py-3 hover:bg-neutral-700 transition-colors text-xs font-semibold uppercase tracking-wider"
                  >
                    Skip
                  </button>
                  <button
                    onClick={handleRestoreKey}
                    className="flex-1 bg-white text-black py-3 hover:bg-neutral-200 transition-colors text-xs font-bold uppercase tracking-wider"
                  >
                    Restore
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
