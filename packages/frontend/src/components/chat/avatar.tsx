import { useState } from "react";
import { User } from "lucide-react";
import { pfpUrl } from "@/lib/pfp";
import type { PfpMetadata } from "@/lib/pfp";

interface AvatarProps {
  pfp?: PfpMetadata | string | null;
  size?: number;
  className?: string;
}

export function Avatar({ pfp, size = 32, className }: AvatarProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const url = pfpUrl(pfp);

  // Fallback icon — shown when no pfp, still loading, or failed to load
  const fallback = (
    <div
      className={`shrink-0 flex items-center justify-center rounded-full bg-neutral-800 ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      <User size={Math.round(size * 0.5)} className="text-neutral-500" />
    </div>
  );

  if (!url || error) return fallback;

  return (
    <div
      className={`relative shrink-0 rounded-full overflow-hidden ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      {/* Placeholder behind the image while it loads */}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-800">
          <User size={Math.round(size * 0.5)} className="text-neutral-500" />
        </div>
      )}
      <img
        src={url}
        alt=""
        className={`w-full h-full object-cover transition-opacity duration-150 ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
        loading="lazy"
      />
    </div>
  );
}
