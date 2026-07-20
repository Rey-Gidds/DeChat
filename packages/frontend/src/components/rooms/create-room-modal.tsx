"use client";

import { useState, useRef, useEffect } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { finalizeCreatorRoomKey } from "@/lib/room-membership-client";
import { useRouter } from "next/navigation";
import { useDebounce } from "@/hooks/use-debounce";
import { TrendingTags } from "@/components/trending-tags";

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

  // Close on outside click
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
      <span className="text-xs uppercase tracking-wider text-neutral-500">
        Tags {tags.length > 0 && <span className="text-neutral-600">({tags.length}/5)</span>}
      </span>
      {/* Selected tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-300">
              {t}
              <button onClick={() => remove(t)} className="text-neutral-600 hover:text-white" aria-label={`Remove ${t}`}>
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Trending / Most Used buttons */}
      {tags.length < 5 && (
        <div className="flex items-center gap-1.5">
          <TrendingTags onSelect={add} selectedTags={tags} direction="right" />
        </div>
      )}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        onKeyDown={handleKeyDown}
        disabled={tags.length >= 5}
        placeholder={tags.length >= 5 ? "Max 5 tags" : "Search or type a tag..."}
        className="w-full border border-neutral-800 bg-black px-3 py-2 text-sm text-white outline-none focus:border-neutral-500 disabled:opacity-40"
      />
      {/* Suggestions dropdown */}
      {open && suggestions.length > 0 && (
        <div className="absolute z-10 left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto border border-neutral-800 bg-neutral-950 shadow-xl">
          {loading && (
            <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-neutral-600">Searching...</div>
          )}
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="w-full px-3 py-2 text-left text-xs text-neutral-400 hover:bg-neutral-900 hover:text-white transition"
            >
              {s}
            </button>
          ))}
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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [maxMembers, setMaxMembers] = useState(500);
  const [joinPolicy, setJoinPolicy] = useState<"PUBLIC" | "PRIVATE">("PUBLIC");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, description, tags, joinPolicy, maxMembers }),
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
      onClose();
      router.push(`/rooms/${roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create room");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative w-full max-w-md border border-neutral-800 bg-neutral-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white">
            New room
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-white"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={(e) => void handleCreate(e)} className="space-y-4 p-4">
          <label className="block space-y-1.5">
            <span className="text-xs uppercase tracking-wider text-neutral-500">Name</span>
            <input
              required
              minLength={3}
              maxLength={50}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-neutral-800 bg-black px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500"
              placeholder="general"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs uppercase tracking-wider text-neutral-500">
              Description
            </span>
            <textarea
              maxLength={200}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full resize-none border border-neutral-800 bg-black px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500"
              placeholder="What is this room about?"
            />
          </label>

          <TagSelector tags={tags} onChange={setTags} />

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1.5">
              <span className="text-xs uppercase tracking-wider text-neutral-500">
                Max members
              </span>
              <input
                type="number"
                min={2}
                max={50000}
                value={maxMembers}
                onChange={(e) => setMaxMembers(Number(e.target.value))}
                className="w-full border border-neutral-800 bg-black px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs uppercase tracking-wider text-neutral-500">
                Room type
              </span>
              <select
                value={joinPolicy}
                onChange={(e) => setJoinPolicy(e.target.value as typeof joinPolicy)}
                className="w-full border border-neutral-800 bg-black px-3 py-2.5 text-sm text-white outline-none focus:border-neutral-500"
              >
                <option value="PUBLIC">Public</option>
                <option value="PRIVATE">Private</option>
              </select>
            </label>
          </div>

          {error && (
            <p className="border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
              {error}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={loading || !name.trim()}
            className="w-full uppercase tracking-wider"
          >
            {loading ? "Creating..." : "Create & enter"}
          </Button>
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
      className="fixed bottom-24 right-6 z-50 flex h-14 w-14 items-center justify-center border border-neutral-700 bg-white text-black shadow-lg transition hover:bg-neutral-200 sm:bottom-8 sm:right-8"
      aria-label="Create room"
    >
      <Plus size={22} strokeWidth={2.5} />
    </button>
  );
}
