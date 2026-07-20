"use client";

import { Reply, Pencil, Trash2, Copy } from "lucide-react";
import { useEffect, useRef } from "react";

interface MessageContextMenuProps {
  x: number;
  y: number;
  isOwn: boolean;
  canEdit: boolean;
  copyText?: string;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function MessageContextMenu({
  x,
  y,
  isOwn,
  canEdit,
  copyText,
  onReply,
  onEdit,
  onDelete,
  onClose,
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    // Delay to avoid the same click that opened the menu from closing it
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Clamp position to viewport
  const menuWidth = 180;
  const itemCount = (copyText ? 1 : 0) + 1 + (isOwn && canEdit ? 1 : 0) + (isOwn ? 1 : 0);
  const menuHeight = itemCount * 44;
  const clampedX = Math.min(x, window.innerWidth - menuWidth - 8);
  const clampedY = Math.min(y, window.innerHeight - menuHeight - 8);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 w-[180px] border border-neutral-700 bg-neutral-900 shadow-xl"
      style={{ left: clampedX, top: clampedY }}
    >
      <button
        role="menuitem"
        onClick={() => {
          if (copyText) {
            navigator.clipboard.writeText(copyText).catch(() => {});
          }
          onClose();
        }}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-xs uppercase tracking-wider text-neutral-300 hover:bg-neutral-800 transition-colors"
      >
        <Copy size={14} />
        Copy
      </button>

      <button
        role="menuitem"
        onClick={() => {
          onReply();
          onClose();
        }}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-xs uppercase tracking-wider text-neutral-300 hover:bg-neutral-800 transition-colors"
      >
        <Reply size={14} />
        Reply
      </button>

      {isOwn && canEdit && (
        <button
          role="menuitem"
          onClick={() => {
            onEdit();
            onClose();
          }}
          className="flex w-full items-center gap-3 px-4 py-2.5 text-xs uppercase tracking-wider text-neutral-300 hover:bg-neutral-800 transition-colors"
        >
          <Pencil size={14} />
          Edit
        </button>
      )}

      {isOwn && (
        <button
          role="menuitem"
          onClick={() => {
            onDelete();
            onClose();
          }}
          className="flex w-full items-center gap-3 px-4 py-2.5 text-xs uppercase tracking-wider text-red-400 hover:bg-neutral-800 transition-colors"
        >
          <Trash2 size={14} />
          Delete
        </button>
      )}
    </div>
  );
}
