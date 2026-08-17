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

  // Build items list
  const items: { label: string; icon: React.ElementType; onClick: () => void; danger?: boolean }[] = [];

  if (copyText) {
    items.push({
      label: "Copy",
      icon: Copy,
      onClick: () => {
        navigator.clipboard.writeText(copyText).catch(() => {});
        onClose();
      },
    });
  }

  items.push({
    label: "Reply",
    icon: Reply,
    onClick: () => {
      onReply();
      onClose();
    },
  });

  if (isOwn && canEdit) {
    items.push({
      label: "Edit",
      icon: Pencil,
      onClick: () => {
        onEdit();
        onClose();
      },
    });
  }

  if (isOwn) {
    items.push({
      label: "Delete",
      icon: Trash2,
      onClick: () => {
        onDelete();
        onClose();
      },
      danger: true,
    });
  }

  // Clamp position to viewport
  const menuWidth = 172;
  const itemHeight = 44;
  const menuHeight = items.length * itemHeight;
  const clampedX = Math.min(x, window.innerWidth - menuWidth - 8);
  const clampedY = Math.min(y, window.innerHeight - menuHeight - 8);

  return (
    <>
      {/* Dim overlay */}
      <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px]" onClick={onClose} />

      {/* Menu card */}
      <div
        ref={menuRef}
        role="menu"
        className="menu-animate fixed z-50 w-[172px] overflow-hidden rounded-2xl border border-neutral-700/50 bg-neutral-900/95 shadow-2xl backdrop-blur-sm"
        style={{ left: clampedX, top: clampedY }}
      >
        {items.map((item, idx) => (
          <button
            key={item.label}
            role="menuitem"
            onClick={item.onClick}
            className={`flex w-full items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-neutral-800 ${
              item.danger ? "text-red-400 hover:text-red-300" : "text-neutral-200 hover:text-white"
            } ${idx < items.length - 1 ? "border-b border-neutral-800/60" : ""}`}
          >
            <item.icon size={15} className={item.danger ? "text-red-400" : "text-neutral-400"} />
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
