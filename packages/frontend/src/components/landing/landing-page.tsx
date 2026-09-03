"use client";

import Image from "next/image";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import {
  ShieldCheck,
  KeyRound,
  Lock,
  Zap,
  Radio,
  Bell,
  Fingerprint,
  Layers,
  ArrowRight,
  Terminal,
  ServerOff,
  Cpu,
  EyeOff,
  Sparkles,
} from "lucide-react";

export function LandingPage() {
  const { data: session } = useSession();

  return (
    <div className="relative min-h-screen bg-black text-neutral-200 selection:bg-white selection:text-black">
      {/* Background radial gradient glow (subtle, pure monochrome) */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 -top-40 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-neutral-900/30 blur-[130px]" />
        <div className="absolute top-[40%] right-[-10%] h-[400px] w-[500px] rounded-full bg-neutral-900/20 blur-[140px]" />
      </div>

      {/* Top Navbar */}
      <header className="sticky top-0 z-50 border-b border-neutral-900/80 bg-black/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Image
              src="/icons/dechat_logo_orig.png"
              alt="DeChat Logo"
              width={26}
              height={26}
              className="brightness-110"
            />
            <span className="text-sm font-semibold tracking-[0.25em] text-white uppercase">
              DeChat
            </span>
          </Link>

          <nav className="hidden items-center gap-8 md:flex text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-400">
            <a href="#features" className="transition hover:text-white">
              Features
            </a>
            <a href="#security" className="transition hover:text-white">
              Cryptography
            </a>
            <a href="#architecture" className="transition hover:text-white">
              Architecture
            </a>
            <a href="#preview" className="transition hover:text-white">
              Preview
            </a>
          </nav>

          <div className="flex items-center gap-3">
            {session?.user ? (
              <Link
                href="/discover"
                className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-semibold uppercase tracking-wider text-black transition hover:bg-neutral-200"
              >
                <span>Enter App</span>
                <ArrowRight size={13} />
              </Link>
            ) : (
              <>
                <Link
                  href="/sign-in"
                  className="rounded-full px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-neutral-400 transition hover:text-white hover:bg-neutral-900"
                >
                  Sign In
                </Link>
                <Link
                  href="/sign-up"
                  className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-semibold uppercase tracking-wider text-black transition hover:bg-neutral-200"
                >
                  <span>Get Started</span>
                  <ArrowRight size={13} />
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative mx-auto max-w-5xl px-6 pt-24 pb-20 text-center md:pt-32 md:pb-28">
        <div className="inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-950/80 px-3.5 py-1.5 text-[11px] font-medium tracking-wide text-neutral-400 backdrop-blur-sm">
          <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-neutral-300">ECDH P-256 + AES-GCM 256</span>
          <span className="text-neutral-700">|</span>
          <span className="text-neutral-500">Zero-Knowledge Architecture</span>
        </div>

        <h1 className="mt-8 text-4xl font-light tracking-tight text-white sm:text-6xl md:text-7xl font-sans">
          Encrypted rooms for <br />
          <span className="font-semibold text-neutral-100">
            uncompromised conversations.
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-base text-neutral-400 sm:text-lg font-normal leading-relaxed">
          DeChat provides deterministic end-to-end encrypted chat spaces. Your keys never leave your browser, your messages never touch our disks unencrypted, and your identity stays in your control.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            href={session?.user ? "/discover" : "/sign-up"}
            className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-xs font-semibold uppercase tracking-wider text-black shadow-lg transition hover:bg-neutral-200 hover:scale-[1.02] active:scale-[0.98]"
          >
            <span>{session?.user ? "Go to your rooms" : "Launch DeChat"}</span>
            <ArrowRight size={14} />
          </Link>
          <a
            href="#security"
            className="inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-950 px-6 py-3 text-xs font-medium uppercase tracking-wider text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-900"
          >
            <ShieldCheck size={14} className="text-neutral-400" />
            <span>How it encrypts</span>
          </a>
        </div>
      </section>

      {/* Metrics / Pillars Bar */}
      <section className="border-y border-neutral-900 bg-neutral-950/40">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-6 py-12 md:grid-cols-4">
          <div className="space-y-1">
            <p className="text-2xl font-light text-white sm:text-3xl font-mono">0</p>
            <p className="text-xs uppercase tracking-wider text-neutral-500 font-medium">
              Server message plaintext
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-2xl font-light text-white sm:text-3xl font-mono">256-bit</p>
            <p className="text-xs uppercase tracking-wider text-neutral-500 font-medium">
              Symmetric AES-GCM ciphers
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-2xl font-light text-white sm:text-3xl font-mono">WebCrypto</p>
            <p className="text-xs uppercase tracking-wider text-neutral-500 font-medium">
              Native hardware acceleration
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-2xl font-light text-white sm:text-3xl font-mono">Real-time</p>
            <p className="text-xs uppercase tracking-wider text-neutral-500 font-medium">
              WebSockets & FCM push
            </p>
          </div>
        </div>
      </section>

      {/* Feature Grid */}
      <section id="features" className="mx-auto max-w-6xl px-6 py-28">
        <div className="max-w-xl space-y-3">
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">
            Engineered for Confidentiality
          </span>
          <h2 className="text-3xl font-light tracking-tight text-white sm:text-4xl">
            Every feature designed around zero trust.
          </h2>
        </div>

        <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {/* Feature 1 */}
          <div className="group relative rounded-2xl border border-neutral-900 bg-neutral-950/50 p-7 transition hover:border-neutral-800 hover:bg-neutral-900/40">
            <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 text-neutral-300">
              <Lock size={18} />
            </div>
            <h3 className="text-base font-medium text-neutral-100">
              End-to-End Encryption
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">
              Messages and files are encrypted directly inside your device's browser using Web Crypto API. Even database leaks reveal only unreadable ciphertext.
            </p>
          </div>

          {/* Feature 2 */}
          <div className="group relative rounded-2xl border border-neutral-900 bg-neutral-950/50 p-7 transition hover:border-neutral-800 hover:bg-neutral-900/40">
            <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 text-neutral-300">
              <KeyRound size={18} />
            </div>
            <h3 className="text-base font-medium text-neutral-100">
              Emergency Recovery Kit
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">
              Generate a portable, encrypted recovery file secured by your master passphrase. Regain your identity and keys on new devices without trusting any cloud backup.
            </p>
          </div>

          {/* Feature 3 */}
          <div className="group relative rounded-2xl border border-neutral-900 bg-neutral-950/50 p-7 transition hover:border-neutral-800 hover:bg-neutral-900/40">
            <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 text-neutral-300">
              <Radio size={18} />
            </div>
            <h3 className="text-base font-medium text-neutral-100">
              Low-Latency WebSockets
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">
              Sub-second message relaying, live presence tracking, and real-time typing indicators without polling delays.
            </p>
          </div>

          {/* Feature 4 */}
          <div className="group relative rounded-2xl border border-neutral-900 bg-neutral-950/50 p-7 transition hover:border-neutral-800 hover:bg-neutral-900/40">
            <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 text-neutral-300">
              <Bell size={18} />
            </div>
            <h3 className="text-base font-medium text-neutral-100">
              Background Push Notifications
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">
              Integrated Firebase Service Workers deliver offline push notifications with background sync to ensure you never miss critical messages when the tab is closed.
            </p>
          </div>

          {/* Feature 5 */}
          <div className="group relative rounded-2xl border border-neutral-900 bg-neutral-950/50 p-7 transition hover:border-neutral-800 hover:bg-neutral-900/40">
            <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 text-neutral-300">
              <Layers size={18} />
            </div>
            <h3 className="text-base font-medium text-neutral-100">
              Room Discovery & Tags
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">
              Curate or join public spaces through trending topic tags, or create private invite-only rooms with custom access approval policies.
            </p>
          </div>

          {/* Feature 6 */}
          <div className="group relative rounded-2xl border border-neutral-900 bg-neutral-950/50 p-7 transition hover:border-neutral-800 hover:bg-neutral-900/40">
            <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 text-neutral-300">
              <Fingerprint size={18} />
            </div>
            <h3 className="text-base font-medium text-neutral-100">
              Local Key Health Guard
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">
              Automated in-app diagnostics verify the state of your browser IndexedDB key vault, warning you if cryptographic keys require re-synchronization.
            </p>
          </div>
        </div>
      </section>

      {/* Cryptography / Deep-Dive Section */}
      <section id="security" className="border-t border-neutral-900 bg-neutral-950/60 py-28">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
            <div className="space-y-6">
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">
                Cryptographic Architecture
              </span>
              <h2 className="text-3xl font-light tracking-tight text-white sm:text-4xl">
                The math behind our promise.
              </h2>
              <p className="text-sm leading-relaxed text-neutral-400">
                DeChat uses established modern primitives rather than reinventing cryptography. Client devices negotiate session keys and decrypt message envelopes without server visibility.
              </p>

              <div className="space-y-4 pt-2">
                <div className="flex items-start gap-4">
                  <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900 text-xs font-mono text-neutral-400">
                    1
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-neutral-200">Device-Level Key Generation</h4>
                    <p className="text-xs text-neutral-500 mt-0.5">
                      ECDH P-256 keypairs generated in-browser via the native W3C Web Cryptography standard.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900 text-xs font-mono text-neutral-400">
                    2
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-neutral-200">AES-GCM Payload Protection</h4>
                    <p className="text-xs text-neutral-500 mt-0.5">
                      Messages and attachments are authenticated and encrypted using 256-bit symmetric keys with fresh initialization vectors.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900 text-xs font-mono text-neutral-400">
                    3
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-neutral-200">Zero-Knowledge Storage</h4>
                    <p className="text-xs text-neutral-500 mt-0.5">
                      Private keys are persisted solely in your browser's IndexedDB, never transmitted or accessible to the server.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Architecture Code/Terminal Visual */}
            <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl font-mono text-xs">
              <div className="flex items-center justify-between border-b border-neutral-800/80 pb-3 text-neutral-500">
                <div className="flex items-center gap-2">
                  <Terminal size={14} className="text-neutral-400" />
                  <span>crypto-pipeline.ts</span>
                </div>
                <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Client Side</span>
              </div>

              <div className="mt-4 space-y-2 text-neutral-400 leading-relaxed text-[11px]">
                <p className="text-neutral-600">// 1. Generate local user keypair</p>
                <p className="text-neutral-300">
                  <span className="text-neutral-500">const</span> keyPair = <span className="text-neutral-500">await</span> crypto.subtle.generateKey(
                </p>
                <p className="pl-4 text-neutral-400">&#123; name: &quot;ECDH&quot;, namedCurve: &quot;P-256&quot; &#125;,</p>
                <p className="pl-4 text-neutral-400">false, [&quot;deriveKey&quot;, &quot;deriveBits&quot;]</p>
                <p className="text-neutral-300">);</p>

                <p className="pt-2 text-neutral-600">// 2. Encrypt message envelope</p>
                <p className="text-neutral-300">
                  <span className="text-neutral-500">const</span> ciphertext = <span className="text-neutral-500">await</span> crypto.subtle.encrypt(
                </p>
                <p className="pl-4 text-neutral-400">&#123; name: &quot;AES-GCM&quot;, iv &#125;,</p>
                <p className="pl-4 text-neutral-400">derivedRoomKey, plaintextBuffer</p>
                <p className="text-neutral-300">);</p>

                <p className="pt-2 text-emerald-400/80">// Payload sent to server is opaque ciphertext</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Call to Action Section */}
      <section className="border-t border-neutral-900 bg-gradient-to-b from-neutral-950 to-black py-28 text-center">
        <div className="mx-auto max-w-3xl px-6 space-y-6">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-900 text-white shadow-inner">
            <Image
              src="/icons/dechat_logo_orig.png"
              alt="DeChat Logo"
              width={24}
              height={24}
            />
          </div>

          <h2 className="text-3xl font-light tracking-tight text-white sm:text-5xl font-sans">
            Ready for truly private communication?
          </h2>

          <p className="text-sm text-neutral-400 max-w-md mx-auto">
            Create an account in seconds. No telephone number required. Your cryptographic keys stay in your browser.
          </p>

          <div className="pt-4 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/sign-up"
              className="inline-flex items-center gap-2 rounded-full bg-white px-7 py-3 text-xs font-semibold uppercase tracking-wider text-black shadow-lg transition hover:bg-neutral-200 hover:scale-[1.02] active:scale-[0.98]"
            >
              <span>Get Started Free</span>
              <ArrowRight size={14} />
            </Link>
            <Link
              href="/sign-in"
              className="inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-950 px-6 py-3 text-xs font-medium uppercase tracking-wider text-neutral-300 transition hover:bg-neutral-900 hover:border-neutral-700"
            >
              <span>Sign In</span>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-neutral-900/80 bg-black py-12 text-neutral-500">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-6 sm:flex-row text-xs">
          <div className="flex items-center gap-2.5">
            <Image
              src="/icons/dechat_logo_orig.png"
              alt="DeChat Logo"
              width={18}
              height={18}
              className="opacity-80"
            />
            <span className="font-mono text-[11px] uppercase tracking-widest text-neutral-400">
              DeChat
            </span>
          </div>

          <p className="text-[11px] text-neutral-600">
            End-to-end encrypted messaging. Client-side cryptography with zero-knowledge architecture.
          </p>

          <div className="flex items-center gap-5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
            <Link href="/sign-in" className="transition hover:text-white">
              Sign In
            </Link>
            <Link href="/sign-up" className="transition hover:text-white">
              Sign Up
            </Link>
            <a href="#security" className="transition hover:text-white">
              Security
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
