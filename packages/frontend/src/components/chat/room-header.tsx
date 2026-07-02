"use client";

import { ArrowLeft, Copy, Link2, Users, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { approveJoinRequest } from "@/lib/room-membership-client";

interface RoomMember {
  userId: string;
  role: string;
  joinedAt?: string;
  userIndex?: number | null;
  user: { name?: string; email?: string; image?: string } | null;
}

interface RoomHeaderProps {
  roomName: string;
  memberCount: number;
  roomLink: string;
  status: string;
  onOpenMembers: () => void;
  onToggleDisable?: () => void;
  isOwner?: boolean;
  isDisabled?: boolean;
}

export function RoomHeader({
  roomName,
  memberCount,
  roomLink,
  status,
  onOpenMembers,
  onToggleDisable,
  isOwner,
  isDisabled,
}: RoomHeaderProps) {
  const [copied, setCopied] = useState(false);
  const inviteUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/join/${roomLink}`
      : `/join/${roomLink}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-neutral-800 bg-black px-3 py-3 sm:px-4">
      <Link
        href="/"
        className="flex h-9 w-9 shrink-0 items-center justify-center border border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white"
        aria-label="Back to discovery"
      >
        <ArrowLeft size={18} />
      </Link>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold text-white">{roomName}</h1>
        <p className="truncate text-[11px] text-neutral-500">
          {status} · {memberCount} members
        </p>
      </div>

      <button
        onClick={copyLink}
        className="hidden items-center gap-1.5 border border-neutral-800 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-neutral-400 hover:border-neutral-600 hover:text-white sm:flex"
        title="Copy invite link"
      >
        <Link2 size={14} />
        {copied ? "Copied" : "Invite"}
      </button>

      <button
        onClick={onOpenMembers}
        className="flex h-9 w-9 shrink-0 items-center justify-center border border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white"
        aria-label="View members"
      >
        <Users size={18} />
      </button>

      {isOwner && onToggleDisable && (
        <button
          onClick={onToggleDisable}
          className={`flex h-9 shrink-0 items-center gap-1.5 border px-2.5 text-[10px] uppercase tracking-wider transition ${
            isDisabled
              ? "border-green-500/30 text-green-400 hover:border-green-500/60"
              : "border-red-500/30 text-red-400 hover:border-red-500/60"
          }`}
          title={isDisabled ? "Restore room" : "Disable room"}
        >
          {isDisabled ? "Restore" : "Disable"}
        </button>
      )}
    </header>
  );
}

interface MembersPanelProps {
  open: boolean;
  onClose: () => void;
  members: RoomMember[];
  onlineUserIds: Set<string>;
  roomLink: string;
  roomId?: string;
  isAdmin?: boolean;
}

interface JoinRequest {
  userId: string;
  membershipId: string;
  createdAt: string;
  status?: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  user: { name?: string; email?: string; publicKey: string | null } | null;
}

