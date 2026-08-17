"use client";

import { ImageIcon, VideoIcon, Plus, ArrowUp, Film, X, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const MAX_TEXTAREA_HEIGHT = 130; // ~5-6 lines

interface ReplyContext {
  messageId: string;
  senderName: string;
  preview: string;
}

interface ChatInputProps {
  draft: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onSendMedia?: (file: File) => void;
  onGifClick?: () => void;
  disabled?: boolean;
  sendDisabled?: boolean;
  mediaSending?: boolean;
  replyContext?: ReplyContext | null;
  onClearReply?: () => void;
  editingMessageId?: string | null;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
}

export function ChatInput({
  draft,
  onChange,
  onSend,
  onSendMedia,
  onGifClick,
  disabled,
  sendDisabled,
  mediaSending,
  replyContext,
  onClearReply,
  editingMessageId,
  onSaveEdit,
  onCancelEdit,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const isEditMode = Boolean(editingMessageId);

  // Auto-resize textarea to content, capped at MAX_TEXTAREA_HEIGHT
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [draft]);

  // On mobile, when the textarea is focused the keyboard opens.
  function handleFocus() {
    const el = textareaRef.current;
    if (!el) return;
    setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 150);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isEditMode) {
        onSaveEdit?.();
      } else if (draft.trim() && !disabled && !mediaSending) {
        onSend();
      }
    }
  }

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file && onSendMedia) onSendMedia(file);
    e.target.value = "";
    setMenuOpen(false);
  }

  function handleVideoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file && onSendMedia) onSendMedia(file);
    e.target.value = "";
    setMenuOpen(false);
  }

  function handleGifClick() {
    setMenuOpen(false);
    onGifClick?.();
  }

  const menuItems = [
    { label: "Image", icon: ImageIcon, onClick: () => imageInputRef.current?.click() },
    { label: "Video", icon: VideoIcon, onClick: () => videoInputRef.current?.click() },
    { label: "GIF", icon: Film, onClick: handleGifClick },
  ];

  return (
    <div
      className="shrink-0 bg-[#0d0d0d] border-t border-neutral-800/50 px-3 py-3 sm:px-4"
      style={{
        paddingBottom: `max(0.75rem, env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-1">
        {/* Reply strip */}
        {replyContext && !isEditMode && (
          <div className="flex items-center rounded-2xl bg-neutral-900 border border-neutral-800 px-3 py-2 mb-1">
            <div className="flex-1 min-w-0 border-l-2 border-neutral-600 pl-2">
              <span className="block text-[11px] font-medium text-neutral-300">
                Replying to {replyContext.senderName}
              </span>
              <span className="block truncate text-[11px] text-neutral-500">{replyContext.preview}</span>
            </div>
            <button
              type="button"
              onClick={onClearReply}
              className="ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-neutral-600 transition hover:bg-neutral-800 hover:text-white"
              aria-label="Clear reply"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {/* Main input row */}
        <div className="flex items-end gap-2">
          {/* Plus / attachment button — hidden in edit mode */}
          {!isEditMode && (
            <div className="relative" style={{ alignSelf: "flex-end" }}>
              <button
                type="button"
                onClick={() => setMenuOpen((prev) => !prev)}
                disabled={disabled || mediaSending}
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-all disabled:opacity-40 ${
                  menuOpen
                    ? "bg-neutral-600 text-white"
                    : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-white"
                }`}
                aria-label="Attach media"
              >
                <Plus
                  size={20}
                  className={`transition-transform duration-200 ${menuOpen ? "rotate-45" : "rotate-0"}`}
                />
              </button>

              {/* Floating menu — modern rounded card, not boxy */}
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div className="menu-animate absolute bottom-full left-0 z-50 mb-2 w-44 overflow-hidden rounded-2xl border border-neutral-700/60 bg-neutral-900/95 shadow-2xl backdrop-blur-sm">
                    {menuItems.map((item, idx) => (
                      <button
                        key={item.label}
                        type="button"
                        onClick={item.onClick}
                        className={`flex w-full items-center gap-3 px-4 py-3 text-sm text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-white ${
                          idx < menuItems.length - 1 ? "border-b border-neutral-800/50" : ""
                        }`}
                      >
                        <item.icon size={16} className="text-neutral-400" />
                        {item.label}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={handleImageSelect} />
              <input ref={videoInputRef} type="file" accept="video/*" hidden onChange={handleVideoSelect} />
            </div>
          )}

          {/* Pill-shaped input wrapper */}
          <div className={`flex min-h-[44px] flex-1 items-end rounded-xl bg-neutral-800 px-4 py-2.5 transition-all focus-within:ring-1 focus-within:ring-neutral-600 ${
            isEditMode ? "ring-1 ring-neutral-600" : ""
          }`}>
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={handleFocus}
              disabled={disabled}
              placeholder={isEditMode ? "Edit message..." : "Message..."}
              style={{ resize: "none", overflowY: "hidden" }}
              className="min-h-[24px] w-full bg-transparent text-sm text-white outline-none placeholder:text-neutral-500"
            />
          </div>

          {/* Action buttons */}
          {isEditMode ? (
            <div className="flex gap-1.5" style={{ alignSelf: "flex-end" }}>
              <button
                type="button"
                onClick={onCancelEdit}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-neutral-400 transition hover:bg-neutral-700 hover:text-white"
                aria-label="Cancel edit"
              >
                <X size={18} />
              </button>
              <button
                type="button"
                onClick={onSaveEdit}
                disabled={disabled || sendDisabled || !draft.trim()}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Save edit"
              >
                <Check size={18} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={disabled || sendDisabled || mediaSending || !draft.trim()}
              style={{ alignSelf: "flex-end" }}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Send message"
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
