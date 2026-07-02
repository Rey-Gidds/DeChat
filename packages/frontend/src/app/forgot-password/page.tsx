"use client";

import React, { useState } from "react";
import { requestPasswordReset } from "@/lib/auth-client";
import { Mail, ShieldAlert, CheckCircle2, ArrowRight } from "lucide-react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleResetRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setError("Please enter your email address.");
      return;
    }
    setError("");
    setSuccess("");
    setIsLoading(true);

    try {
      const { error: resetError } = await requestPasswordReset({
        email,
        redirectTo: "/reset-password",
      });

      if (resetError) {
        throw new Error(resetError.message || "Failed to submit request.");
      }

      setSuccess("A reset link has been dispatched to your email address!");
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 relative overflow-hidden bg-black">
      <div className="max-w-md w-full p-8 border border-neutral-800 bg-neutral-900 relative z-10 flex flex-col gap-6">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-white uppercase tracking-[0.15em]">Reset Password</h2>
          <p className="text-neutral-500 text-xs mt-2 uppercase tracking-wider">Request a recovery link</p>
        </div>

        {error && (
          <div className="p-3.5 bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {success ? (
          <div className="text-center py-6 flex flex-col items-center gap-4">
            <CheckCircle2 className="w-12 h-12 text-neutral-400" />
            <h3 className="text-lg font-bold text-white uppercase tracking-[0.1em]">Dispatch Complete</h3>
            <p className="text-neutral-500 text-xs uppercase tracking-wider">{success}</p>
            <Link href="/sign-in" className="mt-4 text-white hover:underline text-xs font-semibold uppercase tracking-wider">
              Return to Sign In
            </Link>
          </div>
        ) : (
          <form onSubmit={handleResetRequest} className="flex flex-col gap-4">
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

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-white text-black font-semibold py-3 mt-4 hover:bg-neutral-200 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 uppercase tracking-wider text-sm"
            >
              <span>Send Link</span>
              <ArrowRight className="w-4 h-4" />
            </button>

            <div className="text-center text-xs text-neutral-600 mt-2 uppercase tracking-wider">
              <Link href="/sign-in" className="text-white hover:underline">
                Back to Sign In
              </Link>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
