/** Build the dashboard WebSocket URL relative to the current page origin. */
export function dashboardWsUrl(): string {
  if (typeof window === "undefined") return "ws://localhost:5173/api/ws";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = import.meta.env.VITE_DASHBOARD_TOKEN ?? "";
  // The browser WebSocket constructor doesn't allow custom headers — the
  // token rides as a query param. The server applies the same check on
  // the upgrade request (server/middleware/auth.ts > checkWsAuth).
  const qs = token.length > 0 ? `?token=${encodeURIComponent(token)}` : "";
  return `${proto}//${window.location.host}/api/ws${qs}`;
}
