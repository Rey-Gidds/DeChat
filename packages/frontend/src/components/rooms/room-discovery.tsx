"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { requestJoinRoom } from "@/lib/room-membership-client";
import { RoomCard, type DiscoveryRoom } from "./room-card";
import { CreateRoomModal, FabCreateRoom } from "./create-room-modal";
import { TrendingTags } from "@/components/trending-tags";


import { generateUserKeyPair, exportPublicKey, savePrivateKey } from "@/lib/crypto";

import { useUnreadStore } from "@/lib/unread-store";
import { useGlobalSocket } from "@/lib/global-socket-context";

interface MeProfile {
  id: string;
  publicKey: string | null;
}


function TagFilter({
  selectedTags,
  onChange,
}: {
  selectedTags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const debouncedQuery = useDebounce(query, 300);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch suggestions from the server
  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    fetch(`/api/tags?q=${encodeURIComponent(debouncedQuery)}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          const filtered = (data.tags as string[]).filter(
            (t) => !selectedTags.includes(t) && t.includes(debouncedQuery.trim().toLowerCase())
          );
          setSuggestions(filtered.slice(0, 10));
          setOpen(filtered.length > 0);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [debouncedQuery, selectedTags]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function add(tag: string) {
    if (!selectedTags.includes(tag)) {
      onChange([...selectedTags, tag]);
    }
    setQuery("");
    setOpen(false);
  }

  function remove(tag: string) {
    onChange(selectedTags.filter((t) => t !== tag));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = query.trim().toLowerCase();
      if (val && !selectedTags.includes(val)) {
        onChange([...selectedTags, val]);
      }
      setQuery("");
      setOpen(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <div className="flex flex-wrap items-center gap-1.5">
        {selectedTags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 border border-white bg-white px-2 py-1 text-[10px] uppercase tracking-wider text-black"
          >
            {t}
            <button onClick={() => remove(t)} className="hover:opacity-60" aria-label={`Remove ${t}`}>
              <X size={10} strokeWidth={3} />
            </button>
          </span>
        ))}
        <div className="relative flex-1 min-w-[140px]">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
            onKeyDown={handleKeyDown}
            placeholder={selectedTags.length === 0 ? "Search or type tags..." : "Add more..."}
            className="w-full border border-neutral-800 bg-black px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600"
          />
          {open && suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto border border-neutral-800 bg-neutral-950 shadow-xl">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => add(s)}
                  className="w-full px-3 py-2 text-left text-[10px] uppercase tracking-wider text-neutral-400 hover:bg-neutral-900 hover:text-white transition"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function RoomDiscovery() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const debouncedSearch = useDebounce(search, 350);
  const debouncedTags = useDebounce(selectedTags, 350);
  const [rooms, setRooms] = useState<DiscoveryRoom[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [profile, setProfile] = useState<MeProfile | null>(null);
  const [isGeneratingKeys, setIsGeneratingKeys] = useState(false);

  const { counts, timestamps } = useUnreadStore();
  const { socket } = useGlobalSocket();
  const [typingMap, setTypingMap] = useState<Record<string, boolean>>({});

  const sortedRooms = useMemo(() => {
    return rooms.slice().sort((a, b) => {
      const idA = a.id ?? a._id?.toString() ?? "";
      const idB = b.id ?? b._id?.toString() ?? "";
      const tsA = timestamps[idA] ?? 0;
      const tsB = timestamps[idB] ?? 0;
      if (tsA !== tsB) {
        return tsB - tsA;
      }
      const unreadA = counts[idA] ?? 0;
      const unreadB = counts[idB] ?? 0;
      return unreadB - unreadA;
    });
  }, [rooms, counts, timestamps]);

  useEffect(() => {
    if (!socket) return;
    const onTypingStarted = (p: { roomId: string }) => {
      if (p?.roomId) setTypingMap((prev) => ({ ...prev, [p.roomId]: true }));
    };
    const onTypingExpired = (p: { roomId: string }) => {
      if (p?.roomId) setTypingMap((prev) => ({ ...prev, [p.roomId]: false }));
    };
    socket.on("typing_started", onTypingStarted);
    socket.on("typing_expired", onTypingExpired);
    // Backward compat
    socket.on("typing_stopped", onTypingExpired);
    return () => {
      socket.off("typing_started", onTypingStarted);
      socket.off("typing_expired", onTypingExpired);
      socket.off("typing_stopped", onTypingExpired);
    };
  }, [socket]);

  function addTag(tag: string) {

    if (!selectedTags.includes(tag)) {
      setSelectedTags([...selectedTags, tag]);
    }
  }

  const fetchRooms = useCallback(
    async (cursor?: string, append = false) => {
      if (append) setLoadingMore(true);
      else setLoading(true);

      try {
        const params = new URLSearchParams({ limit: "12" });
        if (debouncedSearch) params.set("search", debouncedSearch);
        if (debouncedTags.length > 0) params.set("tags", debouncedTags.join(","));
        if (cursor) params.set("cursor", cursor);

        const res = await fetch(`/api/rooms?${params.toString()}`, {
          credentials: "include",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load rooms");

        setRooms((prev) =>
          append ? [...prev, ...(data.rooms as DiscoveryRoom[])] : (data.rooms as DiscoveryRoom[])
        );
        setNextCursor(data.nextCursor ?? null);
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load rooms");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [debouncedSearch, debouncedTags]
  );

  useEffect(() => {
    void fetchRooms();
  }, [fetchRooms]);

  const loadProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/me", { credentials: "include" });
      const data = await res.json();
      if (data.id) {
        setProfile({ id: data.id, publicKey: data.publicKey });
        return data;
      }
    } catch (err) {
      console.error("Failed to load profile:", err);
    }
    return null;
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const handleGenerateKeys = async () => {
    if (!profile || profile.publicKey || isGeneratingKeys) return;
    setIsGeneratingKeys(true);
    try {
      const keyPair = await generateUserKeyPair();
      const pubKeyBase64 = await exportPublicKey(keyPair.publicKey);

      const res = await fetch("/api/me/public-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ publicKey: pubKeyBase64 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Failed to register public key");
      }

      await savePrivateKey(profile.id, keyPair.privateKey);
      setProfile({ ...profile, publicKey: pubKeyBase64 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate keys");
    } finally {
      setIsGeneratingKeys(false);
    }
  };

  async function handleJoin(roomId: string) {
    setJoiningId(roomId);
    setError("");
    try {
      const result: any = await requestJoinRoom(roomId);
      const nextStatus = result?.membership?.status ?? "PENDING";

      if (nextStatus === "PENDING") {
        setError("Request submitted. Check Pending Requests for updates.");
      }

      if (nextStatus === "APPROVED") {
        router.push(`/rooms/${roomId}`);
      }
      setRooms((prev) =>
        prev.map((room) => {
          const id = room.id ?? room._id?.toString();
          if (id !== roomId) return room;
          return { ...room, membershipStatus: nextStatus };
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Join failed";
      if (message.includes("Already a member")) {
        router.push(`/rooms/${roomId}`);
        return;
      }
      setError(message);
    } finally {
      setJoiningId(null);
    }
  }

  return (
    <div className="mx-auto max-w-[480px] px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-8 border border-neutral-800 bg-neutral-950 p-5 sm:p-6">
        <p className="text-[10px] uppercase tracking-[0.25em] text-neutral-500">
          Encrypted rooms
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-white sm:text-3xl">
          Discover & join
        </h1>
        <p className="mt-2 max-w-xl text-sm text-neutral-500">
          Browse public rooms, filter by tag, and request to join. Messages stay
          end-to-end encrypted.
        </p>
      </div>

      {profile && !profile.publicKey && (
        <div className="mb-6 border border-yellow-500/20 bg-yellow-500/10 p-4 rounded-lg flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-sm text-yellow-200">
            <p className="font-semibold">Encryption keys missing</p>
            <p className="text-xs opacity-80">You need encryption keys to create and join rooms securely.</p>
          </div>
          <button
            onClick={handleGenerateKeys}
            disabled={isGeneratingKeys}
            className="whitespace-nowrap bg-yellow-500 text-black px-4 py-2 rounded font-bold text-xs uppercase tracking-wider hover:bg-yellow-400 disabled:opacity-50 transition-all"
          >
            {isGeneratingKeys ? "Generating..." : "Generate Keys Now"}
          </button>
        </div>
      )}

      <div className="mb-6 space-y-4">
        {/* Search bar + Trending / Most Used buttons */}
        <div className="flex items-start gap-2 sm:items-center">
          <div className="relative flex-1">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-600"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search Rooms..."
              className="w-full border border-neutral-800 bg-black py-3 pl-10 pr-4 text-sm text-white outline-none focus:border-neutral-500"
            />
          </div>
          <TrendingTags onSelect={addTag} selectedTags={selectedTags} />
        </div>

        <TagFilter selectedTags={selectedTags} onChange={setSelectedTags} />
      </div>

      {error && (
        <div className="mb-4 border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 grid-cols-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-44 animate-pulse border border-neutral-900 bg-neutral-950"
            />
          ))}
        </div>
      ) : rooms.length === 0 ? (
        <div className="border border-dashed border-neutral-800 px-6 py-16 text-center">
          <p className="text-sm text-neutral-500">No rooms match your filters.</p>
          {profile?.publicKey && (
            <button
              onClick={() => setCreateOpen(true)}
              className="mt-4 text-xs uppercase tracking-wider text-white underline underline-offset-4"
            >
              Create the first one
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-4 grid-cols-1">
            {sortedRooms.map((room:any) => {
              const rId = room.id ?? room._id?.toString() ?? "";
              const unread = counts[rId] ?? 0;
              const isTyping = Boolean(typingMap[rId]);
              return (
                <RoomCard
                  key={rId}
                  room={room}
                  onJoin={handleJoin}
                  joiningId={joiningId}
                  unreadCount={unread}
                  isTyping={isTyping}
                />
              );
            })}
          </div>


          {nextCursor && (
            <div className="mt-8 flex justify-center">
              <button
                onClick={() => void fetchRooms(nextCursor, true)}
                disabled={loadingMore}
                className="border border-neutral-700 px-6 py-2.5 text-xs uppercase tracking-wider text-neutral-300 hover:border-neutral-500 hover:text-white disabled:opacity-50"
              >
                {loadingMore ? "Loading..." : "Load more"}
              </button>
            </div>
          )}

          {/* End-of-list ripple art + scroll breathing room */}
          {!nextCursor && (
            <div className="mt-16 pb-28 sm:pb-20 flex flex-col items-center">
              <p className="mt-6 text-[10px] uppercase tracking-[0.3em] text-neutral-600">
                You&apos;ve reached the edge
              </p>
            </div>
          )}
        </>
      )}

      {/* Floating Action Button */}
      {profile?.id && (
        <FabCreateRoom 
          onClick={() => {
            if (!profile.publicKey) {
              setError("Please generate encryption keys first.");
              return;
            }
            setCreateOpen(true);
          }} 
        />
      )}

      {profile?.id && (
        <CreateRoomModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          userId={profile.id}
          publicKey={profile.publicKey}
        />
      )}
    </div>
  );
}
