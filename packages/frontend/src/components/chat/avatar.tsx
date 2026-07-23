import { User } from "lucide-react";

interface AvatarProps {
  pfp?: string | null;
  size?: number;
  className?: string;
}

export function Avatar({ pfp, size = 32, className }: AvatarProps) {
  if (pfp) {
    return (
      <img
        src={pfp}
        alt=""
        className={`shrink-0 rounded-full object-cover ${className ?? ""}`}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className={`shrink-0 flex items-center justify-center rounded-full bg-neutral-800 ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      <User size={Math.round(size * 0.5)} className="text-neutral-500" />
    </div>
  );
}
