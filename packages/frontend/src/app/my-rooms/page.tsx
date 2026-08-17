"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { useMyRooms } from "@/hooks/use-swr-hooks";

export default function MyRoomsPage() {
  const { data: session, isPending } = useSession();
  const { ownedRooms, isLoading, error: swrError, toggleRoomDisable } = useMyRooms("APPROVED");
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  async function handleToggleDisable(e: React.MouseEvent, roomId: string) {
    e.preventDefault();
    e.stopPropagation();
    setTogglingId(roomId);
    setActionError("");
    try {
      await toggleRoomDisable(roomId);
    } catch {
      setActionError("Failed to toggle room state");
    } finally {
      setTogglingId(null);
    }
  }

  if (isPending) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-xs uppercase tracking-wider text-neutral-600 animate-pulse">Loading...</p>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-sm text-neutral-500">Sign in to manage rooms.</p>
        <Link href="/sign-in" className="mt-4 inline-block text-xs uppercase tracking-wider text-white underline">Sign in</Link>
      </div>
    );
  }

  const displayError = actionError || (swrError instanceof Error ? swrError.message : "");

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      {/* Page header */}
      <div className="mb-6 rounded-2xl border border-neutral-800 bg-neutral-950 p-5 sm:p-6">
        <h1 className="text-xl font-semibold text-white sm:text-2xl">My Rooms</h1>
        <p className="mt-1 text-sm text-neutral-500">Manage rooms you own — disable, restore, or adjust settings.</p>
      </div>

      {displayError && (
        <div className="mb-4 rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-300">
          {displayError}
        </div>
      )}

      {isLoading ? (
        <div className="rounded-xl border border-neutral-900 bg-neutral-950 p-6">
          <p className="text-xs uppercase tracking-wider text-neutral-600 animate-pulse">Loading…</p>
        </div>
      ) : ownedRooms.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-800 px-6 py-16 text-center">
          <p className="text-sm text-neutral-500">You don&apos;t own any rooms yet.</p>
          <Link href="/" className="mt-4 inline-block text-xs uppercase tracking-wider text-white underline">Create one</Link>
        </div>
      ) : (
        <div className="space-y-4.5">
          {ownedRooms.map((r) => {
            const roomId = r.roomId;
            const isDisabled = Boolean(r.room?.isDisabled);
            return (
              <Link key={roomId} href={`/rooms/${roomId}`}>
                <div className="rounded-xl border border-neutral-900 bg-black p-4 hover:border-neutral-700 hover:bg-neutral-950 transition-all group">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold text-white">
                          {r.room?.name || "Unknown Room"}
                        </p>
                        {isDisabled && (
                          <span className="shrink-0 rounded-full bg-neutral-800 px-2 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400">
                            Disabled
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[10px] text-neutral-500">
                        {r.room?.memberCount ?? 0}/{r.room?.maxMembers ?? 500} members
                      </p>
                    </div>
                    <button
                      onClick={(e) => void handleToggleDisable(e, roomId)}
                      disabled={togglingId === roomId}
                      className={`shrink-0 rounded-full px-3 py-1.5 text-[10px] font-medium transition disabled:opacity-50 ${
                        isDisabled
                          ? "bg-white text-black hover:bg-neutral-200"
                          : "border border-neutral-700 text-neutral-400 hover:bg-neutral-800 hover:text-white"
                      }`}
                    >
                      {togglingId === roomId ? "..." : isDisabled ? "Restore" : "Disable"}
                    </button>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
