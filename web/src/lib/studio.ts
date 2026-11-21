// Cliente del API del Studio (sala de control). Sesión por cookie HttpOnly.
import type { RequestItem, StudioOverview } from "./types";

export class Unauthorized extends Error {}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw new Unauthorized();
  const j = await r.json().catch(() => null);
  if (!j?.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j.data as T;
}

export const studio = {
  me: () => call<{ authenticated: boolean }>("GET", "/api/studio/me"),
  login: (token: string) => call<unknown>("POST", "/api/studio/login", { token }),
  logout: () => call<unknown>("POST", "/api/studio/logout"),
  overview: () => call<StudioOverview>("GET", "/api/studio/overview"),
  requests: () => call<RequestItem[]>("GET", "/api/studio/requests"),
  approve: (id: string) => call<unknown>("POST", `/api/studio/requests/${encodeURIComponent(id)}/approve`),
  reject: (id: string) => call<unknown>("POST", `/api/studio/requests/${encodeURIComponent(id)}/reject`),
  enqueue: (trackId: string) => call<unknown>("POST", "/api/studio/queue", { trackId }),
  skip: () => call<unknown>("POST", "/api/studio/skip"),
  removeFromQueue: (rid: string) => call<unknown>("DELETE", `/api/stream/queue/${encodeURIComponent(rid)}`),
};
