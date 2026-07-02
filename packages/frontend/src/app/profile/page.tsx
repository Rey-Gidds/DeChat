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

interface UserProfile {
  id: string;
  name: string;
  email: string;
  publicKey: string | null;
  image?: string;
  pfp?: string | null;
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
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [memberships, setMemberships] = useState<RoomMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Name editing state
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState("");
  const [savingName, setSavingName] = useState(false);

  // PFP state
  const [uploadingPfp, setUploadingPfp] = useState(false);

  // Recovery kit state
  const [showRecoveryDownload, setShowRecoveryDownload] = useState(false);
  const [recoveryPrivateKey, setRecoveryPrivateKey] = useState<CryptoKey | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [profileRes, roomsRes] = await Promise.all([
        fetch("/api/me", { credentials: "include" }),
        fetch("/api/rooms/mine", { credentials: "include" }),
      ]);

      const profileData = await profileRes.json();
      const roomsData = await roomsRes.json();

      if (!profileRes.ok) throw new Error(profileData.error || "Failed to load profile");
      
      setProfile({
        ...profileData,
        pfp: profileData.pfp ?? null,
      });
      setNameDraft(profileData.name || "");
      setMemberships(roomsData.memberships || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load profile data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function handleStartEditName() {
    if (!profile) return;
    setNameDraft(profile.name);
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
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update name");
      setProfile((prev) => (prev ? { ...prev, name: data.name } : prev));
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

    if (file.size > 1 * 1024 * 1024) {
      setError("Image must be under 1 MB");
      return;
    }

    if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type)) {
      setError("Only JPEG, PNG, GIF, and WebP images are allowed");
      return;
    }

