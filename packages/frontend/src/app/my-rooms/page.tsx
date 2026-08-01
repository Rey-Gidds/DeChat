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
        <p className="text-xs uppercase tracking-wider text-neutral-600">Loading...</p>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="mx-auto max-w-[480px] px-4 py-16 text-center">
        <p className="text-sm text-neutral-500">Sign in to manage rooms.</p>
        <Link href="/sign-in" className="mt-4 inline-block text-xs uppercase tracking-wider text-white underline">Sign in</Link>
      </div>
    );
  }

  const displayError = actionError || (swrError instanceof Error ? swrError.message : "");

  return (
    <div className="mx-auto max-w-[480px] px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 border border-neutral-800 bg-neutral-950 p-5 sm:p-6">
        <h1 className="mt-2 text-2xl font-semibold text-white sm:text-3xl">My Rooms</h1>
        <p className="mt-2 text-sm text-neutral-500">Manage rooms you own — disable, restore, or adjust settings.</p>
      </div>

      {displayError && (
        <div className="mb-4 border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-300">{displayError}</div>
      )}

      {isLoading ? (
        <div className="border border-neutral-900 bg-neutral-950 p-6">
          <p className="text-xs uppercase tracking-wider text-neutral-600">Loading…</p>
        </div>
      ) : ownedRooms.length === 0 ? (
        <div className="border border-dashed border-neutral-800 px-6 py-16 text-center">
          <p className="text-sm text-neutral-500">You don&apos;t own any rooms yet.</p>
          <Link href="/" className="mt-4 inline-block text-xs uppercase tracking-wider text-white underline">Create one</Link>
        </div>
      ) : (
        <div className="space-y-4">
          {ownedRooms.map((r) => {
            const roomId = r.roomId;
            const isDisabled = Boolean(r.room?.isDisabled);
            return (
              <Link key={roomId} href={`/rooms/${roomId}`}>
                <div className="border border-neutral-900 bg-black p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold text-white hover:underline">
                          {r.room?.name || "Unknown Room"}
                        </p>
                        {isDisabled && (
                          <span className="shrink-0 border border-red-500/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-red-400">Disabled</span>
                        )}
                      </div>
                      <p className="mt-1 text-[10px] text-neutral-500">
                        {r.room?.memberCount ?? 0}/{r.room?.maxMembers ?? 500} members
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant={isDisabled ? "primary" : "ghost"}
                        size="sm"
                        disabled={togglingId === roomId}
                        onClick={(e) => void handleToggleDisable(e, roomId)}
                        className={`text-[10px] ${isDisabled ? "" : "border border-red-500/30 text-red-400 hover:border-red-500/60"}`}
                      >
                        {togglingId === roomId ? "..." : isDisabled ? "Restore" : "Disable"}
                      </Button>
                    </div>
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
