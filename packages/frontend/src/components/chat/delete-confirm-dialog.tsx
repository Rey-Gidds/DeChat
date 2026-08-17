"use client";

import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";

interface DeleteConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmDialog({
  open,
  onConfirm,
  onCancel,
}: DeleteConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-[300px] rounded-2xl border border-neutral-800/80 bg-neutral-950 p-5 shadow-2xl"
      >
        <div className="flex items-center gap-3 mb-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500/10 border border-red-500/20">
            <Trash2 size={15} className="text-red-400" />
          </div>
          <h3 className="text-sm font-semibold text-white">Delete message?</h3>
        </div>
        <p className="text-xs leading-relaxed text-neutral-400 mb-5">
          This message will be permanently removed. This action cannot be undone.
        </p>

        <div className="flex gap-2.5">
          <button
            onClick={onCancel}
            className="flex-1 rounded-xl border border-neutral-800 py-2.5 text-xs font-medium text-neutral-400 transition hover:bg-neutral-900 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-xl bg-red-500/10 border border-red-500/30 py-2.5 text-xs font-semibold text-red-400 transition hover:bg-red-500/20 hover:text-red-300"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
