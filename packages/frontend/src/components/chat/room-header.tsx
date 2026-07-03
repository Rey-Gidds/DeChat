"use client";

import { ArrowLeft, Menu, X } from "lucide-react";
import Link from "next/link";

interface RoomHeaderProps {
  roomName: string;
  memberCount: number;
  status: string;
  showOptions: boolean;
  onToggleOptions: () => void;
}

export function RoomHeader({
  roomName,
  memberCount,
  status,
  showOptions,
  onToggleOptions,
}: RoomHeaderProps) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-neutral-800 bg-black px-3 py-3 sm:px-4">
      <Link
        href="/"
        className="flex h-9 w-9 shrink-0 items-center justify-center border border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white"
        aria-label="Back to discovery"
      >
        <ArrowLeft size={18} />
      </Link>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold text-white">{roomName}</h1>
        <p className="truncate text-[11px] text-neutral-500">
          {status} · {memberCount} members
        </p>
      </div>

      <button
        type="button"
        onClick={onToggleOptions}
        className="flex h-9 w-9 shrink-0 items-center justify-center border border-neutral-800 text-neutral-400 transition hover:border-neutral-600 hover:text-white"
        aria-label={showOptions ? "Close options" : "Open options"}
      >
        {showOptions ? <X size={18} /> : <Menu size={18} />}
      </button>
    </header>
  );
}
