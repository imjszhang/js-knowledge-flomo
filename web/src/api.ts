import type {
  ActiveContext,
  AnalysisCardInput,
  AnalysisRecord,
  AnalysisKind,
  DiscoveryResult,
  CollectorArticle,
  DraftRevision,
  MaterialCandidate,
  WorkbenchView,
  Change,
  Job,
  Memo,
  SearchResult,
  Settings,
  SourceResolution,
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
  }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError("CONNECTION_UNAVAILABLE", "暂时无法连接工作台，页面中的输入已保留。请恢复连接后重试。", 0);
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
    request<{ ok: boolean; aiConfigured: boolean; flomoConfigured: boolean; collectorConfigured: boolean }>(
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
  context: () => request<ActiveContext>("/context"),
  setContext: (workspaceId: string | null, view: WorkbenchView, baseRevision: number) =>
    mutation<ActiveContext>("/context", { workspaceId, view, baseRevision }, "PUT"),
  discover: (id: string, input: {terms: string[]; tag?: string; excludeTag?: string; startDate?: string; endDate?: string; limit: number; baseVersion: number}) =>
    mutation<DiscoveryResult>(`/workspaces/${encodeURIComponent(id)}/discover`, input),
  analyses: (id: string) => request<AnalysisRecord[]>(`/workspaces/${encodeURIComponent(id)}/analyses`),
  createAnalysis: (id: string, input: {kind: AnalysisKind; question: string; engine: "builtin" | "external"; basisAnalysisId?: string; writing?: import("../../shared/contracts").WritingInput; baseVersion: number; idempotencyKey: string}) =>
    mutation<Workspace>(`/workspaces/${encodeURIComponent(id)}/analyses`, input),
  saveAnalysisCard: (id: string, analysisId: string, cardId: string, input: AnalysisCardInput & {baseVersion: number}) =>
    mutation<Workspace>(`/workspaces/${encodeURIComponent(id)}/analyses/${encodeURIComponent(analysisId)}/cards/${encodeURIComponent(cardId)}`, input, "PATCH"),
  publishAnalysisCard: (id: string, analysisId: string, cardId: string, baseVersion: number, idempotencyKey: string) =>
    mutation<Workspace>(`/workspaces/${encodeURIComponent(id)}/analyses/${encodeURIComponent(analysisId)}/cards/${encodeURIComponent(cardId)}/publish`, {baseVersion, idempotencyKey}),
  goal: (id: string, goal: string, baseVersion: number) =>
    mutation<Workspace>(`/workspaces/${id}/goal`, { goal, baseVersion }, "PATCH"),
  chooseCandidate: (id: string, memoId: string, status: MaterialCandidate["status"], baseVersion: number) =>
    mutation<Workspace>(`/workspaces/${id}/candidates/${encodeURIComponent(memoId)}`, { status, baseVersion }, "PATCH"),
  answerDecision: (id: string, decisionId: string, answer: string, baseVersion: number) =>
    mutation<Workspace>(`/workspaces/${id}/decisions/${decisionId}`, { answer, baseVersion }, "PATCH"),
  revisions: (id: string) => request<DraftRevision[]>(`/workspaces/${id}/revisions`),
  workspaces: () => request<Workspace[]>("/workspaces"),
  workspace: (id: string) => request<Workspace>(`/workspaces/${id}`),
  sources: (id: string, signal?: AbortSignal) =>
    request<SourceResolution>(`/workspaces/${encodeURIComponent(id)}/sources`, { signal }),
  source: (articleId: string, signal?: AbortSignal) =>
    request<CollectorArticle>(`/sources/${encodeURIComponent(articleId)}`, { signal }),
  attachSource: (id: string, articleId: string, baseVersion: number) =>
    mutation<Workspace>(`/workspaces/${encodeURIComponent(id)}/sources`, { articleId, baseVersion }),
  removeSource: (id: string, articleId: string, baseVersion: number) =>
    mutation<Workspace>(`/workspaces/${encodeURIComponent(id)}/sources/${encodeURIComponent(articleId)}`, { baseVersion }, "DELETE"),
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
  annotate: (id: string, content: string, idempotencyKey: string) =>
    mutation<Job>(`/workspaces/${id}/annotations`, { content, idempotencyKey }),
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