    setUploadingPfp(true);
    setError("");
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });

      const res = await fetch("/api/me/pfp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ image: dataUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to upload picture");
      setProfile((prev) => (prev ? { ...prev, pfp: data.pfp } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload picture");
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
      setProfile((prev) => (prev ? { ...prev, pfp: null } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove picture");
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
      setError("Failed to load private key.");
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
        <Shield className="mx-auto h-12 w-12 text-red-500/50" />
        <h2 className="mt-4 text-xl font-bold text-white">Access Denied</h2>
        <p className="mt-2 text-sm text-neutral-500">{error || "User session not found."}</p>
        <Link href="/sign-in">
          <Button variant="primary" className="mt-8">Sign In</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/" className="mb-8 inline-flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-500 hover:text-white transition-colors">
        <ArrowLeft size={14} />
        Back to Discover
      </Link>

      <div className="grid gap-8 overflow-hidden md:grid-cols-3">
        {/* Profile Sidebar */}
        <div className="md:col-span-1 space-y-6">
          <div className="border border-neutral-800 bg-neutral-950 p-6 text-center">
            {/* Avatar with upload overlay */}
            <div className="relative mx-auto mb-4 h-20 w-20">
              <div className="h-full w-full overflow-hidden border border-neutral-700 bg-neutral-900 flex items-center justify-center">
                {profile.pfp ? (
                  <img src={profile.pfp} alt="" className="h-full w-full object-cover" />
                ) : (
                  <User size={32} className="text-neutral-500" />
                )}
              </div>
              <label
                className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/0 opacity-0 transition hover:bg-black/50 hover:opacity-100"
                aria-label="Upload profile picture"
              >
                {uploadingPfp ? (
                  <span className="text-[9px] uppercase tracking-widest text-white">...</span>
                ) : (
                  <Camera size={18} className="text-white" />
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  className="hidden"
                  onChange={handlePfpUpload}
                />
              </label>
              {profile.pfp && (
                <button
                  onClick={handleRemovePfp}
                  className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center border border-neutral-700 bg-black hover:bg-neutral-800"
                  aria-label="Remove profile picture"
                >
                  <X size={10} className="text-neutral-400" />
                </button>
              )}
            </div>

            {/* Name display / edit */}
            {editingName ? (
              <div className="mb-2 space-y-2">
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveName();
                    if (e.key === "Escape") handleCancelEditName();
                  }}
                  maxLength={NAME_MAX}
                  className="w-full border border-neutral-700 bg-black px-2 py-1 text-center text-lg font-bold uppercase tracking-tight text-white outline-none focus:border-neutral-500"
                />
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={handleSaveName}
                    disabled={savingName}
                    className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-neutral-400 hover:text-white transition disabled:opacity-50"
                  >
                    <Check size={12} />
                    {savingName ? "Saving..." : "Save"}
                  </button>
                  <button
                    onClick={handleCancelEditName}
                    className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-neutral-600 hover:text-neutral-400 transition"
                  >
                    <X size={12} />
                    Cancel
                  </button>
                </div>
                {nameError && (
                  <p className="text-[9px] text-red-500 uppercase tracking-wider">{nameError}</p>
                )}
              </div>
            ) : (
              <div className="mb-1 flex items-center justify-center gap-2">
                <h1 className="text-lg font-bold text-white uppercase tracking-tight">{profile.name}</h1>
                <button
                  onClick={handleStartEditName}
                  className="text-neutral-600 hover:text-white transition"
                  aria-label="Edit name"
                >
                  <Pencil size={12} />
                </button>
              </div>
            )}

            <p className="text-xs text-neutral-500 mt-1 truncate">{profile.email}</p>
            
            <div className="mt-6 pt-6 border-t border-neutral-800 text-left">
              <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 mb-2">Account ID</p>
              <code className="text-[10px] text-neutral-300 break-all bg-neutral-900 p-2 block border border-neutral-800">
                {profile.id}
              </code>
            </div>

            {/* Recovery Kit Section */}
            <div className="mt-6 pt-6 border-t border-neutral-800 text-left">
              <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 mb-3">Recovery Kit</p>
              
              {hasPrivateKey ? (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2 text-[11px] text-teal-400 bg-teal-500/10 px-3 py-2 border border-teal-900/30">
                    <CheckCircle2 size={14} />
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
                      className="w-full bg-[#66fcf1] text-[#0b0c10] font-bold py-2.5 rounded-xl text-xs hover:bg-[#45a29e] hover:text-white transition-all flex items-center justify-center gap-2 disabled:opacity-40"
                    >
                      <Download size={14} />
                      {recoveryLoading ? "Loading..." : "Download New Recovery Kit"}
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2 text-[11px] text-amber-400 bg-amber-500/10 px-3 py-2 border border-amber-500/20">
                    <ShieldAlert size={14} />
                    <span>Keys not restored</span>
                  </div>
                  <button
                    onClick={() => openRecovery()}
                    className="w-full border border-neutral-700 text-neutral-300 font-bold py-2.5 rounded-xl text-xs hover:bg-neutral-900 transition-all flex items-center justify-center gap-2"
                  >
                    <KeyRound size={14} />
                    Restore Identity
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="md:col-span-2 space-y-6">
          <div className="border border-neutral-800 bg-neutral-950 p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <History size={18} className="text-neutral-400" />
                <h2 className="text-sm font-bold uppercase tracking-widest text-white">Joined Rooms</h2>
              </div>
              <span className="text-[10px] font-bold text-neutral-500 bg-neutral-900 px-2 py-1 border border-neutral-800">
                {memberships.length} TOTAL
              </span>
            </div>

            {memberships.length === 0 ? (
              <div className="border border-dashed border-neutral-800 py-12 text-center">
                <p className="text-xs text-neutral-500 uppercase tracking-widest">No room history found</p>
                <Link href="/">
                  <Button variant="ghost" size="sm" className="mt-4 text-[10px] underline underline-offset-4 hover:text-[#66fcf1]">Explore Rooms</Button>
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {memberships.map((membership) => (
                  <Link 
                    key={membership.roomId} 
                    href={`/rooms/${membership.roomId}`}
                    className="flex items-center justify-between overflow-hidden border border-neutral-900 bg-black p-4 hover:border-neutral-700 transition-all group"
                  >
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-white group-hover:text-[#66fcf1] transition-colors">
                        {membership.room?.name || "Unknown Room"}
                      </h3>
                      <p className="text-[10px] text-neutral-500 mt-1 line-clamp-1">
                        {membership.room?.description || "No description available"}
                      </p>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-sm ${
                        membership.status === "APPROVED" ? "bg-green-500/10 text-green-500" : "bg-yellow-500/10 text-yellow-500"
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
