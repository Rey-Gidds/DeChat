export async function swrFetcher<T = any>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `Request failed with status ${res.status}`);
  }
  return res.json();
}

export const SWR_KEYS = {
  me: "/api/me",
  myRooms: (status = "APPROVED") => `/api/rooms/mine?status=${status}`,
  pendingRequests: "/api/rooms/requests",
  discoveryRooms: (query: string, tags: string[]) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (tags.length > 0) params.set("tags", tags.join(","));
    const str = params.toString();
    return `/api/rooms${str ? `?${str}` : ""}`;
  },
  popularTags: "/api/tags/popular",
  trendingTags: "/api/tags/trending",
};
