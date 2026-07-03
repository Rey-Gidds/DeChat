"use client";

import { Modal } from "./modal";

interface LeaveConfirmDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export function LeaveConfirmDialog({ onConfirm, onCancel, loading }: LeaveConfirmDialogProps) {
  return (
    <Modal title="Leave Room" onClose={onCancel} className="max-w-sm">
      <div className="p-5">
        <p className="text-sm text-neutral-400">
          Are you sure you want to leave this room? You will need to request to join again.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="w-full border border-red-500/40 bg-red-950/30 py-2.5 text-xs font-medium uppercase tracking-wider text-red-400 transition hover:bg-red-950/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Leaving..." : "Leave Room"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="w-full border border-neutral-800 py-2.5 text-xs uppercase tracking-wider text-neutral-400 transition hover:border-neutral-600 hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
