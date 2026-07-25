"use client";

import Link from "next/link";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatUnreadBadge } from "@/lib/unread-store";

export interface DiscoveryRoom {
  _id?: string;
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  maxMembers?: number;
  memberCount?: number;
  onlineCount?: number;
  membershipStatus?: string | null;
  joinPolicy?: string;
  isDisabled?: boolean;
}

export interface RoomCardProps {
  room: DiscoveryRoom;
  onJoin?: (roomId: string) => void;
  joiningId?: string | null;
  unreadCount?: number;
  isTyping?: boolean;
  typingText?: string;
  lastSystemMessage?: string;
  role?: string;
  href?: string;
}

export function RoomCard({
  room,
  onJoin,
  joiningId,
  unreadCount = 0,
  isTyping = false,
  typingText = "typing...",
  lastSystemMessage,
  role,
  href,
}: RoomCardProps) {
  const roomId = room.id ?? room._id?.toString() ?? "";
  const memberCount = room.memberCount ?? 0;
  const onlineCount = room.onlineCount ?? 0;
  const status = room.membershipStatus;
  const isJoining = joiningId === roomId;
  const destinationHref = href || `/rooms/${roomId}`;

  function actionLabel() {
    if (status === "APPROVED") return "Open";
    if (status === "PENDING") return "Pending";
    return "Request access";
  }

  function handleAction() {
    if (status === "APPROVED") return;
    if (status === "PENDING") return;
    if (onJoin) onJoin(roomId);
  }

  return (
    <article className="relative flex flex-col border border-neutral-800 bg-neutral-950 p-4 transition hover:border-neutral-600 group">
      {/* Header section with room name, typing status, policy & WhatsApp-style unread badge */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="truncate text-sm font-semibold text-white group-hover:text-neutral-200 transition-colors">
              {room.name}
            </h3>

            {/* Bold white typing... beside room name */}
            {isTyping && (
              <span className="text-xs font-bold text-white animate-pulse shrink-0">
                typing...
              </span>
            )}

            {room.isDisabled && (
              <span className="shrink-0 border border-red-500/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-red-400">
                Disabled
              </span>
            )}
          </div>

          {/* Message Preview / System Message / Description */}
          {isTyping ? (
            <p className="mt-1 text-xs font-bold text-white line-clamp-1 animate-pulse">
              {typingText || "typing..."}
            </p>
          ) : lastSystemMessage ? (
            <p className="mt-1 text-xs text-neutral-300 line-clamp-1 italic">
              {lastSystemMessage}
            </p>
          ) : room.description ? (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-neutral-500">
              {room.description}
            </p>
          ) : null}
        </div>

        {/* Right side: Unread Badge (WhatsApp style minimal white box with black number) & Policy tag */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {unreadCount > 0 && (
            <span className="bg-white text-black font-bold text-xs px-2 py-0.5 rounded min-w-[24px] h-[20px] flex items-center justify-center text-center shadow-md">
              {formatUnreadBadge(unreadCount)}
            </span>
          )}
          {room.joinPolicy && (
            <span className="border border-neutral-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
              {room.joinPolicy.replaceAll("_", " ")}
            </span>
          )}
        </div>
      </div>

      {/* Tags */}
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

      {/* Footer section with online/total members display & Action Button */}
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-neutral-900 pt-3">
        <div className="flex items-center gap-1.5 text-xs text-neutral-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <Users size={14} className="text-neutral-500" />
          <span className="font-mono text-neutral-300 font-medium">
            {onlineCount}/{memberCount}
          </span>
        </div>

        {role && (
          <span className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono">
            {role}
          </span>
        )}

        {status === "APPROVED" || !onJoin ? (
          <Link href={destinationHref}>
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
