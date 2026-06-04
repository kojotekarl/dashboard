import type {
  ApiTaskFile,
  ApproveAllResponse,
  GroomResponse,
  ListTasksResponse,
} from "./types.ts";

/**
 * Base URL for the API. Empty string in dev (Vite proxies /api → server).
 * Override via VITE_API_URL when serving the bundle from a different host.
 */
const BASE = import.meta.env.VITE_API_URL ?? "";

/**
 * Token paired with the server's DASHBOARD_TOKEN. Sent as X-Dashboard-Token
 * on every mutating request when set. Empty in dev (server has auth off).
 */
const TOKEN = import.meta.env.VITE_DASHBOARD_TOKEN ?? "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN.length > 0 ? { "X-Dashboard-Token": TOKEN } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  // Server consistently returns JSON, even for errors. Tolerate empty bodies.
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, text, `non-JSON response from ${path}: ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, parsed, msg);
  }
  return parsed as T;
}

export const api = {
  listTasks: () => request<ListTasksResponse>("/api/tasks"),

  patchTask: (id: string, patch: Record<string, unknown>) =>
    request<ApiTaskFile>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  groom: () =>
    request<GroomResponse>("/api/agent/groom", {
      method: "POST",
      body: "{}",
    }),

  approveSuggestion: (taskId: string) =>
    request<ApiTaskFile>(`/api/suggestions/${encodeURIComponent(taskId)}/approve`, {
      method: "POST",
    }),

  dismissSuggestion: (taskId: string) =>
    request<ApiTaskFile>(`/api/suggestions/${encodeURIComponent(taskId)}/dismiss`, {
      method: "POST",
    }),

  approveAll: () =>
    request<ApproveAllResponse>("/api/suggestions/approve-all", {
      method: "POST",
    }),
};
