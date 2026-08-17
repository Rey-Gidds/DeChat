"use client";

import { useEffect, useRef, useState } from "react";
import { useDebounce } from "@/hooks/use-debounce";
import { Search } from "lucide-react";

interface TagStat {
  tag: string;
  totalCount: number;
  trendingScore?: number;
}

export function TrendingTags({
  onSelect,
  selectedTags,
  direction = "left",
}: {
  onSelect: (tag: string) => void;
  selectedTags: string[];
  direction?: "left" | "right";
}) {
  const [trending, setTrending] = useState<TagStat[]>([]);
  const [popular, setPopular] = useState<TagStat[]>([]);
  const [activePanel, setActivePanel] = useState<"trending" | "popular" | null>(null);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 200);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/tags/trending?limit=20", { credentials: "include" }).then((r) =>
        r.json()
      ),
      fetch("/api/tags/popular?limit=20", { credentials: "include" }).then((r) =>
        r.json()
      ),
    ])
      .then(([trendingData, popularData]) => {
        if (cancelled) return;
        setTrending(trendingData.tags ?? []);
        setPopular(popularData.tags ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setActivePanel(null);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") setActivePanel(null);
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  function togglePanel(panel: "trending" | "popular") {
    if (activePanel === panel) {
      setActivePanel(null);
      setSearch("");
    } else {
      setActivePanel(panel);
      setSearch("");
    }
  }

  const source = activePanel === "trending" ? trending : popular;
  const filteredTags = source.filter((t) => {
    if (selectedTags.includes(t.tag)) return false;
    if (!debouncedSearch) return true;
    return t.tag.includes(debouncedSearch.toLowerCase().trim());
  });

  if (trending.length === 0 && popular.length === 0) return null;

  return (
    <div ref={ref} className="relative flex items-center gap-1.5 shrink-0">
      {trending.length > 0 && (
        <button
          type="button"
          onClick={() => togglePanel("trending")}
          className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition ${
            activePanel === "trending"
              ? "bg-white text-black"
              : "bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-white"
          }`}
        >
          Trending
        </button>
      )}
      {popular.length > 0 && (
        <button
          type="button"
          onClick={() => togglePanel("popular")}
          className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition ${
            activePanel === "popular"
              ? "bg-white text-black"
              : "bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-white"
          }`}
        >
          Popular
        </button>
      )}

      {/* Dropdown panel */}
      {activePanel && (
        <div className={`${direction === "right" ? "left-0" : "right-0"} absolute top-full z-20 mt-1.5 w-72 rounded-2xl border border-neutral-800 bg-neutral-950 p-1.5 shadow-2xl overflow-hidden sm:w-80`}>
          {/* Header label */}
          <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-semibold">
            {activePanel === "trending" ? "Trending Tags" : "Most Used Tags"}
          </div>

          {/* Search */}
          <div className="p-1.5">
            <div className="relative flex items-center rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2">
              <Search size={12} className="text-neutral-500 mr-2 shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tags..."
                autoFocus
                className="w-full bg-transparent text-xs text-white outline-none placeholder:text-neutral-600"
              />
            </div>
          </div>

          {/* Tag list */}
          <div className="max-h-56 overflow-y-auto mt-1 scrollbar-thin px-1">
            {filteredTags.length === 0 ? (
              <div className="py-8 text-center text-xs text-neutral-600">
                {debouncedSearch ? "No matching tags" : "No tags available"}
              </div>
            ) : (
              filteredTags.map((t) => (
                <button
                  key={t.tag}
                  type="button"
                  onClick={() => {
                    onSelect(t.tag);
                    setActivePanel(null);
                  }}
                  className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-xs text-neutral-300 transition hover:bg-neutral-900 hover:text-white"
                >
                  <span className="font-medium">#{t.tag}</span>
                  <span className="text-[10px] text-neutral-600 font-mono bg-neutral-900/50 px-2 py-0.5 rounded-full border border-neutral-800/40">{t.totalCount}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
