"use client";

import { ChevronDown, Loader2 } from "lucide-react";

interface DownArrowButtonProps {
  newMessagesCount: number;
  onClick: () => void;
  loading?: boolean;
}

export function DownArrowButton({
  newMessagesCount,
  onClick,
  loading,
}: DownArrowButtonProps) {
  return (
    <div className="absolute bottom-0 left-1/2 z-20 -translate-x-1/2 mb-4">
      <button
        onClick={onClick}
        disabled={loading}
        className="relative flex h-10 w-10 items-center justify-center rounded-full border border-neutral-850 bg-neutral-900 text-white shadow-lg hover:bg-neutral-800 hover:text-white transition disabled:opacity-70"
        aria-label="Scroll to bottom"
      >
        {loading ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <ChevronDown size={18} />
        )}
        {!loading && newMessagesCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-white border border-neutral-900 px-1 text-[9px] font-bold text-black shadow-sm">
            {newMessagesCount}
          </span>
        )}
      </button>
    </div>
  );
}
