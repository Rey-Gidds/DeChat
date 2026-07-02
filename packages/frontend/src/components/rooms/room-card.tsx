"use client";

import Link from "next/link";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface DiscoveryRoom {
  _id?: string;
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  maxMembers?: number;
  memberCount?: number;
  membershipStatus?: string | null;
  joinPolicy?: string;
}

interface RoomCardProps {
  room: DiscoveryRoom;
  onJoin: (roomId: string) => void;
  joiningId: string | null;
}

export function RoomCard({ room, onJoin, joiningId }: RoomCardProps) {
  const roomId = room.id ?? room._id?.toString() ?? "";
  const memberCount = room.memberCount ?? 0;
  const status = room.membershipStatus;
  const isJoining = joiningId === roomId;

  function actionLabel() {
    if (status === "APPROVED") return "Open";
    if (status === "PENDING") return "Pending";
    return "Request access";
  }

  function handleAction() {
    if (status === "APPROVED") return;
    if (status === "PENDING") return;
    onJoin(roomId);
  }

  return (
    <article className="flex flex-col border border-neutral-800 bg-neutral-950 p-4 transition hover:border-neutral-600">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-white">{room.name}</h3>
          {room.description && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-neutral-500">
              {room.description}
            </p>
          )}
        </div>
        <span className="shrink-0 border border-neutral-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
          {(room.joinPolicy ?? "PUBLIC").replaceAll("_", " ")}
        </span>
      </div>

      {room.tags && room.tags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {room.tags.map((tag) => (
            <span
              key={tag}
              className="border border-neutral-800 bg-black px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-neutral-900 pt-3">
        <div className="flex items-center gap-1.5 text-xs text-neutral-500">
          <Users size={14} />
          <span>
            {memberCount}/{room.maxMembers ?? 500}
          </span>
        </div>

        {status === "APPROVED" ? (
          <Link href={`/rooms/${roomId}`}>
            <Button variant="primary" size="sm" className="min-w-[72px] uppercase tracking-wider">
              Open
            </Button>
          </Link>
        ) : (
          <Button
            variant={status === "PENDING" ? "ghost" : "secondary"}
            size="sm"
            disabled={status === "PENDING" || isJoining}
            onClick={handleAction}
            className="min-w-[72px] uppercase tracking-wider"
          >
            {isJoining ? "..." : actionLabel()}
          </Button>
        )}
      </div>
    </article>
  );
}
