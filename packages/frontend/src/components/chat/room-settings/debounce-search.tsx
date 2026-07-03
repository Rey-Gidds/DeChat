"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

interface DebounceSearchProps {
  placeholder?: string;
  onSearch: (query: string) => void;
  delayMs?: number;
}

export function DebounceSearch({ placeholder = "Search...", onSearch, delayMs = 300 }: DebounceSearchProps) {
  const [value, setValue] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSearch(value.trim()), delayMs);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [value, delayMs, onSearch]);

  return (
    <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2.5">
      <Search size={14} className="shrink-0 text-neutral-500" />
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-sm text-white outline-none placeholder:text-neutral-600"
      />
    </div>
  );
}
