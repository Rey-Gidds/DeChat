"use client";

import { useCallback, useMemo, useState } from "react";
import { Modal } from "./modal";
import { DebounceSearch } from "./debounce-search";
import { Check } from "lucide-react";

export interface SuccessionMember {
  userId: string;
  role: string;
  user: { name?: string; email?: string } | null;
  userIndex?: number | null;
}

interface SuccessionDialogProps {
  members: SuccessionMember[];
  onConfirm: (promoteToAdmin: string[]) => void;
  onCancel: () => void;
  loading?: boolean;
}

function displayName(m: SuccessionMember) {
  return m.user?.name || m.user?.email || "Anonymous";
}

export function SuccessionDialog({ members, onConfirm, onCancel, loading }: SuccessionDialogProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (!query) return members;
    const q = query.toLowerCase();
    return members.filter((m) => displayName(m).toLowerCase().includes(q));
  }, [members, query]);

  const toggle = useCallback((userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  const handleSearch = useCallback((q: string) => setQuery(q), []);
  const canSubmit = selected.size > 0 && !loading;

  return (
    <Modal title="Transfer Responsibilities" subtitle="Promote a member before leaving" onClose={onCancel} className="max-w-sm">
      <p className="border-b border-neutral-800/60 px-4 py-3 text-xs text-neutral-500 leading-relaxed">
        You are the only admin. Select at least one member to promote before leaving.
      </p>
      <DebounceSearch placeholder="Search members..." onSearch={handleSearch} />
      <ul className="max-h-60 overflow-y-auto px-2 py-1 space-y-0.5">
        {filtered.length === 0 && (
          <li className="px-4 py-6 text-center text-xs text-neutral-600">No members found.</li>
        )}
        {filtered.map((m) => {
          const isChecked = selected.has(m.userId);
          return (
            <li key={m.userId}>
              <button
                type="button"
                onClick={() => toggle(m.userId)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left rounded-xl transition hover:bg-neutral-900"
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                    isChecked ? "border-white bg-white" : "border-neutral-700 bg-transparent"
                  }`}
                >
                  {isChecked && <Check size={10} className="text-black" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white">
                    {displayName(m)}
                    {m.userIndex != null && (
                      <span className="ml-1 text-neutral-500">#{m.userIndex}</span>
                    )}
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-neutral-600">{m.role}</p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-neutral-800/60 p-4 flex flex-col gap-2">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => onConfirm(Array.from(selected))}
          className="w-full rounded-xl border border-red-500/30 bg-red-500/10 py-2.5 text-xs font-semibold text-red-400 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? "Leaving..." : `Promote (${selected.size}) & Leave`}
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
    </Modal>
  );
}
