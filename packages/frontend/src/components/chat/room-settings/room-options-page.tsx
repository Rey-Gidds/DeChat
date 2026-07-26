"use client";

import { useCallback, useMemo, useState } from "react";
import { Copy, Check, Link2 } from "lucide-react";
import { DebounceSearch } from "./debounce-search";
import { toast } from "sonner";
import { MemberActionDialog, type ActionMember } from "./member-action-dialog";
import { approveJoinRequest } from "@/lib/room-membership-client";
import { Avatar } from "../avatar";

export type ViewerRole = "OWNER" | "ADMIN" | "MEMBER";

export interface RoomMemberEntry {
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  isOnline?: boolean;
  userIndex?: number | null;
  user: { name?: string; email?: string; publicKey?: string | null; pfp?: string | null } | null;
}

interface JoinRequest {
  userId: string;
  membershipId: string;
  createdAt: string;
  reviewedAt?: string | null;
  user: { name?: string; email?: string; publicKey: string | null; pfp?: string | null } | null;
}

interface RoomOptionsPageProps {
  roomId: string;
  roomName: string;
  roomDescription?: string;
  roomLink: string;
  joinPolicy?: string;
  members: RoomMemberEntry[];
  onlineUserIds: Set<string>;
  viewerRole: ViewerRole;
  isDisabled: boolean;
  isAdmin: boolean;
  onToggleDisable?: () => void;
  onEditDetails?: (name: string, description: string) => Promise<void>;
  onLeaveRequest: () => void;
  onKickout: (userId: string) => Promise<void>;
  onRoleChange: (userId: string, role: string) => Promise<void>;
  onMembersRefresh: () => void;
}

/** Sort order: Owner online > Admin online > Member online > Owner offline > Admin offline > Member offline */
function sortMembers(members: RoomMemberEntry[], onlineIds: Set<string>): RoomMemberEntry[] {
  const roleOrder: Record<string, number> = { OWNER: 0, ADMIN: 1, MEMBER: 2 };
  return [...members].sort((a, b) => {
    const aOnline = onlineIds.has(a.userId) ? 0 : 1;
    const bOnline = onlineIds.has(b.userId) ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    return (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3);
  });
}

function displayName(m: RoomMemberEntry) {
  return m.user?.name || m.user?.email || "Anonymous";
}

function useCopyLink(url: string) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [url]);
  return { copied, copy };
}

