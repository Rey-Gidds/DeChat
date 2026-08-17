"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import Image from "next/image";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  subtitle?: string;
  headerIcon?: React.ReactNode;
}

export function Modal({ title, onClose, children, className = "", subtitle, headerIcon }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    focusable[0]?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        className={`relative flex w-full flex-col rounded-2xl border border-neutral-800/80 bg-neutral-950 shadow-2xl ${className}`}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-800/60 px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            {headerIcon ? (
              headerIcon
            ) : (
              <Image src="/icons/dechat_logo_orig.png" alt="" width={16} height={16} className="opacity-60 rounded-full" />
            )}
            <div>
              <h2 id="modal-title" className="text-xs font-semibold text-white leading-tight">
                {title}
              </h2>
              {subtitle && (
                <p className="text-[10px] text-neutral-500 mt-0.5">{subtitle}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-500 transition hover:bg-neutral-800 hover:text-white"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
