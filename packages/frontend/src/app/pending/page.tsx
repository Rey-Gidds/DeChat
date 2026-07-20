"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { connectAsUser } from "@/lib/socket-client";

type PendingRequestRow = {
  roomId: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | string;
  requestedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  room: { id: string; name: string; isDisabled: boolean } | null;
};

export default function PendingRequestsPage() {
  const { data: session, isPending } = useSession();
  const [rows, setRows] = useState<PendingRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/rooms/requests", { credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load requests");
      setRows((data.requests ?? []) as PendingRequestRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load requests");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isPending) return;
    if (!session?.user) return;
    void load();
  }, [isPending, session, load]);

  useEffect(() => {
    if (isPending || !session?.user) return;
    let mounted = true;
    void connectAsUser()
      .then((sock) => {
        const handler = () => {
          if (!mounted) return;
          void load();
        };
        sock.on("REQUEST_APPROVED", handler);
        sock.on("REQUEST_REJECTED", handler);
        sock.on("membership_updated", handler);
        return () => {
          sock.off("REQUEST_APPROVED", handler);
          sock.off("REQUEST_REJECTED", handler);
          sock.off("membership_updated", handler);
        };
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [isPending, session, load]);

  if (isPending) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-xs uppercase tracking-wider text-neutral-600">Loading...</p>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-sm text-neutral-500">Sign in to view requests.</p>
        <Link href="/sign-in" className="mt-4 inline-block text-xs uppercase tracking-wider text-white underline">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 border border-neutral-800 bg-neutral-950 p-5 sm:p-6">
        <h1 className="mt-2 text-2xl font-semibold text-white sm:text-3xl">Pending Requests</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Track your room access requests.
        </p>
      </div>

      {error && (
        <div className="mb-4 border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="border border-neutral-900 bg-neutral-950 p-6">
          <p className="text-xs uppercase tracking-wider text-neutral-600">Loading…</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="border border-dashed border-neutral-800 px-6 py-16 text-center">
          <p className="text-sm text-neutral-500">No requests found.</p>
          <Link href="/" className="mt-4 inline-block text-xs uppercase tracking-wider text-white underline">
            Back to Discover
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            r.status === "APPROVED" ? (
              <Link key={r.roomId} href={`/rooms/${r.roomId}`}>
                <div key={`${r.roomId}:${r.requestedAt}`} className="border border-neutral-900 bg-black p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">
                        {r.room?.name ?? "Unknown room"}
                      </p>
                      <p className="mt-1 text-[10px] uppercase tracking-wider text-neutral-600">
                        Requested {new Date(r.requestedAt).toLocaleString()}
                      </p>
                      {r.reviewedAt && (
                        <p className="mt-1 text-[10px] uppercase tracking-wider text-neutral-600">
                          Reviewed {new Date(r.reviewedAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <span
                      className={`shrink-0 border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                        r.status === "APPROVED"
                          ? "border-green-500/30 text-green-400"
                          : r.status === "REJECTED"
                            ? "border-red-500/30 text-red-400"
                            : "border-neutral-800 text-neutral-400"
                      }`}
                    >
                      {r.status}
                    </span>
                  </div>
                </div>
            </Link>
            ) : (
              <div key={`${r.roomId}:${r.requestedAt}`} className="border border-neutral-900 bg-black p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">
                      {r.room?.name ?? "Unknown room"}
                    </p>
                    <p className="mt-1 text-[10px] uppercase tracking-wider text-neutral-600">
                      Requested {new Date(r.requestedAt).toLocaleString()}
                    </p>
                    {r.reviewedAt && (
                      <p className="mt-1 text-[10px] uppercase tracking-wider text-neutral-600">
                        Reviewed {new Date(r.reviewedAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <span
                    className={`shrink-0 border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                      r.status === "APPROVED"
                        ? "border-green-500/30 text-green-400"
                        : r.status === "REJECTED"
                          ? "border-red-500/30 text-red-400"
                          : "border-neutral-800 text-neutral-400"
                    }`}
                  >
                    {r.status}
                  </span>
                </div>
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}

