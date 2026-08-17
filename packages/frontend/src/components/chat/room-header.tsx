"use client";

import { ArrowLeft, MoreHorizontal, X } from "lucide-react";
import Link from "next/link";

interface RoomHeaderProps {
  roomName: string;
  memberCount?: number;
  showOptions: boolean;
  onToggleOptions: () => void;
}

export function RoomHeader({
  roomName,
  memberCount,
  showOptions,
  onToggleOptions,
}: RoomHeaderProps) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-neutral-800/60 bg-[#0d0d0d] px-3 py-2.5 sm:px-4">
      {/* Back button */}
      <Link
        href="/"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-800/80 text-neutral-400 transition hover:bg-neutral-700 hover:text-white"
        aria-label="Back to discovery"
      >
        <ArrowLeft size={18} />
      </Link>

      {/* Room name + member count */}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold text-white leading-tight">{roomName}</h1>
        {memberCount != null && (
          <p className="text-[10px] text-neutral-500 leading-tight">
            {memberCount} {memberCount === 1 ? "member" : "members"}
          </p>
        )}
      </div>

      {/* Options toggle */}
      <button
        type="button"
        onClick={onToggleOptions}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-800/80 text-neutral-400 transition hover:bg-neutral-700 hover:text-white"
        aria-label={showOptions ? "Close options" : "Open options"}
      >
        {showOptions ? <X size={18} /> : <MoreHorizontal size={18} />}
      </button>
    </header>
  );
}
