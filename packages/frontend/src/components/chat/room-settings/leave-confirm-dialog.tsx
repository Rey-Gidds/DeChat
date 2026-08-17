"use client";

import { Modal } from "./modal";
import { LogOut } from "lucide-react";

interface LeaveConfirmDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export function LeaveConfirmDialog({ onConfirm, onCancel, loading }: LeaveConfirmDialogProps) {
  return (
    <Modal title="Leave Room" subtitle="This action cannot be undone" onClose={onCancel} className="max-w-sm">
      <div className="p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/10 border border-red-500/20">
            <LogOut size={16} className="text-red-400" />
          </div>
          <p className="text-sm text-neutral-300 leading-relaxed">
            Are you sure you want to leave? You'll need to request access again.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="w-full rounded-xl border border-red-500/30 bg-red-500/10 py-2.5 text-xs font-semibold text-red-400 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Leaving..." : "Leave Room"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="w-full rounded-xl border border-neutral-800 py-2.5 text-xs font-medium text-neutral-400 transition hover:bg-neutral-900 hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
