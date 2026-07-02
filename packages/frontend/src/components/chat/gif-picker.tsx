"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Search, X, AlertCircle } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import type { GifResult, GifCategory } from "@/lib/gif-cache";

interface GifPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (gif: GifSelection) => void;
}

export interface GifSelection {
  id: string;
  mp4Url: string;
  tinygifUrl: string;
  fallbackUrl: string;
  width: number;
  height: number;
  size: number;
  title?: string;
}

export function GifPicker({ open, onClose, onSelect }: GifPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GifResult[]>([]);
  const [categories, setCategories] = useState<GifCategory[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [showTrending, setShowTrending] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const debouncedQuery = useDebounce(query, 500);

  // Fetch trending and categories on mount
  useEffect(() => {
    if (!open) return;

    setError(null);

    void Promise.all([
      fetch("/api/gifs/trending?offset=0&limit=20").then((r) => r.json()),
      fetch("/api/gifs/categories").then((r) => r.json()),
    ]).then(([trendingData, catData]) => {
      if (trendingData.error) {
        setError(trendingData.error);
        return;
      }
      setResults(trendingData.results ?? []);
      setNext(trendingData.next ?? null);
      setCategories(catData.categories ?? []);
    }).catch(() => {
      setError("Could not load GIFs. Try again.");
    });

    // Focus search input when opened
    setTimeout(() => searchInputRef.current?.focus(), 100);
  }, [open]);

  // Search when debounced query changes
  useEffect(() => {
    if (!open) return;

    const trimmed = debouncedQuery.trim();
    if (!trimmed) {
      // Revert to trending
      setShowTrending(true);
      setError(null);
      void fetch("/api/gifs/trending?offset=0&limit=20")
        .then((r) => r.json())
        .then((data) => {
          if (data.error) {
            setError(data.error);
            return;
          }
          setResults(data.results ?? []);
          setNext(data.next ?? null);
        })
        .catch(() => setError("Could not load GIFs. Try again."));
      return;
    }

    setShowTrending(false);
    setLoading(true);
    setError(null);

    void fetch(`/api/gifs/search?q=${encodeURIComponent(trimmed)}&offset=0&limit=20`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
          setResults([]);
          return;
        }
        setResults(data.results ?? []);
        setNext(data.next ?? null);
      })
      .catch(() => setError("Could not load GIFs. Try again."))
      .finally(() => setLoading(false));
  }, [debouncedQuery, open]);

  const handleCategoryClick = useCallback((category: GifCategory) => {
    setActiveCategory(category.name);
    setQuery(category.name_encoded);
  }, []);

  const handleLoadMore = useCallback(() => {
    if (!next || loading) return;
    setLoading(true);

    const params = showTrending
      ? `/api/gifs/trending?offset=${next}&limit=20`
      : `/api/gifs/search?q=${encodeURIComponent(query.trim())}&offset=${next}&limit=20`;

    void fetch(params)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) return;
        setResults((prev) => [...prev, ...(data.results ?? [])]);
        setNext(data.next ?? null);
      })
      .finally(() => setLoading(false));
  }, [next, loading, showTrending, query]);

  const handleSelect = useCallback(
    (gif: GifResult) => {
      onSelect({
        id: gif.id,
        mp4Url: gif.gifUrl,
        tinygifUrl: gif.previewUrl,
        fallbackUrl: gif.fallbackUrl,
        width: gif.width,
        height: gif.height,
        size: gif.size,
        title: gif.title,
      });
    },
    [onSelect]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 backdrop-blur-sm sm:items-center">
      <div className="flex h-[85dvh] w-full flex-col border border-neutral-800 bg-neutral-950 shadow-2xl sm:mx-4 sm:h-[80vh] sm:max-w-[480px]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <span className="text-xs uppercase tracking-wider text-neutral-300">GIF Picker</span>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center text-neutral-500 hover:text-white transition-colors"
            aria-label="Close GIF picker"
          >
            <X size={18} />
          </button>
        </div>

        {/* Search bar */}
        <div className="border-b border-neutral-800 px-4 py-3">
          <div className="flex items-center gap-2 border border-neutral-800 bg-black px-3 py-2">
            <Search size={16} className="text-neutral-500 shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search GIFs..."
              maxLength={100}
              className="w-full bg-transparent text-sm text-white outline-none placeholder:text-neutral-600"
            />
          </div>
        </div>

        {/* Categories bar */}
        {categories.length > 0 && !debouncedQuery.trim() && (
          <div className="flex gap-2 overflow-x-auto border-b border-neutral-800 px-4 py-2 scrollbar-none">
            {categories.map((cat) => (
              <button
                key={cat.name_encoded}
                type="button"
                onClick={() => handleCategoryClick(cat)}
                className={`shrink-0 border px-3 py-1 text-[10px] uppercase tracking-wider transition-colors ${
                  activeCategory === cat.name
                    ? "border-white bg-white text-black"
                    : "border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white"
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <AlertCircle size={24} className="text-neutral-500" />
            <p className="text-sm text-neutral-400">{error}</p>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setLoading(true);
                void fetch("/api/gifs/trending?offset=0&limit=20")
                  .then((r) => r.json())
                  .then((data) => {
                    setResults(data.results ?? []);
                    setNext(data.next ?? null);
                  })
                  .catch(() => setError("Could not load GIFs. Try again."))
                  .finally(() => setLoading(false));
              }}
              className="border border-neutral-700 px-4 py-1.5 text-[10px] uppercase tracking-wider text-neutral-400 hover:border-neutral-500 hover:text-white transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && results.length === 0 && (
          <div className="grid grid-cols-2 gap-2 overflow-y-auto p-4 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="aspect-video animate-pulse bg-neutral-800 rounded-sm" />
            ))}
          </div>
        )}

        {/* Empty search results */}
        {!loading && !error && results.length === 0 && debouncedQuery.trim() && (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
            <p className="text-sm text-neutral-500">
              No GIFs found for &ldquo;{debouncedQuery.trim()}&rdquo;
            </p>
          </div>
        )}

        {/* GIF grid */}
        {results.length > 0 && (
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3">
              {results.map((gif) => (
                <button
                  key={gif.id}
                  type="button"
                  onClick={() => handleSelect(gif)}
                  className="group relative overflow-hidden rounded-sm bg-neutral-800 transition-transform hover:scale-[1.02] focus:outline-none focus:ring-1 focus:ring-white/50"
                  style={{ aspectRatio: `${gif.width}/${gif.height}` }}
                >
                  <img
                    src={gif.previewUrl}
                    alt={gif.title || "GIF"}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                  {gif.title && (
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <span className="block truncate text-[10px] text-white/80">
                        {gif.title}
                      </span>
                    </div>
                  )}
                </button>
              ))}
            </div>

            {/* Load more */}
            {next && (
              <div className="flex justify-center pb-6">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={loading}
                  className="border border-neutral-700 px-4 py-1.5 text-[10px] uppercase tracking-wider text-neutral-500 hover:border-neutral-500 hover:text-neutral-300 disabled:opacity-50 transition-colors"
                >
                  {loading ? "Loading..." : "Load more"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
