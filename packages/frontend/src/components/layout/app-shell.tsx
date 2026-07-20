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
import { Compass, Clock, List, Grid3X3, User } from "lucide-react";

const NAV_ITEMS = [
  { href: "/rooms/joined", label: "Joined", icon: List },
  { href: "/pending", label: "Requests", icon: Clock },
  { href: "/", label: "Discover", icon: Compass },
  { href: "/my-rooms", label: "My Rooms", icon: Grid3X3 },
  { href: "/profile", label: "Profile", icon: User },
];

function GlobalRecoveryDialog() {
  const { isRecoveryOpen, closeRecovery } = useKeyHealth();
  return <RecoveryDialog open={isRecoveryOpen} onClose={closeRecovery} context="banner" />;
}

function ShellContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: session, isPending } = useSession();
  const isAuthPage = ["/sign-in", "/sign-up", "/verify-email", "/forgot-password", "/reset-password"].includes(pathname);
  const isRoomPage = (pathname.startsWith("/rooms/") && !pathname.startsWith("/rooms/joined") && !pathname.startsWith("/my-rooms")) || isAuthPage;

  const showKeygen = session?.user && !isPending && !isAuthPage && !(session.user as any).encryptionEnabled;

  return (
    <div className="flex h-screen flex-col overflow-x-hidden bg-black text-neutral-200">
      <KeyStatusBanner />
      <GlobalRecoveryDialog />
      {showKeygen && (
        <KeygenDialog
          userId={session.user.id}
          onComplete={() => {
            window.location.reload();
          }}
        />
      )}

      {!isRoomPage && (
        <header className="sticky top-0 z-40 border-b border-neutral-800 bg-black/95 backdrop-blur-sm">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
            <Link href="/" className="flex items-center gap-2">
              <Image src="/icons/dechat_logo_orig.png" alt="DeChat" width={26} height={26} />
              <span className="text-sm font-semibold tracking-[0.2em] text-white uppercase">
                DeChat
              </span>
            </Link>

            <nav className="hidden sm:flex items-center gap-1">
              <Link
                href="/"
                className={`px-3 py-1.5 text-[10px] uppercase tracking-wider transition ${
                  pathname === "/" ? "text-white bg-neutral-900" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                Discover
              </Link>
              <Link
                href="/rooms/joined"
                className={`px-3 py-1.5 text-[10px] uppercase tracking-wider transition ${
                  pathname === "/rooms/joined" ? "text-white bg-neutral-900" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                Joined
              </Link>
              <Link
                href="/pending"
                className={`px-3 py-1.5 text-[10px] uppercase tracking-wider transition ${
                  pathname === "/pending" ? "text-white bg-neutral-900" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                Requests
              </Link>
              <Link
                href="/my-rooms"
                className={`px-3 py-1.5 text-[10px] uppercase tracking-wider transition ${
                  pathname === "/my-rooms" ? "text-white bg-neutral-900" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                My Rooms
              </Link>
            </nav>

            <div className="flex items-center gap-2">
              {!isPending && session?.user ? (
                <>
                  <span className="hidden max-w-[140px] truncate text-xs text-neutral-500 md:inline">
                    {session.user.name || session.user.email}
                  </span>
                  <Link href="/profile" className="hidden sm:inline">
                    <Button variant="ghost" size="sm" className="text-xs uppercase tracking-wider">
                      Profile
                    </Button>
                  </Link>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      await clearAllOutboxEntries();
                      signOut();
                    }}
                    className="text-xs uppercase tracking-wider"
                  >
                    Sign out
                  </Button>
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

      <main className={`flex-1 min-h-0 ${isRoomPage ? "" : "overflow-y-auto pb-20 sm:pb-0"}`}>{children}</main>

      {/* Mobile footer nav */}
      {!isRoomPage && session?.user && (
        <nav className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-neutral-800 bg-black sm:hidden">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-1 flex-col items-center gap-1 py-3 text-[11px] uppercase tracking-wider transition ${
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
