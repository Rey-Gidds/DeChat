"use client";

import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useSession } from "@/lib/auth-client";
import {
  getGlobalSocket,
  setGlobalSocket,
  startGlobalHeartbeat,
  stopHeartbeat,
  USE_GLOBAL_SOCKET,
} from "@/lib/socket-client";
import type { Socket } from "socket.io-client";
import { useUnreadStore } from "@/lib/unread-store";
import { useSWRConfig } from "swr";
import { connectAsUser } from "@/lib/socket-client";
import { toast } from "sonner";

interface GlobalSocketContextValue {
  socket: Socket | null;
  connected: boolean;
  subscribeRoom: (roomId: string) => Promise<void>;
}

const GlobalSocketContext = createContext<GlobalSocketContextValue>({
  socket: null,
  connected: false,
  subscribeRoom: async () => {},
});

export function useGlobalSocket(): GlobalSocketContextValue {
  return useContext(GlobalSocketContext);
}

const ACK_TIMEOUT_MS = 7_000;

async function emitSubscribeRoom(socket: Socket, roomId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("subscribe_room timeout")), ACK_TIMEOUT_MS);
    socket.emit(
      "subscribe_room",
      { roomId },
      (_err: unknown, res: { ok: boolean; error?: string }) => {
        clearTimeout(timeout);
        if (res?.ok) resolve();
        else reject(new Error(res?.error || "subscribe_room failed"));
      }
    );
  });
}

function revalidateRooms(mutate: ReturnType<typeof useSWRConfig>["mutate"]) {
  void mutate((k) => typeof k === "string" && k.startsWith("/api/rooms"));
  void mutate((k) => typeof k === "string" && k.startsWith("/api/me"));
}