export function RoomOptionsPage({
  roomId,
  roomName,
  roomDescription,
  roomLink,
  joinPolicy,
  members,
  onlineUserIds,
  viewerRole,
  isDisabled,
  isAdmin,
  onToggleDisable,
  onEditDetails,
  onLeaveRequest,
  onKickout,
  onRoleChange,
  onMembersRefresh,
}: RoomOptionsPageProps) {
  const [tab, setTab] = useState<"options" | "members" | "requests">("options");
  const [memberQuery, setMemberQuery] = useState("");
  const [actionTarget, setActionTarget] = useState<RoomMemberEntry | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Edit details state
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editName, setEditName] = useState(roomName);
  const [editDescription, setEditDescription] = useState(roomDescription || "");
  const [savingDetails, setSavingDetails] = useState(false);

  // Join requests state
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [requestsLoaded, setRequestsLoaded] = useState(false);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [rejectAllLoading, setRejectAllLoading] = useState(false);

  const inviteUrl = typeof window !== "undefined"
    ? `${window.location.origin}/join/${roomLink}`
    : `/join/${roomLink}`;

  const { copied, copy } = useCopyLink(inviteUrl);

  const sorted = useMemo(() => sortMembers(members, onlineUserIds), [members, onlineUserIds]);

  const filtered = useMemo(() => {
    if (!memberQuery) return sorted;
    const q = memberQuery.toLowerCase();
    return sorted.filter((m) => displayName(m).toLowerCase().includes(q));
  }, [sorted, memberQuery]);

  const handleMemberSearch = useCallback((q: string) => setMemberQuery(q), []);

  const fetchRequests = useCallback(async () => {
    if (!isAdmin) return;
    setRequestsLoading(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/join-requests`, { credentials: "include" });
      const data = await res.json();
      setRequests(data.requests ?? []);
      setRequestsLoaded(true);
    } catch {
      setRequests([]);
    } finally {
      setRequestsLoading(false);
    }
  }, [roomId, isAdmin]);

  const switchTab = useCallback((t: "options" | "members" | "requests") => {
    setTab(t);
    if (t === "requests" && !requestsLoaded) void fetchRequests();
  }, [fetchRequests, requestsLoaded]);

  async function handleApprove(req: JoinRequest) {
    if (!req.user?.publicKey) return;
    setProcessingId(req.userId);
    try {
      await approveJoinRequest(roomId, req.userId, req.user.publicKey);
      setRequests((prev) => prev.filter((r) => r.userId !== req.userId));
      onMembersRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approval failed");
    } finally {
      setProcessingId(null);
    }
  }

  async function handleReject(targetUserId: string) {
    setProcessingId(targetUserId);
    try {
      await fetch(`/api/rooms/${roomId}/join-requests/${targetUserId}`, {
        method: "DELETE",
        credentials: "include",
      });
      setRequests((prev) => prev.filter((r) => r.userId !== targetUserId));
    } catch {
      toast.error("Rejection failed");
    } finally {
      setProcessingId(null);
    }
  }

  async function handleRejectAll() {
    if (requests.length === 0) return;
    setRejectAllLoading(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/batch-reject`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Batch reject failed");
      setRequests([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Batch reject failed");
    } finally {
      setRejectAllLoading(false);
    }
  }

  function openMemberAction(member: RoomMemberEntry) {
    // Only admins/owners can act; never on the OWNER target (except via Transfer Ownership below)
    if (viewerRole === "MEMBER") return;
    if (member.role === "OWNER") return;
    setActionTarget(member);
  }

  async function execAction(fn: () => Promise<void>) {
    setActionLoading(true);
    try {
      await fn();
      setActionTarget(null);
      onMembersRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(false);
    }
  }

  const tabs = [
    { id: "options" as const, label: "Options" },
    { id: "members" as const, label: `Members (${members.length})` },
    ...(isAdmin ? [{ id: "requests" as const, label: "Requests" }] : []),
  ];

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden relative">
      {/* Tab bar */}
      <div className="flex shrink-0 border-b border-neutral-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => switchTab(t.id)}
            className={`flex-1 py-2.5 text-[10px] uppercase tracking-wider transition ${
              tab === t.id ? "bg-white text-black" : "text-neutral-500 hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── OPTIONS TAB ── */}
      {tab === "options" && (
        <div className="flex flex-1 flex-col overflow-y-auto">
          <div className="border-b border-neutral-900 p-4">
            <p className="text-[10px] uppercase tracking-wider text-neutral-500">Room</p>
            <p className="mt-1 text-sm font-semibold text-white">{roomName}</p>
            {roomDescription && (
              <p className="mt-1 text-xs text-neutral-400 leading-relaxed">{roomDescription}</p>
            )}
          </div>

          {/* Copy invite link */}
          <div className="border-b border-neutral-900 p-4">
            <p className="text-[10px] uppercase tracking-wider text-neutral-500">Invite Link</p>
            <div className="mt-2 flex gap-2">
              <code className="flex-1 truncate border border-neutral-800 bg-black px-2 py-2 text-[11px] text-neutral-400">
                {inviteUrl}
              </code>
              <button
                type="button"
                onClick={() => void copy()}
                className="flex h-9 w-9 shrink-0 items-center justify-center border border-neutral-700 text-neutral-400 transition hover:border-neutral-500 hover:text-white"
                aria-label="Copy invite link"
              >
                {copied ? <Check size={14} className="text-green-400" /> : <Link2 size={14} />}
              </button>
            </div>
            {copied && <p className="mt-1 text-[10px] text-neutral-500">Link copied!</p>}
          </div>

          {/* Spacer to push stacked action buttons to bottom */}
          <div className="flex-1 min-h-[20px]" />

          {/* Stacked bottom buttons: Edit Details, Disable / Restore Room, Leave Room */}
          <div className="p-4 flex flex-col gap-2.5 border-t border-neutral-900">
            {isAdmin && onEditDetails && (
              <button
                type="button"
                onClick={() => {
                  setEditName(roomName);
                  setEditDescription(roomDescription || "");
                  setIsEditOpen(true);
                }}
                className="w-full border border-neutral-700 bg-neutral-900 py-2.5 text-xs font-medium uppercase tracking-wider text-white transition hover:border-neutral-500 hover:bg-neutral-800"
              >
                Edit Details
              </button>
            )}

            {viewerRole === "OWNER" && onToggleDisable && (
              <button
                type="button"
                onClick={onToggleDisable}
                className={`w-full border py-2.5 text-xs uppercase tracking-wider transition ${
                  isDisabled
                    ? "border-green-500/30 text-green-400 hover:border-green-500/60 hover:bg-green-950/20"
                    : "border-red-500/30 text-red-400 hover:border-red-500/60 hover:bg-red-950/20"
                }`}
              >
                {isDisabled ? "Restore Room" : "Disable Room"}
              </button>
            )}

            {viewerRole !== "OWNER" && (
              <button
                type="button"
                onClick={onLeaveRequest}
                className="w-full border border-red-500/40 bg-red-950/30 py-2.5 text-xs font-medium uppercase tracking-wider text-red-400 transition hover:bg-red-950/60"
              >
                Leave Room
              </button>
            )}
          </div>
        </div>
      )}

      {/* Edit Details Modal */}
      {isEditOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md border border-neutral-800 bg-neutral-950 p-6 shadow-2xl">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-white">Edit Room Details</h3>
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-neutral-400">Room Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="mt-1 w-full border border-neutral-800 bg-black px-3 py-2 text-xs text-white focus:border-neutral-500 focus:outline-none"
                  placeholder="Enter room name"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-neutral-400">Description</label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={3}
                  className="mt-1 w-full border border-neutral-800 bg-black px-3 py-2 text-xs text-white focus:border-neutral-500 focus:outline-none resize-none"
                  placeholder="Enter room description"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setIsEditOpen(false)}
                disabled={savingDetails}
                className="px-4 py-2 text-xs uppercase tracking-wider text-neutral-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={savingDetails || !editName.trim()}
                onClick={async () => {
                  if (!onEditDetails) return;
                  setSavingDetails(true);
                  try {
                    await onEditDetails(editName.trim(), editDescription.trim());
                    setIsEditOpen(false);
                  } catch {
                    toast.error("Failed to update room details");
                  } finally {
                    setSavingDetails(false);
                  }
                }}
                className="border border-white bg-white px-4 py-2 text-xs uppercase tracking-wider text-black font-semibold hover:bg-neutral-200 disabled:opacity-50"
              >
                {savingDetails ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MEMBERS TAB ── */}
      {tab === "members" && (
        <div className="flex flex-1 flex-col min-h-0">
          <DebounceSearch placeholder="Search members..." onSearch={handleMemberSearch} />
          <ul className="flex-1 overflow-y-auto">
            {filtered.length === 0 && (
              <li className="px-4 py-8 text-center text-xs text-neutral-600">No members found.</li>
            )}
            {filtered.map((m) => {
              const isOnline = onlineUserIds.has(m.userId);
              const isClickable = viewerRole !== "MEMBER" && m.role !== "OWNER";
              return (
                <li key={m.userId}>
                  <button
                    type="button"
                    disabled={!isClickable}
                    onClick={() => openMemberAction(m)}
                    className={`flex w-full items-center gap-3 border border-transparent px-4 py-2.5 text-left transition ${
                      isClickable ? "hover:border-neutral-800 hover:bg-neutral-950" : "cursor-default"
                    }`}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? "bg-green-500" : "bg-neutral-700"}`}
                    />
                    <Avatar pfp={m.user?.pfp} size={28} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-white">
                        {displayName(m)}
                        {m.userIndex != null && (
                          <span className="ml-1 text-neutral-500">#{m.userIndex}</span>
                        )}
                      </p>
                      <p className="text-[10px] uppercase tracking-wider text-neutral-600">{m.role}</p>
                    </div>
                    {isClickable && (
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-neutral-700">
                        ···
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ── REQUESTS TAB ── */}
      {tab === "requests" && (
        <div className="flex flex-1 flex-col min-h-0 overflow-y-auto">
          {requestsLoading && (
            <p className="p-6 text-center text-xs text-neutral-500">Loading requests...</p>
          )}
          {!requestsLoading && requests.length === 0 && (
            <p className="p-6 text-center text-xs text-neutral-600">No pending join requests.</p>
          )}
          {!requestsLoading && requests.length > 0 && (
            <>
              <div className="p-3">
                <button
                  type="button"
                  disabled={rejectAllLoading}
                  onClick={() => void handleRejectAll()}
                  className="w-full border border-red-500/30 py-2 text-[10px] uppercase tracking-wider text-red-400 transition hover:bg-red-950/20 disabled:opacity-50"
                >
                  {rejectAllLoading ? "Rejecting..." : `Reject All (${requests.length})`}
                </button>
              </div>
              <ul className="space-y-2 px-3 pb-4">
                {requests.map((req) => (
                  <li key={req.userId} className="border border-neutral-900 bg-black p-3">
                    <div className="flex items-center gap-3">
                      <Avatar pfp={req.user?.pfp} size={28} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-white">
                          {req.user?.name || req.user?.email || "Anonymous"}
                        </p>
                        <p className="text-[10px] text-neutral-600">
                          {new Date(req.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        disabled={!!processingId || !req.user?.publicKey}
                        onClick={() => void handleApprove(req)}
                        className="flex-1 border border-white/20 py-1.5 text-[10px] uppercase tracking-wider text-white transition hover:bg-white/10 disabled:opacity-40"
                      >
                        {processingId === req.userId ? "..." : "Approve"}
                      </button>
                      <button
                        type="button"
                        disabled={!!processingId}
                        onClick={() => void handleReject(req.userId)}
                        className="flex-1 border border-neutral-800 py-1.5 text-[10px] uppercase tracking-wider text-neutral-400 transition hover:border-neutral-600 disabled:opacity-40"
                      >
                        Reject
                      </button>
                    </div>
                    {!req.user?.publicKey && (
                      <p className="mt-1 text-[10px] text-red-500">User missing encryption key</p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* Member action dialog */}
      {actionTarget && (
        <MemberActionDialog
          member={actionTarget as ActionMember}
          viewerRole={viewerRole}
          loading={actionLoading}
          onClose={() => setActionTarget(null)}
          onKickout={() => execAction(() => onKickout(actionTarget.userId))}
          onPromoteAdmin={() => execAction(() => onRoleChange(actionTarget.userId, "ADMIN"))}
          onDemoteMember={() => execAction(() => onRoleChange(actionTarget.userId, "MEMBER"))}
          onTransferOwnership={() => execAction(() => onRoleChange(actionTarget.userId, "OWNER"))}
        />
      )}
    </div>
  );
}
