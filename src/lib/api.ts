/**
 * Browser-side API client.
 *
 * One place that knows the response envelope, so components never hand-roll a
 * fetch and never forget to unwrap `ok: false`.
 */

import type { Err, Ok } from "./types";

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: Err extends { error: infer E } ? E : never };

async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  const { method = "GET", body, signal } = options;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      // Same-origin credentials so the anonymous scope cookie travels with the
      // request. Without this the server would mint a new owner per call and
      // every write would vanish into a session nobody can reach.
      credentials: "same-origin",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: { code: "ABORTED", message: "Request cancelled." } };
    }
    return {
      ok: false,
      error: { code: "NETWORK", message: "Could not reach khata. Check your connection and try again." },
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      error: {
        code: "BAD_RESPONSE",
        message: `khata replied with HTTP ${response.status} and a body that was not JSON.`,
      },
    };
  }

  if (payload && typeof payload === "object" && "ok" in payload) {
    const typed = payload as Ok<T> | Err;
    if (typed.ok) return { ok: true, data: typed.data };
    return { ok: false, error: typed.error };
  }

  return {
    ok: false,
    error: { code: "UNEXPECTED", message: `khata replied with an unexpected body (HTTP ${response.status}).` },
  };
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/** One line, ready for an aria-live region or an inline error. */
export function errorText(error: { code: string; message: string; fields?: Record<string, string> }): string {
  const fields = error.fields ? Object.values(error.fields) : [];
  return fields.length > 0 ? `${error.message} ${fields.join(" ")}` : error.message;
}