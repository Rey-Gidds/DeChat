"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { requestJoinByLink } from "@/lib/room-membership-client";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export default function JoinByLinkPage() {
  const params = useParams<{ roomLink: string }>();
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [status, setStatus] = useState("Joining room...");
  const [error, setError] = useState("");

  useEffect(() => {
    if (isPending) return;
    if (!session?.user) {
      router.replace(`/sign-in?next=/join/${params.roomLink}`);
      return;
    }

    const roomLink = params.roomLink;
    if (!roomLink) {
      setError("Invalid invite link");
      return;
    }

    void requestJoinByLink(roomLink)
      .then((raw) => {
        const data = raw as { room?: { _id?: string; id?: string }; membership?: { status?: string } };
        if (data.membership?.status === "PENDING") {
          router.replace("/pending");
          return;
        }
        const roomId = data.room?._id?.toString?.() ?? data.room?.id;
        if (roomId) {
          router.replace(`/rooms/${roomId}`);
        } else {
          setError("Room not found");
        }
      })
      .catch((err: Error) => {
        setError(err.message || "Failed to join");
        setStatus("");
      });
  }, [isPending, session, params.roomLink, router]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      {error ? (
        <>
          <p className="text-sm text-neutral-400">{error}</p>
          <Link href="/" className="mt-4">
            <Button variant="secondary" className="uppercase tracking-wider">
              Go home
            </Button>
          </Link>
        </>
      ) : (
        <p className="text-xs uppercase tracking-wider text-neutral-600">{status}</p>
      )}
    </div>
  );
}