export function GlobalSocketProvider({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const { mutate: globalMutate } = useSWRConfig();
  const { loadFromDB, increment, clear: clearUnread, versions, syncFromServer } = useUnreadStore();

  const [socketState, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const mountedRef = useRef(true);

  // ── Server-sync helper ──────────────────────────────────────────

  async function syncUnreadCountsFromServer() {
    try {
      const res = await fetch("/api/unread-counts", { credentials: "include" });
      if (!res.ok) {
        console.warn("[GlobalSocket] Failed to sync unread counts from server:", res.status);
        return;
      }
      const data = await res.json();
      if (data.counts) {
        await syncFromServer(data.counts);
      }
    } catch (err) {
      console.warn("[GlobalSocket] Failed to sync unread counts from server", err);
    }
  }

  // ── connect / disconnect lifecycle ─────────────────────────────

  useEffect(() => {
    mountedRef.current = true;

    if (!USE_GLOBAL_SOCKET || isPending || !session?.user) return;

    let s: Socket | null = null;

    void (async () => {
      try {
        s = await connectAsUser();
        if (!mountedRef.current) {
          s.disconnect();
          return;
        }
        setGlobalSocket(s);
        setSocket(s);
        if (s.connected) {
          setConnected(true);
          void loadFromDB();
          void syncUnreadCountsFromServer();
        }

        s.on("connect", () => {
          if (mountedRef.current) {
            setConnected(true);
            void loadFromDB();
            void syncUnreadCountsFromServer();
          }
        });

        s.io.on("reconnect", () => {
          if (mountedRef.current) {
            void syncUnreadCountsFromServer();
          }
        });

        s.on("disconnect", () => {
          if (mountedRef.current) {
            setConnected(false);
          }
        });

        s.io.on("reconnect_failed", () => {
          if (mountedRef.current) {
            toast.error("Could not reconnect. Check your internet.", { id: "global-socket", duration: Infinity });
          }
        });
      } catch (err) {
        console.warn("[GlobalSocket] connect failed:", err);
      }
    })();

    return () => {
      mountedRef.current = false;
      // Don't disconnect here — the global socket must outlive component unmounts
    };
  }, [session?.user, isPending]);

  // ── permanent listeners ────────────────────────────────────────

  useEffect(() => {
    const s = getGlobalSocket();
    if (!s) return;

    const onUnreadIncrement = (p: { roomId: string; unreadCount: number; version: number; createdAt?: string | number }) => {
      const ts = p.createdAt ? new Date(p.createdAt).getTime() : undefined;
      void increment(p.roomId, p.unreadCount, p.version, ts);
      revalidateRooms(globalMutate);
    };

    const onUnreadCountUpdated = (p: { roomId: string; unreadCount: number; version: number }) => {
      if (p.unreadCount === 0) {
        void clearUnread(p.roomId, p.version);
      } else {
        void increment(p.roomId, p.unreadCount, p.version);
      }
    };

    const onMemberKicked = (p: { roomId: string; roomName?: string }) => {
      void clearUnread(p.roomId);
      revalidateRooms(globalMutate);
      toast.error(`You were removed from ${p.roomName || "a room"}`);
    };

    const onMemberLeft = (p: { roomId: string; roomName?: string }) => {
      void clearUnread(p.roomId);
      revalidateRooms(globalMutate);
    };

    const onMemberJoined = (p: { roomId: string; roomName?: string }) => {
      void emitSubscribeRoom(s, p.roomId).catch((err) =>
        console.warn("[GlobalSocket] subscribe_room on join failed:", err)
      );
      revalidateRooms(globalMutate);
    };

    const onRoomDeleted = (p: { roomId: string; roomName?: string }) => {
      void clearUnread(p.roomId);
      revalidateRooms(globalMutate);
      toast.error(`${p.roomName || "A room"} has been deleted`);
    };

    const onMembershipUpdated = () => revalidateRooms(globalMutate);
    const onRequestApproved = () => revalidateRooms(globalMutate);
    const onRequestRejected = () => revalidateRooms(globalMutate);
    const onRoomUpdated = () => revalidateRooms(globalMutate);

    s.on("user_unread_increment", onUnreadIncrement);
    s.on("unread_count_updated", onUnreadCountUpdated);
    s.on("room_member_kicked", onMemberKicked);
    s.on("room_member_left", onMemberLeft);
    s.on("room_member_joined", onMemberJoined);
    s.on("room_deleted", onRoomDeleted);
    s.on("membership_updated", onMembershipUpdated);
    s.on("REQUEST_APPROVED", onRequestApproved);
    s.on("REQUEST_REJECTED", onRequestRejected);
    s.on("room_updated", onRoomUpdated);
    s.on("room_renamed", onRoomUpdated);

    return () => {
      s.off("user_unread_increment", onUnreadIncrement);
      s.off("unread_count_updated", onUnreadCountUpdated);
      s.off("room_member_kicked", onMemberKicked);
      s.off("room_member_left", onMemberLeft);
      s.off("room_member_joined", onMemberJoined);
      s.off("room_deleted", onRoomDeleted);
      s.off("membership_updated", onMembershipUpdated);
      s.off("REQUEST_APPROVED", onRequestApproved);
      s.off("REQUEST_REJECTED", onRequestRejected);
      s.off("room_updated", onRoomUpdated);
      s.off("room_renamed", onRoomUpdated);
    };
  }, [socketState]);

  // ── heartbeat ──────────────────────────────────────────────────

  useEffect(() => {
    if (!socketState || !connected) return;
    startGlobalHeartbeat();
    return () => stopHeartbeat();
  }, [socketState, connected]);

  // ── initial IDB hydration ──────────────────────────────────────

  useEffect(() => {
    if (socketState && connected) {
      void loadFromDB();
    }
  }, [!!socketState && connected]);

  // ── subscribeRoom exposed to consumers ─────────────────────────

  const subscribeRoom = useCallback(
    async (roomId: string) => {
      const s = getGlobalSocket();
      if (!s?.connected) return;
      await emitSubscribeRoom(s, roomId);
    },
    []
  );

  if (!USE_GLOBAL_SOCKET) {
    return <>{children}</>;
  }

  return (
    <GlobalSocketContext.Provider value={{ socket: socketState, connected, subscribeRoom }}>
      {children}
    </GlobalSocketContext.Provider>
  );
}