export function MembersPanel({
  open,
  onClose,
  members,
  onlineUserIds,
  roomLink,
  roomId,
  isAdmin,
}: MembersPanelProps) {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<"members" | "requests">("members");
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [rejectAllLoading, setRejectAllLoading] = useState(false);

  const inviteUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/join/${roomLink}`
      : `/join/${roomLink}`;

  const fetchRequests = useCallback(async () => {
    if (!roomId || !isAdmin) return;
    setRequestsLoading(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/join-requests`, {
        credentials: "include",
      });
      const data = await res.json();
      setRequests(data.requests ?? []);
    } catch {
      setRequests([]);
    } finally {
      setRequestsLoading(false);
    }
  }, [roomId, isAdmin]);

  useEffect(() => {
    if (open && isAdmin && activeTab === "requests") {
      void fetchRequests();
    }
  }, [open, isAdmin, activeTab, fetchRequests]);

  if (!open) return null;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  async function handleApprove(req: JoinRequest) {
    if (!roomId || !req.user?.publicKey) return;
    setProcessingId(req.userId);
    try {
      await approveJoinRequest(roomId, req.userId, req.user.publicKey);
      setRequests((prev) => prev.filter((r) => r.userId !== req.userId));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Approval failed");
    } finally {
      setProcessingId(null);
    }
  }

  async function handleReject(targetUserId: string) {
    if (!roomId) return;
    setProcessingId(targetUserId);
    try {
      await fetch(`/api/rooms/${roomId}/join-requests/${targetUserId}`, {
        method: "DELETE",
        credentials: "include",
      });
      setRequests((prev) => prev.filter((r) => r.userId !== targetUserId));
    } catch {
      alert("Rejection failed");
    } finally {
      setProcessingId(null);
    }
  }

  async function handleRejectAll() {
    if (!roomId || requests.length === 0) return;
    setRejectAllLoading(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/batch-reject`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Batch reject failed");
      setRequests([]);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Batch reject failed");
    } finally {
      setRejectAllLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60">
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <aside className="relative flex h-full w-full max-w-sm flex-col border-l border-neutral-800 bg-neutral-950">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-white">
            {roomLink ? "Room Details" : "Members"}
          </h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-white">
            <X size={18} />
          </button>
        </div>

        {isAdmin && (
          <div className="flex border-b border-neutral-800">
            <button
              onClick={() => setActiveTab("members")}
              className={`flex-1 py-2.5 text-[10px] uppercase tracking-wider transition ${
                activeTab === "members" ? "bg-white text-black" : "text-neutral-500 hover:text-white"
              }`}
            >
              Members
            </button>
            <button
              onClick={() => setActiveTab("requests")}
              className={`flex-1 py-2.5 text-[10px] uppercase tracking-wider transition ${
                activeTab === "requests" ? "bg-white text-black" : "text-neutral-500 hover:text-white"
              }`}
            >
              Requests {requests.length > 0 && `(${requests.length})`}
            </button>
          </div>
        )}

        {activeTab === "members" ? (
          <>
            <div className="border-b border-neutral-900 p-4">
              <p className="text-[10px] uppercase tracking-wider text-neutral-500">
                Invite link
              </p>
              <div className="mt-2 flex gap-2">
                <code className="flex-1 truncate border border-neutral-800 bg-black px-2 py-2 text-[11px] text-neutral-400">
                  {inviteUrl}
                </code>
                <Button variant="secondary" size="sm" onClick={() => void copyLink()}>
                  <Copy size={14} />
                </Button>
              </div>
              {copied && (
                <p className="mt-1 text-[10px] text-neutral-500">Link copied</p>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {members.length === 0 ? (
                <p className="p-4 text-xs text-neutral-500">No members found.</p>
              ) : (
                <div className="space-y-4">
                  {/* Online Section */}
                  {members.filter((m) => onlineUserIds.has(m.userId)).length > 0 && (
                    <div>
                      <p className="px-3 pb-1 text-[10px] uppercase tracking-wider text-green-500">
                        Online — {members.filter((m) => onlineUserIds.has(m.userId)).length}
                      </p>
                      <ul className="space-y-1">
                        {members
                          .filter((m) => onlineUserIds.has(m.userId))
                          .map((member) => (
                            <li
                              key={member.userId}
                              className="flex items-center justify-between border border-transparent px-3 py-2.5 hover:border-neutral-900 hover:bg-black"
                            >
                              <div className="min-w-0 flex items-center gap-2">
                                <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
                                <div>
                                  <p className="truncate text-sm text-white">
                                    {member.user?.name || member.user?.email || "Anonymous"}
                                    <span className="text-neutral-500">
                                      #{member.userIndex ?? "?"}
                                    </span>
                                  </p>
                                  <p className="text-[10px] uppercase tracking-wider text-neutral-600">
                                    {member.role}
                                  </p>
                                </div>
                              </div>
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}

                  {/* Offline Section */}
                  {members.filter((m) => !onlineUserIds.has(m.userId)).length > 0 && (
                    <div>
                      <p className="px-3 pb-1 text-[10px] uppercase tracking-wider text-neutral-600">
                        Offline — {members.filter((m) => !onlineUserIds.has(m.userId)).length}
                      </p>
                      <ul className="space-y-1">
                        {members
                          .filter((m) => !onlineUserIds.has(m.userId))
                          .map((member) => (
                            <li
                              key={member.userId}
                              className="flex items-center justify-between border border-transparent px-3 py-2.5 hover:border-neutral-900 hover:bg-black"
                            >
                              <div className="min-w-0 flex items-center gap-2">
                                <span className="h-2 w-2 rounded-full bg-neutral-700 shrink-0" />
                                <div>
                                  <p className="truncate text-sm text-white">
                                    {member.user?.name || member.user?.email || "Anonymous"}
                                    <span className="text-neutral-500">
                                      #{member.userIndex ?? "?"}
                                    </span>
                                  </p>
                                  <p className="text-[10px] uppercase tracking-wider text-neutral-600">
                                    {member.role}
                                  </p>
                                </div>
                              </div>
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto p-2">
            {requestsLoading ? (
              <p className="p-4 text-xs text-neutral-500">Loading requests...</p>
            ) : requests.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-xs text-neutral-500">No pending join requests.</p>
              </div>
            ) : (
              <>
                <div className="mb-3 flex gap-2 px-1">
                  <Button
                    size="sm"
                    variant="danger"
                    className="flex-1 text-[10px] uppercase tracking-wider"
                    disabled={rejectAllLoading}
                    onClick={() => void handleRejectAll()}
                  >
                    {rejectAllLoading ? "Rejecting..." : `Reject All (${requests.length})`}
                  </Button>
                </div>
                <ul className="space-y-2">
                  {requests.map((req) => (
                    <li
                      key={req.userId}
                      className="border border-neutral-900 bg-black p-3"
                    >
                      <div className="mb-3">
                        <p className="truncate text-sm text-white">
                          {req.user?.name || req.user?.email || "Anonymous"}
                        </p>
                        <p className="text-[10px] text-neutral-600">
                          {new Date(req.createdAt).toLocaleString()}
                        </p>
                        {req.reviewedAt && (
                          <p className="mt-1 text-[10px] text-neutral-600">
                            Reviewed {new Date(req.reviewedAt).toLocaleString()}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          className="flex-1 text-[10px]"
                          disabled={!!processingId || !req.user?.publicKey}
                          onClick={() => void handleApprove(req)}
                        >
                          {processingId === req.userId ? "..." : "Approve"}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="flex-1 text-[10px]"
                          disabled={!!processingId}
                          onClick={() => void handleReject(req.userId)}
                        >
                          Reject
                        </Button>
                      </div>
                      {!req.user?.publicKey && (
                        <p className="mt-2 text-[10px] text-red-500">
                          User missing encryption key
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
