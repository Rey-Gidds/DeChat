"use client";

import { Modal } from "./modal";
import { ShieldCheck, ShieldOff, Crown, UserX } from "lucide-react";

export interface ActionMember {
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  user: { name?: string; email?: string } | null;
  userIndex?: number | null;
}

interface MemberActionDialogProps {
  member: ActionMember;
  viewerRole: "OWNER" | "ADMIN" | "MEMBER";
  onKickout: () => void;
  onPromoteAdmin: () => void;
  onDemoteMember: () => void;
  onTransferOwnership: () => void;
  onClose: () => void;
  loading?: boolean;
}

function displayName(m: ActionMember) {
  return m.user?.name || m.user?.email || "Anonymous";
}

export function MemberActionDialog({
  member,
  viewerRole,
  onKickout,
  onPromoteAdmin,
  onDemoteMember,
  onTransferOwnership,
  onClose,
  loading,
}: MemberActionDialogProps) {
  const name = displayName(member);
  const indexLabel = member.userIndex != null ? `#${member.userIndex}` : "";

  // Build action list based on role matrix
  const actions: { label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }[] = [];

  if (member.role === "MEMBER") {
    if (viewerRole === "OWNER" || viewerRole === "ADMIN") {
      actions.push({
        label: "Promote to Admin",
        icon: <ShieldCheck size={15} />,
        onClick: onPromoteAdmin,
      });
    }
    if (viewerRole === "OWNER" || viewerRole === "ADMIN") {
      actions.push({
        label: "Kick Out",
        icon: <UserX size={15} />,
        onClick: onKickout,
        danger: true,
      });
    }
  }

  if (member.role === "ADMIN") {
    if (viewerRole === "OWNER") {
      actions.push({
        label: "Demote to Member",
        icon: <ShieldOff size={15} />,
        onClick: onDemoteMember,
        danger: true,
      });
      actions.push({
        label: "Transfer Ownership",
        icon: <Crown size={15} />,
        onClick: onTransferOwnership,
      });
    }
    if (viewerRole === "ADMIN") {
      actions.push({
        label: "Kick Out",
        icon: <UserX size={15} />,
        onClick: onKickout,
        danger: true,
      });
    }
  }

  if (member.role === "OWNER") {
    // No actions on the owner; this dialog shouldn't even open for them, but guard anyway.
  }

  return (
    <Modal title={`${name} ${indexLabel}`} onClose={onClose} className="max-w-xs">
      <div className="p-2">
        <p className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-neutral-600">
          {member.role}
        </p>
        {actions.length === 0 && (
          <p className="px-2 py-4 text-xs text-neutral-500">No actions available.</p>
        )}
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={loading}
            onClick={action.onClick}
            className={`flex w-full items-center gap-3 px-3 py-2.5 text-sm transition disabled:opacity-50 ${
              action.danger
                ? "text-red-400 hover:bg-red-950/30"
                : "text-neutral-300 hover:bg-neutral-900"
            }`}
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}
