"use client";

import { useState, useRef, useEffect } from "react";
import { Plus, X, Globe, Lock } from "lucide-react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { finalizeCreatorRoomKey } from "@/lib/room-membership-client";
import { useRouter } from "next/navigation";
import { useDebounce } from "@/hooks/use-debounce";
import { TrendingTags } from "@/components/trending-tags";
import { useSWRConfig } from "swr";

interface CreateRoomModalProps {
  open: boolean;
  onClose: () => void;
  userId: string;
  publicKey: string | null;
  onEnsureKeys?: () => Promise<string>;
}

function TagSelector({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debouncedQuery = useDebounce(query, 300);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/tags?q=${encodeURIComponent(debouncedQuery)}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          const filtered = (data.tags as string[]).filter(
            (t) => !tags.includes(t) && t !== query.trim().toLowerCase()
          );
          setSuggestions(filtered.slice(0, 8));
          setOpen(filtered.length > 0);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [debouncedQuery, tags]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function add(tag: string) {
    const normalized = tag.toLowerCase().trim();
    if (tags.includes(normalized) || tags.length >= 5) return;
    onChange([...tags, normalized]);
    setQuery("");
    setOpen(false);
  }

  function remove(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = query.trim();
      if (!val) return;
      if (tags.length >= 5) return;
      const normalized = val.toLowerCase();
      if (!tags.includes(normalized)) {
        onChange([...tags, normalized]);
      }
      setQuery("");
      setOpen(false);
    }
    if (e.key === "Backspace" && !query && tags.length > 0) {
      remove(tags[tags.length - 1]);
    }
  }

  return (
    <div ref={ref} className="relative space-y-1.5">
      <span className="text-[11px] font-medium text-neutral-400">
        Tags {tags.length > 0 && <span className="text-neutral-500">({tags.length}/5)</span>}
      </span>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-200">
              {t}
              <button onClick={() => remove(t)} className="text-neutral-500 hover:text-white" aria-label={`Remove ${t}`}>
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {tags.length < 5 && (
        <div className="flex items-center gap-1.5">
          <TrendingTags onSelect={add} selectedTags={tags} direction="right" />
        </div>
      )}
    </div>
  );
}

export function CreateRoomModal({
  open,
  onClose,
  userId,
  publicKey,
  onEnsureKeys,
}: CreateRoomModalProps) {
  const router = useRouter();
  const { mutate: globalMutate } = useSWRConfig();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [maxMembers, setMaxMembers] = useState(10);
  const [joinPolicy, setJoinPolicy] = useState<"PUBLIC" | "PRIVATE">("PUBLIC");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name,
          description,
          tags,
          maxMembers,
          joinPolicy,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Failed to create room");
      }

      const roomId = data.room._id?.toString?.() ?? data.room.id;
      if (!roomId) throw new Error("Room id missing from response");

      const activePublicKey = publicKey || (onEnsureKeys ? await onEnsureKeys() : "");
      if (!activePublicKey) {
        throw new Error("Encryption keys are not available yet.");
      }

      await finalizeCreatorRoomKey(roomId, userId, activePublicKey);
      void globalMutate((k) => typeof k === "string" && k.startsWith("/api/rooms"));
      onClose();
      router.push(`/rooms/${roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create room");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative w-full max-w-sm rounded-3xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl overflow-hidden z-10 flex flex-col gap-4">
        {/* Title & Close button */}
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-white leading-tight">Create Room</h2>
            <p className="text-xs text-neutral-400 mt-0.5">Create a new encrypted room.</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-900 hover:text-white transition"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={(e) => void handleCreate(e)} className="space-y-4">
          {/* Room Name */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-neutral-400">Room Name</label>
            <input
              required
              minLength={3}
              maxLength={50}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 text-xs text-white outline-none placeholder:text-neutral-600 focus:border-neutral-600 transition"
              placeholder="Enter room name"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <div className="flex justify-between items-center text-[11px] text-neutral-400">
              <span>Description (optional)</span>
            </div>
            <div className="relative">
              <textarea
                maxLength={120}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="w-full resize-none rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 text-xs text-white outline-none placeholder:text-neutral-600 focus:border-neutral-600 transition"
                placeholder="Tell others what your room is about"
              />
              <span className="absolute right-3 bottom-2.5 text-[10px] text-neutral-500">
                {description.length}/120
              </span>
            </div>
          </div>

          {/* Tags */}
          <TagSelector tags={tags} onChange={setTags} />

          {/* Room Type Options */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-neutral-400">Room Type</label>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setJoinPolicy("PUBLIC")}
                className={`flex items-center justify-center gap-2 rounded-xl py-2.5 px-3 border text-xs font-medium transition ${
                  joinPolicy === "PUBLIC"
                    ? "bg-neutral-800 border-neutral-600 text-white shadow-sm"
                    : "bg-neutral-900 border-neutral-800 text-neutral-400 hover:bg-neutral-850"
                }`}
              >
                <Globe size={14} />
                <span>Public</span>
              </button>

              <button
                type="button"
                onClick={() => setJoinPolicy("PRIVATE")}
                className={`flex items-center justify-center gap-2 rounded-xl py-2.5 px-3 border text-xs font-medium transition ${
                  joinPolicy === "PRIVATE"
                    ? "bg-neutral-800 border-neutral-600 text-white shadow-sm"
                    : "bg-neutral-900 border-neutral-800 text-neutral-400 hover:bg-neutral-850"
                }`}
              >
                <Lock size={14} />
                <span>Private</span>
              </button>
            </div>
          </div>

          {/* Max Members */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-neutral-400">Max Members</label>
            <input
              type="number"
              min={2}
              max={500}
              value={maxMembers}
              onChange={(e) => setMaxMembers(Number(e.target.value))}
              placeholder="e.g. 10"
              className="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 text-xs text-white outline-none focus:border-neutral-600 transition"
            />
          </div>

          {error && (
            <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="w-full rounded-2xl bg-white text-black font-semibold py-3 transition-all hover:bg-neutral-200 disabled:opacity-40 text-xs shadow"
          >
            {loading ? "Creating Room..." : "Create Room"}
          </button>
        </form>
      </div>
    </div>
  );
}

interface FabCreateRoomProps {
  onClick: () => void;
}

export function FabCreateRoom({ onClick }: FabCreateRoomProps) {
  return (
    <button
      onClick={onClick}
      className="fixed bottom-20 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-white text-black shadow-xl transition hover:bg-neutral-200 active:scale-95 sm:bottom-8 sm:right-8"
      aria-label="Create room"
    >
      <Plus size={22} strokeWidth={2.5} />
    </button>
  );
}
