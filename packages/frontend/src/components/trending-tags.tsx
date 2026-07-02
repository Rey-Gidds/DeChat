"use client";

import { useEffect, useRef, useState } from "react";
import { useDebounce } from "@/hooks/use-debounce";

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

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setActivePanel(null);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Close on Escape
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

  // Don't render anything if no data at all
  if (trending.length === 0 && popular.length === 0) return null;

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      {trending.length > 0 && (
        <button
          type="button"
          onClick={() => togglePanel("trending")}
          className={`px-3 py-2 text-[10px] uppercase tracking-wider border transition ${
            activePanel === "trending"
              ? "border-neutral-500 bg-neutral-900 text-white"
              : "border-neutral-800 bg-black text-neutral-500 hover:border-neutral-600 hover:text-neutral-300"
          }`}
        >
          Trending
        </button>
      )}
      {popular.length > 0 && (
        <button
          type="button"
          onClick={() => togglePanel("popular")}
          className={`px-3 py-2 text-[10px] uppercase tracking-wider border transition ${
            activePanel === "popular"
              ? "border-neutral-500 bg-neutral-900 text-white"
              : "border-neutral-800 bg-black text-neutral-500 hover:border-neutral-600 hover:text-neutral-300"
          }`}
        >
          Most Used
        </button>
      )}

      {/* Dropdown panel */}
      {activePanel && (
        <div className={`${direction === "right" ? "left-0" : "right-0"} absolute top-full z-10 mt-1 w-72 border border-neutral-800 bg-neutral-950 shadow-xl sm:w-80`}>
          {/* Header label */}
          <div className="border-b border-neutral-800 px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-neutral-600">
            {activePanel === "trending" ? "Trending" : "Most Used"}
          </div>

          {/* Search */}
          <div className="border-b border-neutral-800 p-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tags..."
              autoFocus
              className="w-full border border-neutral-800 bg-black px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-white outline-none focus:border-neutral-500 placeholder:text-neutral-600"
            />
          </div>

          {/* Tag list */}
          <div className="max-h-60 overflow-y-auto">
            {filteredTags.length === 0 ? (
              <div className="px-3 py-6 text-center text-[10px] uppercase tracking-wider text-neutral-600">
                {debouncedSearch ? "No matching tags" : "No tags available"}
              </div>
            ) : (
              filteredTags.map((t) => (
                <button
                  key={t.tag}
                  type="button"
                  onClick={() => onSelect(t.tag)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-[10px] uppercase tracking-wider text-neutral-400 transition hover:bg-neutral-900 hover:text-white"
                >
                  <span>{t.tag}</span>
                  <span className="text-neutral-600">{t.totalCount}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
