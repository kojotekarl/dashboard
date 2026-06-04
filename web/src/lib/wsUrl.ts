/** Build the dashboard WebSocket URL relative to the current page origin. */
export function dashboardWsUrl(): string {
  if (typeof window === "undefined") return "ws://localhost:5173/api/ws";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws`;
}
