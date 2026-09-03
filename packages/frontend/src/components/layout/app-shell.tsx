"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "@/lib/auth-client";
import { clearAllOutboxEntries } from "@/lib/outbox-db";
import { Button } from "@/components/ui/button";
import { KeyHealthProvider, useKeyHealth } from "@/components/key-recovery/provider";
import { KeyStatusBanner } from "@/components/key-recovery/key-status-banner";
import { RecoveryDialog } from "@/components/key-recovery/recovery-dialog";
import { KeygenDialog } from "@/components/key-recovery/keygen-dialog";
import { UnlockDialog } from "@/components/key-recovery/unlock-dialog";
import { Compass, Clock, List, Grid3X3, User, LogOut } from "lucide-react";
import { useUser } from "@/hooks/use-swr-hooks";
import { GlobalSocketProvider } from "@/lib/global-socket-context";
import { useEffect } from "react";

// Profile excluded from footer — lives in header only
const NAV_ITEMS = [
  { href: "/rooms/joined", label: "Joined", icon: List },
  { href: "/pending", label: "Requests", icon: Clock },
  { href: "/discover", label: "Discover", icon: Compass },
  { href: "/my-rooms", label: "My Rooms", icon: Grid3X3 },
];

function GlobalRecoveryDialog() {
  const { isRecoveryOpen, closeRecovery } = useKeyHealth();
  return <RecoveryDialog open={isRecoveryOpen} onClose={closeRecovery} context="banner" />;
}

function GlobalUnlockDialog() {
  return <UnlockDialog />;
}

function ShellContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: session, isPending } = useSession();
  const { user: userProfile } = useUser();
  const { state } = useKeyHealth();
  const isLandingPage = pathname === "/";
  const isAuthPage = ["/sign-in", "/sign-up", "/verify-email", "/forgot-password", "/reset-password"].includes(pathname);
  const isRoomPage = (pathname.startsWith("/rooms/") && !pathname.startsWith("/rooms/joined") && !pathname.startsWith("/my-rooms")) || isAuthPage || isLandingPage;

  const showKeygen = session?.user && !isPending && !isAuthPage && state === "setup-required";
  const userName = userProfile?.name || session?.user?.name || session?.user?.email;
  const pfp = userProfile?.pfp;

  // ── FCM Service Worker & Push Registration ─────────────────────
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !session?.user?.id) return;

    const queryParams = new URLSearchParams({
      apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "",
      authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "",
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "",
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "",
      messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "",
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "",
    }).toString();

    const swUrl = `/firebase-messaging-sw.js?${queryParams}`;

    navigator.serviceWorker
      .register(swUrl)
      .then(async (registration) => {
        // ── FCM token ────────────────────────────────────────────
        const { requestFCMToken } = await import("@/lib/firebase-messaging");
        const token = await requestFCMToken();
        if (token) {
          await fetch("/api/fcm/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ token }),
          });
        }

        // ── Background Sync: register sync tag when going offline ─
        // The SW fires "dechat-unread-sync" when network is restored,
        // even if the app tab is completely closed.
        function scheduleUnreadSync() {
          if ("sync" in registration) {
            (registration as any).sync.register("dechat-unread-sync").catch(
              (err: unknown) => console.warn("[FCM] Background sync registration failed:", err)
            );
          }
        }

        window.addEventListener("offline", scheduleUnreadSync);
        // Also register immediately in case we were already offline at startup
        if (!navigator.onLine) scheduleUnreadSync();

        return () => window.removeEventListener("offline", scheduleUnreadSync);
      })
      .catch((err) => console.warn("[FCM] SW registration / token fetch failed:", err));
  }, [session?.user?.id]);

  return (
    <div className="flex h-screen flex-col overflow-x-hidden bg-black text-neutral-200">
      <KeyStatusBanner />
      <GlobalRecoveryDialog />
      <GlobalUnlockDialog />
      {showKeygen && <KeygenDialog userId={session.user.id} onComplete={() => window.location.reload()} />}

      {!isRoomPage && (
        <header className="sticky top-0 z-40 border-b border-neutral-800/60 bg-black/95 backdrop-blur-sm">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
            {/* Logo */}
            <Link href="/" className="flex items-center gap-2 shrink-0">
              <Image src="/icons/dechat_logo_orig.png" alt="DeChat" width={24} height={24} />
              <span className="text-sm font-semibold tracking-[0.2em] text-white uppercase">
                DeChat
              </span>
            </Link>

            {/* Desktop Nav Links */}
            <nav className="hidden sm:flex items-center gap-0.5">
              {[
                { href: "/discover", label: "Discover" },
                { href: "/rooms/joined", label: "Joined" },
                { href: "/pending", label: "Requests" },
                { href: "/my-rooms", label: "My Rooms" },
              ].map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider rounded-md transition-all ${
                      active
                        ? "text-white bg-neutral-800"
                        : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            {/* Right: Profile avatar + sign out */}
            <div className="flex items-center gap-2">
              {!isPending && session?.user ? (
                <>
                  {/* Profile avatar/link — always in header */}
                  <Link
                    href="/profile"
                    className={`flex items-center gap-2 rounded-full px-2 py-1.5 transition-all hover:bg-neutral-900 ${
                      pathname === "/profile" ? "bg-neutral-900" : ""
                    }`}
                    title="Profile"
                  >
                    {pfp ? (
                      <img
                        src={pfp}
                        alt={userName ?? ""}
                        className="h-7 w-7 rounded-full object-cover ring-1 ring-neutral-700"
                      />
                    ) : (
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-800 ring-1 ring-neutral-700">
                        <User size={14} className="text-neutral-300" />
                      </div>
                    )}
                    <span className="hidden max-w-[120px] truncate text-xs text-neutral-400 md:inline">
                      {userName}
                    </span>
                  </Link>

                  {/* Sign out */}
                  <button
                    onClick={async () => {
                      await clearAllOutboxEntries();
                      signOut();
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-600 transition hover:bg-neutral-900 hover:text-neutral-300"
                    title="Sign out"
                  >
                    <LogOut size={15} />
                  </button>
                </>
              ) : (
                <Link href="/sign-in">
                  <Button variant="primary" size="sm" className="text-xs uppercase tracking-wider">
                    Sign in
                  </Button>
                </Link>
              )}
            </div>
          </div>
        </header>
      )}

      <main className={`flex-1 min-h-0 ${isLandingPage ? "overflow-y-auto" : isRoomPage ? "" : "overflow-y-auto pb-20 sm:pb-0"}`}>
        <GlobalSocketProvider>{children}</GlobalSocketProvider>
      </main>

      {/* Mobile footer nav — Profile removed, stays in header */}
      {!isRoomPage && session?.user && (
        <nav className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-neutral-800/60 bg-black/95 backdrop-blur-sm sm:hidden">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-1 flex-col items-center gap-1 py-3 text-[10px] uppercase tracking-wider transition-all ${
                  active ? "text-white" : "text-neutral-600 hover:text-neutral-400"
                }`}
              >
                <item.icon size={20} strokeWidth={active ? 2 : 1.5} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <KeyHealthProvider>
      <ShellContent>{children}</ShellContent>
    </KeyHealthProvider>
  );
}
