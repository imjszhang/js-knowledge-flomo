import type {
  Change,
  Job,
  Memo,
  SearchResult,
  Settings,
  TagResult,
  Workspace,
} from "../../shared/contracts";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Workbench-Actor": "web",
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      body?.error?.code ?? "REQUEST_FAILED",
      body?.error?.message ?? `请求失败（${response.status}）`,
      response.status,
      body?.error?.details,
    );
  return body as T;
}

function mutation<T>(path: string, body: unknown, method = "POST") {
  return request<T>(path, { method, body: JSON.stringify(body) });
}

export const api = {
  health: () =>
    request<{ ok: boolean; aiConfigured: boolean; flomoConfigured: boolean }>(
      "/health",
    ),
  settings: () => request<Settings>("/settings"),
  saveSettings: (settings: Settings) =>
    mutation<Settings>("/settings", settings, "PUT"),
  memos: (query: Record<string, string>) =>
    request<SearchResult>(
      `/memos?${new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, value]) => value !== "")))}`,
    ),
  memo: (id: string) => request<Memo>(`/memos/${encodeURIComponent(id)}`),
  related: (id: string) =>
    request<Memo[]>(`/memos/${encodeURIComponent(id)}/related`),
  tags: () => request<TagResult>("/tags"),
  workspaces: () => request<Workspace[]>("/workspaces"),
  workspace: (id: string) => request<Workspace>(`/workspaces/${id}`),
  createWorkspace: (memoId: string) =>
    mutation<Workspace>("/workspaces", { memoId }),
  draft: (id: string, draft: string, baseVersion: number) =>
    mutation<Workspace>(
      `/workspaces/${id}/draft`,
      { draft, baseVersion },
      "PATCH",
    ),
  materials: (id: string, memoIds: string[], baseVersion: number) =>
    mutation<Workspace>(
      `/workspaces/${id}/materials`,
      { memoIds, baseVersion },
      "PUT",
    ),
  message: (id: string, content: string, baseVersion: number) =>
    mutation<Workspace>(`/workspaces/${id}/messages`, {
      role: "user",
      content,
      baseVersion,
    }),
  refresh: (id: string) => mutation<Workspace>(`/workspaces/${id}/refresh`, {}),
  rebase: (id: string, baseVersion: number) =>
    mutation<Workspace>(`/workspaces/${id}/rebase`, { baseVersion }),
  ai: (
    id: string,
    prompt: string,
    baseVersion: number,
    idempotencyKey: string,
  ) =>
    mutation<Job>(`/workspaces/${id}/ai`, {
      prompt,
      baseVersion,
      idempotencyKey,
    }),
  publish: (id: string, baseVersion: number, idempotencyKey: string) =>
    mutation<Job>(`/workspaces/${id}/publish`, { baseVersion, idempotencyKey }),
  jobs: (id: string) =>
    request<Job[]>(`/jobs?workspaceId=${encodeURIComponent(id)}`),
  reconcile: (id: string) => mutation<Job>(`/jobs/${id}/reconcile`, {}),
  abandon: (id: string, baseVersion: number) =>
    mutation<Job>(`/jobs/${id}/abandon`, { baseVersion, acknowledge: true }),
  changes: (after: number) => request<Change[]>(`/changes?after=${after}`),
};

export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

export function sourceUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
