"use client";

import React, { useEffect, useState, Suspense } from "react";
import { verifyEmail, sendVerificationEmail } from "@/lib/auth-client";
import { CheckCircle2, ShieldAlert, KeyRound, Mail, RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function VerifyEmailForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<"verifying" | "success" | "error">("verifying");
  const [errorMessage, setErrorMessage] = useState("");

  // Resend state
  const [resendEmail, setResendEmail] = useState("");
  const [resendStatus, setResendStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setErrorMessage("Verification token is missing from the URL.");
      return;
    }

    const performVerification = async () => {
      try {
        const { error } = await verifyEmail({
          query: { token },
        });

        if (error) {
          throw new Error(error.message || "Verification failed.");
        }

        setStatus("success");
        // autoSignInAfterVerification is enabled — user is already signed in.
        // Redirect to dashboard instead of sign-in.
        setTimeout(() => {
          router.push("/");
        }, 2500);
      } catch (err: any) {
        setStatus("error");
        setErrorMessage(err.message || "Verification link is invalid or expired.");
      }
    };

    performVerification();
  }, [token, router]);

  const handleResend = async () => {
    if (!resendEmail) return;
    setResendStatus("sending");
    try {
      const { error } = await sendVerificationEmail({
        email: resendEmail,
        callbackURL: "/verify-email",
      });
      if (error) throw new Error(error.message);
      setResendStatus("sent");
    } catch {
      setResendStatus("failed");
    }
  };

  return (
    <div className="max-w-md w-full p-8 border border-neutral-800 bg-neutral-900 relative z-10 flex flex-col gap-6 text-center">

      {/* ─── VERIFYING ─── */}
      {status === "verifying" && (
        <div className="py-8 flex flex-col items-center gap-4">
          <div className="relative w-16 h-16 flex items-center justify-center">
            <div className="absolute inset-0 border-2 border-neutral-700" />
            <div className="absolute inset-0 border-2 border-white border-t-transparent animate-spin" />
            <KeyRound className="w-6 h-6 text-neutral-400" />
          </div>
          <h3 className="text-lg font-bold text-white mt-2 uppercase tracking-[0.1em]">Verifying Identity</h3>
          <p className="text-neutral-500 text-xs uppercase tracking-wider">
            Validating your security token…
          </p>
        </div>
      )}

      {/* ─── SUCCESS ─── */}
      {status === "success" && (
        <div className="py-8 flex flex-col items-center gap-4">
          <CheckCircle2 className="w-16 h-16 text-neutral-400" />
          <h3 className="text-xl font-bold text-white uppercase tracking-[0.15em]">Email Verified!</h3>
          <p className="text-neutral-500 text-xs uppercase tracking-wider max-w-xs">
            Your identity has been confirmed. You are now signed in.
          </p>
          <div className="flex items-center gap-2 text-xs text-neutral-600 mt-1 uppercase tracking-wider">
            <div className="w-1.5 h-1.5 bg-neutral-500" />
            Redirecting to dashboard…
          </div>
        </div>
      )}

      {/* ─── ERROR ─── */}
      {status === "error" && (
        <div className="flex flex-col items-center gap-5">
          <div className="py-4 flex flex-col items-center gap-3">
            <ShieldAlert className="w-14 h-14 text-red-500" />
            <h3 className="text-xl font-bold text-white uppercase tracking-[0.15em]">Verification Failed</h3>
            <p className="text-red-400 text-sm leading-relaxed max-w-xs">{errorMessage}</p>
          </div>

          {/* Divider */}
          <div className="w-full flex items-center gap-3">
            <div className="flex-1 border-t border-neutral-800" />
            <span className="text-xs text-neutral-600 uppercase tracking-wider">Resend Link</span>
            <div className="flex-1 border-t border-neutral-800" />
          </div>

          {/* Resend form */}
          <div className="w-full flex flex-col gap-3 text-left">
            <p className="text-neutral-500 text-xs uppercase tracking-wider text-center">
              Enter your email to receive a fresh verification link.
            </p>

            {resendStatus === "sent" ? (
              <div className="p-3.5 bg-green-500/10 border border-green-500/20 text-green-400 text-sm flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                <span>Verification email sent! Check your inbox.</span>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-600" />
                  <input
                    type="email"
                    value={resendEmail}
                    onChange={(e) => setResendEmail(e.target.value)}
                    placeholder="your@email.com"
                    className="w-full bg-black border border-neutral-800 py-3 pl-11 pr-4 text-white text-sm outline-none focus:border-neutral-600 transition-colors"
                  />
                </div>

                {resendStatus === "failed" && (
                  <p className="text-red-400 text-xs text-center">
                    Could not send email. Please check the address and try again.
                  </p>
                )}

                <button
                  onClick={handleResend}
                  disabled={!resendEmail || resendStatus === "sending"}
                  className="w-full bg-white text-black font-semibold py-3 hover:bg-neutral-200 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed uppercase tracking-wider text-sm"
                >
                  <RefreshCw className={`w-4 h-4 ${resendStatus === "sending" ? "animate-spin" : ""}`} />
                  <span>{resendStatus === "sending" ? "Sending…" : "Resend Verification Email"}</span>
                </button>
              </>
            )}

            <Link
              href="/sign-up"
              className="text-center text-xs text-neutral-600 hover:text-neutral-400 transition-colors mt-1 uppercase tracking-wider"
            >
              Create a new account instead
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 relative overflow-hidden bg-black">
      <Suspense
        fallback={
          <div className="text-neutral-500 text-xs uppercase tracking-wider animate-pulse">
            Loading validation parameters…
          </div>
        }
      >
        <VerifyEmailForm />
      </Suspense>
    </main>
  );
}
