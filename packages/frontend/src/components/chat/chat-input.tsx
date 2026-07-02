"use client";

import { ImageIcon, VideoIcon, Plus, ArrowUp, Film, X, Check } from "lucide-react";
import { useRef, useState } from "react";

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
  mediaSending?: boolean;
  // ── Reply mode ──
  replyContext?: ReplyContext | null;
  onClearReply?: () => void;
  // ── Edit mode ──
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
  const menuRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (editingMessageId) {
        onSaveEdit?.();
      } else {
        if (draft.trim() && !disabled && !mediaSending) onSend();
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
    {
      label: "Image",
      icon: ImageIcon,
      onClick: () => imageInputRef.current?.click(),
    },
    {
      label: "Video",
      icon: VideoIcon,
      onClick: () => videoInputRef.current?.click(),
    },
    {
      label: "GIF",
      icon: Film,
      onClick: handleGifClick,
    },
  ];

  const isEditMode = Boolean(editingMessageId);

  return (
    <div className="shrink-0 border-t border-neutral-800 bg-black px-3 py-3 sm:px-4">
      <div className="mx-auto flex max-w-3xl flex-col">
        {/* ── Reply strip above input ── */}
        {replyContext && !isEditMode && (
          <div className="flex items-center border-b border-neutral-700 bg-neutral-900 px-3 py-1.5">
            <div className="flex-1 min-w-0">
              <span className="block text-[11px] font-medium text-neutral-300">
                Replying to {replyContext.senderName}
              </span>
              <span className="block truncate text-[11px] text-neutral-500">
                {replyContext.preview}
              </span>
            </div>
            <button
              onClick={onClearReply}
              className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center text-neutral-500 hover:text-white transition-colors"
              aria-label="Clear reply"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2 pt-2">
          {/* Attachment button (hidden in edit mode) */}
          {!isEditMode && (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((prev) => !prev)}
                disabled={disabled || mediaSending}
                className="flex h-11 w-11 shrink-0 items-center justify-center border border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-neutral-500 hover:text-white disabled:opacity-40"
                aria-label="Attach media"
              >
                <Plus size={20} />
              </button>

              {menuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div className="absolute bottom-full left-0 z-50 mb-2 flex flex-col border border-neutral-700 bg-neutral-900 shadow-xl">
                    {menuItems.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        onClick={item.onClick}
                        className="flex items-center gap-3 px-4 py-2.5 text-xs uppercase tracking-wider text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors"
                      >
                        <item.icon size={16} />
                        {item.label}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={handleImageSelect}
              />
              <input
                ref={videoInputRef}
                type="file"
                accept="video/*"
                hidden
                onChange={handleVideoSelect}
              />
            </div>
          )}

          {/* Recessed input */}
          <div className="flex min-h-[44px] flex-1 items-end border border-neutral-700 bg-neutral-900 px-3 py-2 focus-within:border-white transition-colors">
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              placeholder={isEditMode ? "Edit message" : "Message"}
              className="max-h-32 min-h-[24px] w-full resize-none bg-transparent text-sm text-white outline-none placeholder:text-neutral-500"
            />
          </div>

          {/* Send / Save / Cancel buttons */}
          {isEditMode ? (
            <div className="flex gap-1">
              <button
                onClick={onCancelEdit}
                className="flex h-11 w-11 shrink-0 items-center justify-center border border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-neutral-500 hover:text-white transition-colors"
                aria-label="Cancel edit"
              >
                <X size={20} />
              </button>
              <button
                onClick={onSaveEdit}
                disabled={disabled || !draft.trim()}
                className="flex h-11 w-11 shrink-0 items-center justify-center bg-white text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Save edit"
              >
                <Check size={20} />
              </button>
            </div>
          ) : (
            <button
              onClick={onSend}
              disabled={disabled || mediaSending || !draft.trim()}
              className="flex h-11 w-11 shrink-0 items-center justify-center bg-white text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send message"
            >
              <ArrowUp size={20} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
