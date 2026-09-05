"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { User, Shield, History, ArrowLeft, Camera, Pencil, X, Check, KeyRound, Download, CheckCircle2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useKeyHealth } from "@/components/key-recovery/provider";
import { RecoveryDownload } from "@/components/key-recovery/recovery-download";
import { getPrivateKey } from "@/lib/crypto";
import Link from "next/link";
import { format } from "date-fns";
import { useUser, useMyRooms } from "@/hooks/use-swr-hooks";
import { toast } from "sonner";
import { pfpUrl } from "@/lib/pfp";
import type { PfpMetadata } from "@/lib/pfp";


interface UserProfile {
  id: string;
  name: string;
  email: string;
  publicKey: string | null;
  image?: string;
  pfp?: PfpMetadata | null;
  pfpNeedsReupload?: boolean;
}


interface RoomMembership {
  roomId: string;
  status: string;
  joinedAt: string;
  room: {
    name: string;
    description: string;
    joinPolicy?: string;
  } | null;
}

const NAME_MAX = 20;
const NAME_REGEX = /^[a-zA-Z0-9_ ]+$/;

export default function ProfilePage() {
  const router = useRouter();
  const { openRecovery, hasPrivateKey } = useKeyHealth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { user: profile, isLoading: userLoading, error: userError, updateProfileName, mutateUser } = useUser();
  const { memberships, isLoading: roomsLoading } = useMyRooms();

  const loading = userLoading || roomsLoading;
  const error = userError instanceof Error ? userError.message : "";

  // Name editing state
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState("");
  const [savingName, setSavingName] = useState(false);

  // PFP state
  const [uploadingPfp, setUploadingPfp] = useState(false);
  const [pfpError, setPfpError] = useState("");

  // One-time toast when server migration cleared the user's pfp
  useEffect(() => {
    if (profile?.pfpNeedsReupload) {
      toast.info("Please re-upload your profile picture.", { duration: 10_000 });
    }
  }, [profile?.pfpNeedsReupload]);


  // Recovery kit state
  const [showRecoveryDownload, setShowRecoveryDownload] = useState(false);
  const [recoveryPrivateKey, setRecoveryPrivateKey] = useState<CryptoKey | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);

  function handleStartEditName() {
    if (!profile) return;
    setNameDraft(profile.name || "");
    setNameError("");
    setEditingName(true);
  }

  function handleCancelEditName() {
    setEditingName(false);
    setNameError("");
  }

  async function handleSaveName() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed.length > NAME_MAX) {
      setNameError(`Must be 1–${NAME_MAX} characters`);
      return;
    }
    if (!NAME_REGEX.test(trimmed)) {
      setNameError("Letters, numbers, spaces, underscores only");
      return;
    }
    setSavingName(true);
    setNameError("");
    try {
      await updateProfileName(trimmed);
      toast.success("Name updated");
      setEditingName(false);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Failed to update name");
    } finally {
      setSavingName(false);
    }
  }

  async function handlePfpUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setPfpError("Image must be under 2 MB");
      return;
    }
    if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type)) {
      setPfpError("Only JPEG, PNG, GIF, and WebP images are allowed");
      return;
    }

    setUploadingPfp(true);
    setPfpError("");
    try {
      // 1. Get presigned upload URL from server
      const urlRes = await fetch("/api/me/pfp/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mimeType: file.type, size: file.size }),
      });
      const urlData = await urlRes.json();
      if (!urlRes.ok) throw new Error(urlData.error || "Failed to get upload URL");

      const { uploadUrl, objectKey } = urlData;

      // 2. Upload binary directly to R2 (no server involvement)
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadRes.ok) throw new Error("Upload to storage failed");

      // 3. Confirm with server so it saves metadata to user document
      const confirmRes = await fetch("/api/me/pfp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ objectKey, mimeType: file.type, size: file.size }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmRes.ok) throw new Error(confirmData.error || "Failed to save picture");

      toast.success("Profile picture updated");
      await mutateUser();
    } catch (err) {
      setPfpError(err instanceof Error ? err.message : "Failed to upload picture");
    } finally {
      setUploadingPfp(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }


  async function handleRemovePfp() {
    setUploadingPfp(true);
    try {
      const res = await fetch("/api/me/pfp", {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to remove picture");
      toast.success("Profile picture removed");
      await mutateUser();
    } catch (err) {
      setPfpError(err instanceof Error ? err.message : "Failed to remove picture");
    } finally {
      setUploadingPfp(false);
    }
  }

  async function handleLoadRecoveryKit() {
    if (!profile?.id) return;
    setRecoveryLoading(true);
    try {
      const key = await getPrivateKey(profile.id);
      if (key) {
        setRecoveryPrivateKey(key);
        setShowRecoveryDownload(true);
      }
    } catch {
      toast.error("Failed to load private key.");
    } finally {
      setRecoveryLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-xs uppercase tracking-wider text-neutral-600 animate-pulse">Loading profile...</p>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <Shield className="mx-auto h-12 w-12 text-neutral-500/50" />
        <h2 className="mt-4 text-xl font-bold text-white">Access Denied</h2>
        <p className="mt-2 text-sm text-neutral-500">{error || "User session not found."}</p>
        <Link href="/sign-in">
          <Button variant="primary" className="mt-8">Sign In</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      {/* ── Back button ── */}
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-500 hover:text-white transition-colors"
      >
        <ArrowLeft size={14} />
        Back
      </Link>

      <div className="grid gap-6 md:grid-cols-3">
        {/* ── Profile Card ── */}
        <div className="md:col-span-1 space-y-4">
          <div className="border border-neutral-800 bg-neutral-950 rounded-2xl p-5">

            {/* ── PFP left + Name right (social media style) ── */}
            <div className="flex items-center gap-4">
              {/* Avatar with upload overlay */}
              <div className="relative shrink-0 h-16 w-16">
                <div className="h-full w-full overflow-hidden rounded-full border border-neutral-700 bg-neutral-900 flex items-center justify-center">
                  {pfpUrl(profile.pfp) ? (
                    <img src={pfpUrl(profile.pfp)!} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <User size={28} className="text-neutral-500" />
                  )}
                </div>
                {/* Upload label */}
                <label
                  className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-full bg-black/0 opacity-0 transition hover:bg-black/50 hover:opacity-100"
                  aria-label="Upload profile picture"
                >
                  {uploadingPfp ? (
                    <span className="text-[9px] text-white">...</span>
                  ) : (
                    <Camera size={16} className="text-white" />
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    className="hidden"
                    onChange={handlePfpUpload}
                  />
                </label>
                {/* Remove PFP button */}
                {profile.pfp && (
                  <button
                    onClick={handleRemovePfp}
                    className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 bg-black hover:bg-neutral-800"
                    aria-label="Remove profile picture"
                  >
                    <X size={9} className="text-neutral-400" />
                  </button>
                )}
              </div>

              {/* Name + email */}
              <div className="min-w-0 flex-1">
                {editingName ? (
                  <div className="space-y-1.5">
                    <input
                      autoFocus
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveName();
                        if (e.key === "Escape") handleCancelEditName();
                      }}
                      maxLength={NAME_MAX}
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm font-bold text-white outline-none focus:border-neutral-500"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleSaveName}
                        disabled={savingName}
                        className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-neutral-400 hover:text-white transition disabled:opacity-50"
                      >
                        <Check size={11} />
                        {savingName ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={handleCancelEditName}
                        className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-neutral-600 hover:text-neutral-400 transition"
                      >
                        <X size={11} />
                        Cancel
                      </button>
                    </div>
                    {nameError && (
                      <p className="text-[9px] text-red-400 uppercase tracking-wider">{nameError}</p>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5">
                      <h1 className="text-base font-bold text-white truncate">{profile.name}</h1>
                      <button
                        onClick={handleStartEditName}
                        className="shrink-0 text-neutral-600 hover:text-white transition"
                        aria-label="Edit name"
                      >
                        <Pencil size={11} />
                      </button>
                    </div>
                    <p className="text-xs text-neutral-500 truncate mt-0.5">{profile.email}</p>
                  </>
                )}
              </div>
            </div>

            {/* PFP error */}
            {pfpError && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2">
                <span className="flex-1 text-[10px] text-neutral-400">{pfpError}</span>
                <button
                  onClick={() => setPfpError("")}
                  className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-500 hover:text-neutral-300 transition"
                  aria-label="Dismiss"
                >
                  <X size={10} />
                </button>
              </div>
            )}

            {/* Account ID */}
            <div className="mt-5 pt-5 border-t border-neutral-800">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px] uppercase tracking-[0.15em] text-neutral-500">Account ID</p>
              </div>
              <code className="text-[10px] text-neutral-400 break-all bg-neutral-900 rounded-lg p-2.5 block border border-neutral-800">
                {profile.id}
              </code>
            </div>

            {/* Recovery Kit */}
            <div className="mt-5 pt-5 border-t border-neutral-800">
              <p className="text-[10px] uppercase tracking-[0.15em] text-neutral-500 mb-3">Recovery Kit</p>

              {hasPrivateKey ? (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2 text-[11px] text-neutral-300 bg-neutral-900 px-3 py-2 rounded-xl border border-neutral-800">
                    <CheckCircle2 size={13} className="text-neutral-400" />
                    <span>Recovery kit configured</span>
                  </div>

                  {showRecoveryDownload && recoveryPrivateKey ? (
                    <RecoveryDownload
                      userId={profile.id}
                      privateKey={recoveryPrivateKey}
                      onComplete={() => {
                        setShowRecoveryDownload(false);
                        setRecoveryPrivateKey(null);
                      }}
                    />
                  ) : (
                    <button
                      onClick={handleLoadRecoveryKit}
                      disabled={recoveryLoading}
                      className="w-full bg-neutral-800 hover:bg-neutral-700 text-white font-semibold py-2.5 rounded-xl text-xs transition-all flex items-center justify-center gap-2 disabled:opacity-40 border border-neutral-700"
                    >
                      <Download size={13} />
                      {recoveryLoading ? "Loading..." : "Download New Recovery Kit"}
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2 text-[11px] text-neutral-400 bg-neutral-900 px-3 py-2 rounded-xl border border-neutral-800">
                    <ShieldAlert size={13} />
                    <span>Keys not restored</span>
                  </div>
                  <button
                    onClick={() => openRecovery()}
                    className="w-full border border-neutral-700 text-neutral-300 font-semibold py-2.5 rounded-xl text-xs hover:bg-neutral-900 transition-all flex items-center justify-center gap-2"
                  >
                    <KeyRound size={13} />
                    Restore Identity
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Joined Rooms ── */}
        <div className="md:col-span-2 space-y-4">
          <div className="border border-neutral-800 bg-neutral-950 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <History size={16} className="text-neutral-400" />
                <h2 className="text-sm font-bold uppercase tracking-widest text-white">Joined Rooms</h2>
              </div>
              <span className="text-[10px] font-bold text-neutral-500 bg-neutral-900 px-2.5 py-1 rounded-full border border-neutral-800">
                {memberships.length} total
              </span>
            </div>

            {memberships.length === 0 ? (
              <div className="border border-dashed border-neutral-800 rounded-xl py-12 text-center">
                <p className="text-xs text-neutral-500 uppercase tracking-widest">No room history found</p>
                <Link href="/">
                  <Button variant="ghost" size="sm" className="mt-4 text-[10px] underline underline-offset-4 hover:text-white">
                    Explore Rooms
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="space-y-2">
                {memberships.map((membership) => (
                  <Link
                    key={membership.roomId}
                    href={`/rooms/${membership.roomId}`}
                    className="flex items-center justify-between rounded-xl border border-neutral-900 bg-black p-4 hover:border-neutral-700 hover:bg-neutral-950 transition-all group"
                  >
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-white group-hover:text-neutral-200 transition-colors">
                        {membership.room?.name || "Unknown Room"}
                      </h3>
                      <p className="text-[10px] text-neutral-500 mt-0.5 line-clamp-1">
                        {membership.room?.description || "No description available"}
                      </p>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${
                        membership.status === "APPROVED"
                          ? "bg-neutral-800 text-neutral-300"
                          : "bg-neutral-800 text-neutral-400"
                      }`}>
                        {membership.status}
                      </span>
                      <p className="text-[9px] text-neutral-600 mt-1">
                        {membership?.joinedAt
                          ? format(new Date(membership.joinedAt), "MMM d, yyyy")
                          : "Joined"}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
