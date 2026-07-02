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
        className="relative flex h-10 w-10 items-center justify-center border border-[var(--border,#262626)] bg-[var(--surface-raised,#111111)] text-[var(--foreground,#e5e5e5)] hover:bg-neutral-800 transition-colors disabled:opacity-70"
        aria-label="Scroll to bottom"
      >
        {loading ? (
          <Loader2 size={18} className="animate-spin" />
        ) : (
          <ChevronDown size={20} />
        )}
        {!loading && newMessagesCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-[var(--surface-raised,#111111)] border border-[var(--border,#262626)] px-1 text-[10px] font-medium text-[var(--foreground,#e5e5e5)]">
            {newMessagesCount}
          </span>
        )}
      </button>
    </div>
  );
}
