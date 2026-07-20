"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { Users } from "lucide-react";

interface JoinedRoom {
  roomId: string;
  status: string;
  joinedAt: string;
  role: string;
  room: {
    name: string;
    description?: string;
    joinPolicy?: string;
    maxMembers?: number;
    memberCount?: number;
    isDisabled?: boolean;
  } | null;
}

export default function JoinedRoomsPage() {
  const { data: session, isPending } = useSession();
  const [rooms, setRooms] = useState<JoinedRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isPending || !session?.user) return;
    setLoading(true);
    fetch("/api/rooms/mine?status=APPROVED", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        setRooms(data.memberships ?? []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [isPending, session]);

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
        <p className="text-sm text-neutral-500">Sign in to view your rooms.</p>
        <Link href="/sign-in" className="mt-4 inline-block text-xs uppercase tracking-wider text-white underline">Sign in</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 border border-neutral-800 bg-neutral-950 p-5 sm:p-6">
        <h1 className="mt-2 text-2xl font-semibold text-white sm:text-3xl">Joined Rooms</h1>
        <p className="mt-2 text-sm text-neutral-500">All rooms you&apos;re a member of.</p>
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
          <p className="text-sm text-neutral-500">You haven&apos;t joined any rooms yet.</p>
          <Link href="/" className="mt-4 inline-block text-xs uppercase tracking-wider text-white underline">Discover rooms</Link>
        </div>
      ) : (
        <div className="space-y-3">
          {rooms.map((r) => (
            <Link
              key={r.roomId}
              href={`/rooms/${r.roomId}`}
              className="flex items-center justify-between border border-neutral-900 bg-black p-4 hover:border-neutral-700 transition group"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-white group-hover:text-neutral-300 transition-colors">
                    {r.room?.name || "Unknown Room"}
                  </h3>
                  {r.room?.isDisabled && (
                    <span className="shrink-0 border border-red-500/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-red-400">Disabled</span>
                  )}
                </div>
                <p className="mt-0.5 text-[10px] text-neutral-500">
                  {r.role} · {r.room?.memberCount ?? 0}/{r.room?.maxMembers ?? 500} members
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
