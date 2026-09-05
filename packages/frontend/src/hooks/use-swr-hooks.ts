"use client";

import useSWR, { useSWRConfig } from "swr";
import { useEffect } from "react";
import { SWR_KEYS } from "@/lib/swr-config";
import type { PfpMetadata } from "@/lib/models";
import {
  connectAsUser,
  USE_GLOBAL_SOCKET,
  getGlobalSocket,
} from "@/lib/socket-client";

export interface UserProfileData {
  id: string;
  name: string;
  email: string;
  publicKey: string | null;
  image?: string;
  pfp?: PfpMetadata | null;
  pfpNeedsReupload?: boolean;
}


export interface MyRoomItem {
  roomId: string;
  status: string;
  role: string;
  joinedAt?: string;
  room: {
    _id?: string;
    id?: string;
    name: string;
    description?: string;
    joinPolicy?: string;
    isDisabled?: boolean;
    maxMembers?: number;
    memberCount?: number;
    onlineCount?: number;
  } | null;

}

export interface PendingRequestItem {
  roomId: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | string;
  requestedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  room: { id: string; name: string; isDisabled: boolean } | null;
}

/** User profile hook with optimistic update capabilities */
export function useUser() {
  const { data, error, isLoading, mutate } = useSWR<UserProfileData>(SWR_KEYS.me, {
    revalidateOnFocus: true,
    dedupingInterval: 5_000,
  });

  const updateProfileName = async (newName: string) => {
    return mutate(
      async (current) => {
        const res = await fetch("/api/me", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ name: newName }),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || "Failed to update profile name");
        }
        const updated = await res.json();
        return current ? { ...current, name: updated.name ?? newName } : current;
      },
      {
        optimisticData: (current) => ({ ...(current ?? {}), name: newName } as UserProfileData),
        rollbackOnError: true,
        revalidate: true,
      }
    );
  };

  return {
    user: data ?? null,
    isLoading,
    error,
    mutateUser: mutate,
    updateProfileName,
  };
}

/** Hook for owned/joined room memberships with optimistic toggle disable mutation */
export function useMyRooms(status = "APPROVED") {
  const key = SWR_KEYS.myRooms(status);
  const { data, error, isLoading, mutate } = useSWR<{ memberships: MyRoomItem[] }>(key, {
    revalidateOnFocus: true,
    dedupingInterval: 5_000,
  });
  const { mutate: globalMutate } = useSWRConfig();

  const memberships = data?.memberships ?? [];
  const ownedRooms = memberships.filter((m) => m.role === "OWNER");

  const toggleRoomDisable = async (roomId: string) => {
    return mutate(
      async (currentData) => {
        const res = await fetch(`/api/rooms/${roomId}/disable`, {
          method: "PATCH",
          credentials: "include",
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || "Failed to toggle room status");
        }
        const resData = await res.json();

        // Invalidate discovery and joined caches so state reflects immediately across tabs
        void globalMutate((k) => typeof k === "string" && k.startsWith("/api/rooms"));

        if (!currentData) return currentData;
        return {
          ...currentData,
          memberships: currentData.memberships.map((m) =>
            m.roomId === roomId
              ? { ...m, room: m.room ? { ...m.room, isDisabled: Boolean(resData.isDisabled) } : m.room }
              : m
          ),
        };
      },
      {
        optimisticData: currentData => {
          if (!currentData) return { memberships: [] };
          return {
            ...currentData,
            memberships: currentData.memberships.map((m) =>
              m.roomId === roomId
                ? { ...m, room: m.room ? { ...m.room, isDisabled: !Boolean(m.room.isDisabled) } : m.room }
                : m
            ),
          };
        },
        rollbackOnError: true,
        revalidate: true,
      }
    );
  };

  return {
    memberships,
    ownedRooms,
    isLoading,
    error,
    mutateMyRooms: mutate,
    toggleRoomDisable,
  };
}

/** Hook for pending room requests with Socket.IO real-time auto-revalidation */
export function usePendingRequests() {
  const { data, error, isLoading, mutate } = useSWR<{ requests: PendingRequestItem[] }>(
    SWR_KEYS.pendingRequests,
    {
      revalidateOnFocus: true,
      dedupingInterval: 5_000,
    }
  );

  useEffect(() => {
    let mounted = true;

    if (USE_GLOBAL_SOCKET) {
      // Use the global socket — already connected by GlobalSocketProvider
      const s = getGlobalSocket();
      if (!s) return;

      const handleUpdate = () => {
        if (mounted) void mutate();
      };

      s.on("REQUEST_APPROVED", handleUpdate);
      s.on("REQUEST_REJECTED", handleUpdate);
      s.on("membership_updated", handleUpdate);

      return () => {
        s.off("REQUEST_APPROVED", handleUpdate);
        s.off("REQUEST_REJECTED", handleUpdate);
        s.off("membership_updated", handleUpdate);
      };
    }

    // Legacy per-room path
    connectAsUser()
      .then((socket) => {
        const handleUpdate = () => {
          if (mounted) void mutate();
        };

        socket.on("REQUEST_APPROVED", handleUpdate);
        socket.on("REQUEST_REJECTED", handleUpdate);
        socket.on("membership_updated", handleUpdate);

        return () => {
          socket.off("REQUEST_APPROVED", handleUpdate);
          socket.off("REQUEST_REJECTED", handleUpdate);
          socket.off("membership_updated", handleUpdate);
        };
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, [mutate]);

  return {
    requests: data?.requests ?? [],
    isLoading,
    error,
    refreshRequests: mutate,
  };
}

/** Hook for room discovery with smooth transition filtering */
export function useDiscoveryRooms(query: string, tags: string[]) {
  const key = SWR_KEYS.discoveryRooms(query, tags);
  const { data, error, isLoading, mutate } = useSWR<{ rooms: any[] }>(key, {
    keepPreviousData: true,
    dedupingInterval: 5_000,
  });

  return {
    rooms: data?.rooms ?? [],
    isLoading,
    error,
    mutateDiscovery: mutate,
  };
}
