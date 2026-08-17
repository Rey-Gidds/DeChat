"use client";

import Link from "next/link";
import { Users, ChevronRight } from "lucide-react";
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
  showDescription?: boolean;
}

// Animated typing dots
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-[3px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-400"
          style={{
            animation: `typingBounce 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

export function RoomCard({
  room,
  onJoin,
  joiningId,
  unreadCount = 0,
  isTyping = false,
  typingText = "typing",
  lastSystemMessage,
  role,
  href,
  showDescription = false,
}: RoomCardProps) {
  const roomId = room.id ?? room._id?.toString() ?? "";
  const memberCount = room.memberCount ?? 0;
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
    <article className="relative flex flex-col rounded-2xl border border-neutral-800/80 bg-neutral-950 p-4 transition-all hover:border-neutral-700 hover:bg-neutral-900 group">
      {/* Header row: name + unread badge */}
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="truncate text-sm font-semibold text-white group-hover:text-neutral-100 transition-colors">
              {room.name}
            </h3>

            {room.isDisabled && (
              <span className="shrink-0 rounded-full bg-neutral-800 px-2 py-0.5 text-[9px] uppercase tracking-wider text-neutral-500">
                Disabled
              </span>
            )}
          </div>

          {/* Preview area: typing indicator OR system message OR description */}
          <div className="mt-1.5 flex items-center gap-1.5 min-h-[18px]">
            {isTyping ? (
              <>
                <TypingDots />
                <span className="text-xs text-neutral-400">{typingText}</span>
              </>
            ) : lastSystemMessage ? (
              <p className="text-xs text-neutral-500 line-clamp-1 italic">
                {lastSystemMessage}
              </p>
            ) : (showDescription && room.description) ? (
              <p className="text-xs text-neutral-600 line-clamp-1">
                {room.description}
              </p>
            ) : null}
          </div>
        </div>

        {/* Right side: unread badge + join policy */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {unreadCount > 0 && (
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-white px-1.5 text-[11px] font-bold text-black shadow-sm">
              {formatUnreadBadge(unreadCount)}
            </span>
          )}
          {room.joinPolicy && (
            <span className="rounded-full border border-neutral-800 px-2 py-0.5 text-[9px] uppercase tracking-wider text-neutral-600">
              {room.joinPolicy.replaceAll("_", " ")}
            </span>
          )}
        </div>
      </div>

      {/* Tags */}
      {room.tags && room.tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {room.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-neutral-800 bg-black px-2 py-0.5 text-[10px] text-neutral-500"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Footer: member count + role + action */}
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-neutral-800/50 pt-3">
        <div className="flex items-center gap-1.5 text-xs text-neutral-500">
          <Users size={13} className="text-neutral-600" />
          <span className="font-medium text-neutral-400">{memberCount}</span>
        </div>

        {status === "APPROVED" || !onJoin ? (
          <Link href={destinationHref} className="flex items-center justify-center p-1 rounded-full hover:bg-neutral-800 transition-colors">
            <ChevronRight size={18} className="text-neutral-400" />
          </Link>
        ) : (
          <Button
            variant={status === "PENDING" ? "ghost" : "secondary"}
            size="sm"
            disabled={status === "PENDING" || isJoining}
            onClick={handleAction}
            className="min-w-[64px] rounded-full text-xs font-medium"
          >
            {isJoining ? "..." : actionLabel()}
          </Button>
        )}
      </div>
    </article>
  );
}
