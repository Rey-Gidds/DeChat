"use client";

import { SWRConfig } from "swr";
import { swrFetcher } from "@/lib/swr-config";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher: swrFetcher,
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        dedupingInterval: 5_000,
      }}
    >
      {children}
    </SWRConfig>
  );
}
