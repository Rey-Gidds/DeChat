"use client";

import React, { useState, Suspense } from "react";
import { resetPassword } from "@/lib/auth-client";
import { Lock, ShieldAlert, CheckCircle2, ArrowRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [newPassword, setNewPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword) {
      setError("Please enter a new password.");
      return;
    }
    if (!token) {
      setError("Token is missing. Cannot reset password.");
      return;
    }
    setError("");
    setSuccess("");
    setIsLoading(true);

    try {
      const { error: resetError } = await resetPassword({
        newPassword,
        token,
      });

      if (resetError) {
        throw new Error(resetError.message || "Failed to reset password.");
      }

      setSuccess("Your password has been successfully updated!");
      setTimeout(() => {
        router.push("/sign-in");
      }, 2000);
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-md w-full p-8 border border-neutral-800 bg-neutral-900 relative z-10 flex flex-col gap-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-white uppercase tracking-[0.15em]">New Password</h2>
        <p className="text-neutral-500 text-xs mt-2 uppercase tracking-wider">Configure your recovery passphrase</p>
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
          <h3 className="text-lg font-bold text-white uppercase tracking-[0.1em]">Reset Successful</h3>
          <p className="text-neutral-500 text-xs uppercase tracking-wider">{success}</p>
          <p className="text-xs text-neutral-600 uppercase tracking-wider">Redirecting to sign in...</p>
        </div>
      ) : (
        <form onSubmit={handleReset} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-neutral-400 text-xs font-semibold uppercase tracking-wider">New Password</label>
            <div className="relative">
              <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-600" />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-black border border-neutral-800 py-3 pl-11 pr-4 text-white text-sm outline-none focus:border-neutral-600 transition-colors"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading || !token}
            className="w-full bg-white text-black font-semibold py-3 mt-4 hover:bg-neutral-200 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 uppercase tracking-wider text-sm"
          >
            <span>Update Password</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>
      )}
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 relative overflow-hidden bg-black">
      <Suspense fallback={<div className="text-neutral-500 text-xs uppercase tracking-wider">Loading request validation...</div>}>
        <ResetPasswordForm />
      </Suspense>
    </main>
  );
}
