"use client";

import { Modal } from "./modal";
import { ShieldCheck, ShieldOff, Crown, UserX } from "lucide-react";
import { Avatar } from "../avatar";

export interface ActionMember {
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  user: { name?: string; email?: string; pfp?: string | null } | null;
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

  const actions: { label: string; icon: React.ElementType; onClick: () => void; danger?: boolean }[] = [];

  if (member.role === "MEMBER") {
    if (viewerRole === "OWNER" || viewerRole === "ADMIN") {
      actions.push({ label: "Promote to Admin", icon: ShieldCheck, onClick: onPromoteAdmin });
    }
    if (viewerRole === "OWNER" || viewerRole === "ADMIN") {
      actions.push({ label: "Kick Out", icon: UserX, onClick: onKickout, danger: true });
    }
  }

  if (member.role === "ADMIN") {
    if (viewerRole === "OWNER") {
      actions.push({ label: "Demote to Member", icon: ShieldOff, onClick: onDemoteMember, danger: true });
      actions.push({ label: "Transfer Ownership", icon: Crown, onClick: onTransferOwnership });
    }
    if (viewerRole === "ADMIN") {
      actions.push({ label: "Kick Out", icon: UserX, onClick: onKickout, danger: true });
    }
  }

  return (
    <Modal
      title={`${name} ${indexLabel}`}
      subtitle={member.role}
      onClose={onClose}
      className="max-w-xs"
      headerIcon={<Avatar pfp={member.user?.pfp} size={18} />}
    >
      <div className="p-2">
        {actions.length === 0 && (
          <p className="px-3 py-4 text-xs text-neutral-500 text-center">No actions available.</p>
        )}
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={loading}
            onClick={action.onClick}
            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition disabled:opacity-50 ${
              action.danger
                ? "text-red-400 hover:bg-red-950/20"
                : "text-neutral-200 hover:bg-neutral-900"
            }`}
          >
            <action.icon size={15} className={action.danger ? "text-red-400" : "text-neutral-500"} />
            {action.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}
