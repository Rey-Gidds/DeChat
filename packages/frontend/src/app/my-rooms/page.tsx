"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

interface MyRoom {
  roomId: string;
  status: string;
  role: string;
  room: {
    _id?: string;
    id?: string;
    name: string;
    isDisabled?: boolean;
    maxMembers?: number;
    memberCount?: number;
  } | null;
}

export default function MyRoomsPage() {
  const { data: session, isPending } = useSession();
  const [rooms, setRooms] = useState<MyRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/rooms/mine?status=APPROVED", { credentials: "include" });
      const data = await res.json();
      const owned = (data.memberships ?? []).filter((m: MyRoom) => m.role === "OWNER");
      setRooms(owned);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isPending || !session?.user) return;
    void load();
  }, [isPending, session, load]);

  async function handleToggleDisable(roomId: string) {
    setTogglingId(roomId);
    try {
      const res = await fetch(`/api/rooms/${roomId}/disable`, {
        method: "PATCH",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed");
      await load();
    } catch {
      setError("Failed to toggle room state");
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
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-sm text-neutral-500">Sign in to manage rooms.</p>
        <Link href="/sign-in" className="mt-4 inline-block text-xs uppercase tracking-wider text-white underline">Sign in</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 border border-neutral-800 bg-neutral-950 p-5 sm:p-6">
        <p className="text-[10px] uppercase tracking-[0.25em] text-neutral-500">Dashboard</p>
        <h1 className="mt-2 text-2xl font-semibold text-white sm:text-3xl">My Rooms</h1>
        <p className="mt-2 text-sm text-neutral-500">Manage rooms you own — disable, restore, or adjust settings.</p>
      </div>

      {error && (
        <div className="mb-4 border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-300">{error}</div>
      )}

      {loading ? (
        <div className="border border-neutral-900 bg-neutral-950 p-6">
          <p className="text-xs uppercase tracking-wider text-neutral-600">Loading…</p>
        </div>
      ) : rooms.length === 0 ? (
        <div className="border border-dashed border-neutral-800 px-6 py-16 text-center">
          <p className="text-sm text-neutral-500">You don&apos;t own any rooms yet.</p>
          <Link href="/" className="mt-4 inline-block text-xs uppercase tracking-wider text-white underline">Create one</Link>
        </div>
      ) : (
        <div className="space-y-4">
          {rooms.map((r) => {
            const roomId = r.roomId;
            const isDisabled = Boolean(r.room?.isDisabled);
            return (
              <div key={roomId} className="border border-neutral-900 bg-black p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Link href={`/rooms/${roomId}`} className="truncate text-sm font-semibold text-white hover:underline">
                        {r.room?.name || "Unknown Room"}
                      </Link>
                      {isDisabled && (
                        <span className="shrink-0 border border-red-500/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-red-400">Disabled</span>
                      )}
                    </div>
                    <p className="mt-1 text-[10px] text-neutral-500">
                      {r.room?.memberCount ?? 0}/{r.room?.maxMembers ?? 500} members
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Link href={`/rooms/${roomId}`}>
                      <Button variant="secondary" size="sm" className="text-[10px]">Open</Button>
                    </Link>
                    <Button
                      variant={isDisabled ? "primary" : "ghost"}
                      size="sm"
                      disabled={togglingId === roomId}
                      onClick={() => void handleToggleDisable(roomId)}
                      className={`text-[10px] ${isDisabled ? "" : "border border-red-500/30 text-red-400 hover:border-red-500/60"}`}
                    >
                      {togglingId === roomId ? "..." : isDisabled ? "Restore" : "Disable"}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
