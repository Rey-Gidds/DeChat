"use client";

import Link from "next/link";
import { useEffect, useCallback, useState } from "react";
import { useSession } from "@/lib/auth-client";
import { useMyRooms } from "@/hooks/use-swr-hooks";
import { useGlobalSocket } from "@/lib/global-socket-context";
import { useUnreadStore } from "@/lib/unread-store";
import { RoomCard } from "@/components/rooms/room-card";

export default function JoinedRoomsPage() {
  const { data: session, isPending } = useSession();
  const { memberships: rooms, isLoading, error: swrError, mutateMyRooms } = useMyRooms("APPROVED");
  const { socket } = useGlobalSocket();
  const { counts, increment, clear: clearUnread } = useUnreadStore();
  const [typingMap, setTypingMap] = useState<Record<string, boolean>>({});

  // ── Global socket event listeners ───────────────────────────

  const revalidate = useCallback(() => {
    void mutateMyRooms();
  }, [mutateMyRooms]);

  useEffect(() => {
    if (!socket) return;

    const onUnreadIncrement = (payload: { roomId: string }) => {
      void increment(payload.roomId);
      revalidate();
    };

    const onRoomDeleted = (payload: { roomId: string }) => {
      void clearUnread(payload.roomId);
      revalidate();
    };

    const onMemberKicked = (payload: { roomId: string }) => {
      void clearUnread(payload.roomId);
      revalidate();
    };

    const onMemberLeft = (payload: { roomId: string }) => {
      void clearUnread(payload.roomId);
      revalidate();
    };

    const onMemberJoined = () => {
      revalidate();
    };

    const onTypingStarted = (payload: { roomId: string }) => {
      if (!payload?.roomId) return;
      setTypingMap((prev) => ({ ...prev, [payload.roomId]: true }));
    };

    const onTypingStopped = (payload: { roomId: string }) => {
      if (!payload?.roomId) return;
      setTypingMap((prev) => ({ ...prev, [payload.roomId]: false }));
    };

    socket.on("user_unread_increment", onUnreadIncrement);
    socket.on("room_deleted", onRoomDeleted);
    socket.on("room_member_kicked", onMemberKicked);
    socket.on("room_member_left", onMemberLeft);
    socket.on("room_member_joined", onMemberJoined);
    socket.on("typing_started", onTypingStarted);
    socket.on("typing_stopped", onTypingStopped);

    return () => {
      socket.off("user_unread_increment", onUnreadIncrement);
      socket.off("room_deleted", onRoomDeleted);
      socket.off("room_member_kicked", onMemberKicked);
      socket.off("room_member_left", onMemberLeft);
      socket.off("room_member_joined", onMemberJoined);
      socket.off("typing_started", onTypingStarted);
      socket.off("typing_stopped", onTypingStopped);
    };
  }, [socket, revalidate, increment, clearUnread]);

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

  const error = swrError instanceof Error ? swrError.message : "";

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 border border-neutral-800 bg-neutral-950 p-5 sm:p-6">
        <h1 className="mt-2 text-2xl font-semibold text-white sm:text-3xl">Joined Rooms</h1>
        <p className="mt-2 text-sm text-neutral-500">All rooms you&apos;re a member of.</p>
      </div>

      {error && (
        <div className="mb-4 border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-300">{error}</div>
      )}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-44 animate-pulse border border-neutral-900 bg-neutral-950" />
          ))}
        </div>
      ) : rooms.length === 0 ? (
        <div className="border border-dashed border-neutral-800 px-6 py-16 text-center">
          <p className="text-sm text-neutral-500">You haven&apos;t joined any rooms yet.</p>
          <Link href="/" className="mt-4 inline-block text-xs uppercase tracking-wider text-white underline">Discover rooms</Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rooms.map((r) => {
            const unread = counts[r.roomId] ?? 0;
            const isTyping = Boolean(typingMap[r.roomId]);
            return (
              <RoomCard
                key={r.roomId}
                room={{
                  id: r.roomId,
                  name: r.room?.name || "Unknown Room",
                  description: r.room?.description,
                  memberCount: r.room?.memberCount ?? 1,
                  maxMembers: r.room?.maxMembers ?? 500,
                  onlineCount: r.room?.onlineCount ?? 0,

                  joinPolicy: r.room?.joinPolicy,
                  isDisabled: r.room?.isDisabled,
                  membershipStatus: "APPROVED",
                }}
                unreadCount={unread}
                isTyping={isTyping}
                role={r.role}
                href={`/rooms/${r.roomId}`}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
