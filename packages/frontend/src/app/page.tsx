"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { LandingPage } from "@/components/landing/landing-page";

export default function Home() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  useEffect(() => {
    if (!isPending && session?.user) {
      router.replace("/discover");
    }
  }, [session, isPending, router]);

  // While checking session or if already authenticated, keep screen clean without flash of landing page
  if (isPending || session?.user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <div className="h-4 w-4 rounded-full border-2 border-neutral-700 border-t-white animate-spin" />
      </div>
    );
  }

  return <LandingPage />;
}
