#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WorkbenchClient, WorkbenchError } from '../cli/workbench.js';
import { aiSchema, candidateChoiceSchema, candidatesSchema, contextSchema, createWorkspaceSchema, decisionAnswerSchema, decisionSchema, goalSchema, materialsSchema, messageSchema, publishSchema, settingsSchema, updateDraftSchema, versionSchema } from '../shared/contracts.js';

const id = z.string().min(1).describe('Workspace, memo or job ID returned by the service.');
const workspaceId = id.describe('Workspace ID, or current to use the workspace selected in the Web. Mutating current also requires the contextRevision observed with context_get; use explicit workspace IDs for long tasks.');
const workspaceMutation = { id: workspaceId, contextRevision: z.number().int().nonnegative().optional().describe('Required with id=current: the revision returned by context_get. Separate from workspace baseVersion; omit with an explicit workspace ID.') };

/** Shared HTTP-backed tools: mutations appear immediately in the Web workspace. */
export function createWorkbenchMcpServer(client = new WorkbenchClient(undefined, 'mcp')) {
  const server = new McpServer({ name: 'flomo-workbench', version: '2.0.0' });
  const mutateWorkspace = (method: string, id: string, suffix: string, { contextRevision, ...body }: Record<string, unknown>) => client.workspaceRequest(method, id, suffix, body, contextRevision as number | undefined);
  function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
    server.registerTool<z.ZodRawShape, z.ZodRawShape>(name, { description, inputSchema: shape }, async args => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(await run(args as z.infer<z.ZodObject<S>>)) }] };
      } catch (error) {
        const failure = error instanceof WorkbenchError ? error : new WorkbenchError('TOOL_ERROR', 'Workbench operation failed.');
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: failure.code, message: failure.message, ...(failure.details === undefined ? {} : { details: failure.details }) } }) }] };
      }
    });
  }

  tool('workbench_status', 'Check the running local workbench service. The Node service must be started separately.', {}, () => client.request('GET', '/health'));
  tool('workbench_memo_list', 'Search remote flomo notes. Results may be limited and are not a complete local knowledge base.', {
    query: z.string().optional(), tag: z.string().optional(), excludeTag: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional(), limit: z.number().int().positive().optional(),
  }, ({ query, ...rest }) => client.request('GET', '/memos', undefined, { q: query, ...rest }));
  tool('workbench_annotation_create', 'Create a new flomo annotation linked to the workspace source. Writes a new remote note; use user-authored or approved content. Reuse idempotencyKey on retries.', { ...workspaceMutation, content:z.string().trim().min(1).max(20000), idempotencyKey:z.string().min(1).max(200) }, ({id,...body}) => mutateWorkspace('POST', id, '/annotations', body));
  tool('workbench_memo_get', 'Fetch the complete current flomo memo before working with it.', { id }, ({ id }) => client.request('GET', `/memos/${encodeURIComponent(id)}`));
  tool('workbench_memo_related', 'Find related flomo notes to consider as source materials. Inspect full notes before using them.', { id }, ({ id }) => client.request('GET', `/memos/${encodeURIComponent(id)}/related`));
  tool('workbench_tags_list', 'Read visible flomo tags, including truncation metadata.', { prefix: z.string().optional() }, params => client.request('GET', '/tags', undefined, params));
  tool('workbench_context_get', 'Read the note and view currently selected in the Web, including the complete workspace, goal, proposed/selected materials and decisions. Reading shared state does not send a message to Codex.', {}, () => client.request('GET', '/context'));
  tool('workbench_context_set', 'Set the active Web workspace and view using the observed CONTEXT revision. This revision is separate from the workspace version. Null clears the selection.', contextSchema.shape, async params => client.request('PUT', '/context', { ...params, workspaceId: params.workspaceId === null ? null : await client.resolveWorkspaceId(params.workspaceId, params.baseRevision) }));
  tool('workbench_workspace_list', 'List persistent processing workspaces shared with the Web and CLI.', {}, () => client.request('GET', '/workspaces'));
  tool('workbench_workspace_create', 'Create a persistent workspace from a full flomo memo. This does not publish to flomo.', createWorkspaceSchema.shape, params => client.request('POST', '/workspaces', params));
  tool('workbench_workspace_get', 'Read draft, sources, goal, material recommendations, decisions, messages and current version.', { id: workspaceId }, ({ id }) => client.workspaceRequest('GET', id));
  tool('workbench_workspace_refresh', 'Check the current flomo source without replacing the local draft. Not a whole-library sync.', workspaceMutation, ({ id, ...body }) => mutateWorkspace('POST', id, '/refresh', body));
  tool('workbench_workspace_rebase', 'After reviewing the remote change, adopt the refreshed remote source as the new base while retaining the draft. First inspect the diff.', { ...workspaceMutation, baseVersion: versionSchema }, ({ id, ...body }) => mutateWorkspace('POST', id, '/rebase', body));
  tool('workbench_workspace_goal', 'Set what this processing session should achieve. Preserve the human goal; use the last observed workspace version.', { ...workspaceMutation, ...goalSchema.shape }, ({ id, ...body }) => mutateWorkspace('PATCH', id, '/goal', body));
  tool('workbench_draft_update', 'Save a full draft using the last observed workspace version. Include a concise summary of meaningful changes for the Web. On conflict re-read and merge; never blindly retry with a new version.', { ...workspaceMutation, ...updateDraftSchema.shape }, ({ id, ...body }) => mutateWorkspace('PATCH', id, '/draft', body));
  tool('workbench_draft_diff', 'Inspect original, draft, refreshed remote content and version before publishing or rebasing.', { id: workspaceId }, ({ id }) => client.diff(id));
  tool('workbench_draft_history', 'Read the latest 50 draft revisions, including before/after text, change summary and actor.', { id: workspaceId }, ({ id }) => client.workspaceRequest('GET', id, '/revisions'));
  tool('workbench_draft_publish', 'Publish the reviewed draft to the ORIGINAL flomo note. Reuse the same idempotencyKey and baseVersion only when retrying the exact request. Returns a job; inspect its state.', { ...workspaceMutation, ...publishSchema.shape }, ({ id, ...body }) => mutateWorkspace('POST', id, '/publish', body));
  tool('workbench_materials_set', 'Replace selected source materials with the specified flomo memo IDs. Empty list removes all materials.', { ...workspaceMutation, ...materialsSchema.shape }, ({ id, ...body }) => mutateWorkspace('PUT', id, '/materials', body));
  tool('workbench_materials_propose', 'Recommend source notes with a specific reason and relationship to the goal. The Web lets the human select or dismiss them. Check full source content first.', { ...workspaceMutation, ...candidatesSchema.shape }, ({ id, ...body }) => mutateWorkspace('POST', id, '/candidates', body));
  tool('workbench_material_decide', 'Select, dismiss or reopen a recommended source. This choice is shared with the Web and other agents.', { ...workspaceMutation, memoId: id, ...candidateChoiceSchema.shape }, ({ id, memoId, ...body }) => mutateWorkspace('PATCH', id, `/candidates/${encodeURIComponent(memoId)}`, body));
  tool('workbench_decision_add', 'Ask a concrete question for the human to answer in the Web, optionally with up to six choices. Read workspace state later for the answer; this does not send a Codex message.', { ...workspaceMutation, ...decisionSchema.shape }, ({ id, ...body }) => mutateWorkspace('POST', id, '/decisions', body));
  tool('workbench_decision_answer', 'Save an answer to a processing decision using the observed workspace version.', { ...workspaceMutation, decisionId: id, ...decisionAnswerSchema.shape }, ({ id, decisionId, ...body }) => mutateWorkspace('PATCH', id, `/decisions/${encodeURIComponent(decisionId)}`, body));
  tool('workbench_message_add', 'Persist a user/assistant message generated externally, e.g. by Codex. Does not call a model or overwrite the draft.', { ...workspaceMutation, ...messageSchema.shape }, ({ id, ...body }) => mutateWorkspace('POST', id, '/messages', body));
  tool('workbench_ai_run', 'Start an optional configured AI-provider job using current source and materials. External agents can save their own results via draft_update/message_add without an AI API key.', { ...workspaceMutation, ...aiSchema.shape }, ({ id, ...body }) => mutateWorkspace('POST', id, '/ai', body));
  tool('workbench_job_list', 'List background jobs, optionally within one workspace. workspaceId accepts current.', { workspaceId: workspaceId.optional() }, async ({ workspaceId }) => client.request('GET', '/jobs', undefined, { workspaceId: workspaceId === undefined ? undefined : await client.resolveWorkspaceId(workspaceId) }));
  tool('workbench_job_get', 'Inspect a job, streamed AI text, errors and publish outcome. An uncertain publish needs reconciliation, not a new publish request.', { id }, ({ id }) => client.request('GET', `/jobs/${encodeURIComponent(id)}`));
  tool('workbench_job_reconcile', 'Recheck the remote note after an uncertain publish to establish whether the requested content was saved. Does not repeat the remote write.', { id }, ({ id }) => client.request('POST', `/jobs/${encodeURIComponent(id)}/reconcile`, {}));
  tool('workbench_job_abandon', 'Explicit operator recovery AFTER manually checking flomo outside this API: mark an uncertain publication abandoned and release its lock, without writing or cancelling the original request. It may still commit later. Requires acknowledge=true and the current WORKSPACE version. Refresh the source before any later publication; never invoke automatically after reconciliation mismatch.', { id, baseVersion: versionSchema, acknowledge: z.literal(true) }, ({ id, ...body }) => client.request('POST', `/jobs/${encodeURIComponent(id)}/abandon`, body));
  tool('workbench_changes_list', 'Read durable workspace/job/settings changes after a cursor; save the last ID for the next call.', { after: z.number().int().nonnegative().default(0) }, params => client.request('GET', '/changes', undefined, params));
  tool('workbench_changes_wait', 'Wait up to 30 seconds for the first durable change after a cursor. Returns an empty list on timeout. For continuous updates use CLI changes watch.', {
    after: z.number().int().nonnegative().default(0), timeoutMs: z.number().int().min(1).max(30_000).default(25_000),
  }, async ({ after, timeoutMs }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for await (const change of client.watch(after, controller.signal)) return [change];
      return [];
    } finally { clearTimeout(timeout); controller.abort(); }
  });
  tool('workbench_settings_get', 'Read pinned tags and source refresh interval shared across all clients.', {}, () => client.request('GET', '/settings'));
  tool('workbench_settings_set', 'Replace pinned tags and refresh interval. Zero disables periodic refresh; does not rewrite flomo tags.', settingsSchema.shape, params => client.request('PUT', '/settings', params));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await createWorkbenchMcpServer().connect(new StdioServerTransport());
    process.stderr.write('flomo workbench MCP ready (stdio); uses the running local service.\n');
  } catch {
    process.stderr.write('Could not start the workbench MCP adapter. Check FLOMO_WORKBENCH_URL and the local service.\n');
    process.exitCode = 1;
  }
}
