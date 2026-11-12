// The one place the web app calls the API. Same origin: Next.js passes /api/*
// to the API server, so the session cookie goes along automatically.

import type { ApiErrorBody } from "@makegood/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        // The API refuses a change without this header; a page on another site cannot add it. See CSRF in apps/api/src/api/http.ts.
        ...(method === "GET" ? {} : { "X-Make-Good": "1" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Could not reach the server. Check your connection and try again.");
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!response.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(response.status, err?.code ?? "HTTP_" + response.status, err?.message ?? `The server answered ${response.status}.`, err?.details);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
