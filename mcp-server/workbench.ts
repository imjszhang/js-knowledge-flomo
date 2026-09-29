#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WorkbenchClient, WorkbenchError } from '../cli/workbench.js';
import { aiSchema, createWorkspaceSchema, materialsSchema, messageSchema, publishSchema, settingsSchema, updateDraftSchema, versionSchema } from '../shared/contracts.js';

const id = z.string().min(1).describe('Workspace, memo or job ID returned by the service.');
const workspacePath = (value: string) => `/workspaces/${encodeURIComponent(value)}`;

/** Shared HTTP-backed tools: mutations appear immediately in the Web workspace. */
export function createWorkbenchMcpServer(client = new WorkbenchClient(undefined, 'mcp')) {
  const server = new McpServer({ name: 'flomo-workbench', version: '2.0.0' });
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
    query: z.string().optional(), tag: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional(), limit: z.number().int().positive().optional(),
  }, ({ query, ...rest }) => client.request('GET', '/memos', undefined, { q: query, ...rest }));
  tool('workbench_memo_get', 'Fetch the complete current flomo memo before working with it.', { id }, ({ id }) => client.request('GET', `/memos/${encodeURIComponent(id)}`));
  tool('workbench_memo_related', 'Find related flomo notes to consider as source materials. Inspect full notes before using them.', { id }, ({ id }) => client.request('GET', `/memos/${encodeURIComponent(id)}/related`));
  tool('workbench_tags_list', 'Read visible flomo tags, including truncation metadata.', { prefix: z.string().optional() }, params => client.request('GET', '/tags', undefined, params));
  tool('workbench_workspace_list', 'List persistent processing workspaces shared with the Web and CLI.', {}, () => client.request('GET', '/workspaces'));
  tool('workbench_workspace_create', 'Create a persistent workspace from a full flomo memo. This does not publish to flomo.', createWorkspaceSchema.shape, params => client.request('POST', '/workspaces', params));
  tool('workbench_workspace_get', 'Read draft, sources, selected materials, messages and current version.', { id }, ({ id }) => client.request('GET', workspacePath(id)));
  tool('workbench_workspace_refresh', 'Check the current flomo source without replacing the local draft. Not a whole-library sync.', { id }, ({ id }) => client.request('POST', `${workspacePath(id)}/refresh`, {}));
  tool('workbench_workspace_rebase', 'After reviewing the remote change, adopt the refreshed remote source as the new base while retaining the draft. First inspect the diff.', { id, baseVersion: versionSchema }, ({ id, ...body }) => client.request('POST', `${workspacePath(id)}/rebase`, body));
  tool('workbench_draft_update', 'Save a full draft using the last observed workspace version. On conflict re-read and merge; never blindly retry with a new version.', { id, ...updateDraftSchema.shape }, ({ id, ...body }) => client.request('PATCH', `${workspacePath(id)}/draft`, body));
  tool('workbench_draft_diff', 'Inspect original, draft, refreshed remote content and version before publishing or rebasing.', { id }, ({ id }) => client.diff(id));
  tool('workbench_draft_publish', 'Publish the reviewed draft to the ORIGINAL flomo note. Reuse the same idempotencyKey and baseVersion only when retrying the exact request. Returns a job; inspect its state.', { id, ...publishSchema.shape }, ({ id, ...body }) => client.request('POST', `${workspacePath(id)}/publish`, body));
  tool('workbench_materials_set', 'Replace selected source materials with the specified flomo memo IDs. Empty list removes all materials.', { id, ...materialsSchema.shape }, ({ id, ...body }) => client.request('PUT', `${workspacePath(id)}/materials`, body));
  tool('workbench_message_add', 'Persist a user/assistant message generated externally, e.g. by Codex. Does not call a model or overwrite the draft.', { id, ...messageSchema.shape }, ({ id, ...body }) => client.request('POST', `${workspacePath(id)}/messages`, body));
  tool('workbench_ai_run', 'Start an optional configured AI-provider job using current source and materials. External agents can save their own results via draft_update/message_add without an AI API key.', { id, ...aiSchema.shape }, ({ id, ...body }) => client.request('POST', `${workspacePath(id)}/ai`, body));
  tool('workbench_job_list', 'List background jobs, optionally within one workspace.', { workspaceId: z.string().optional() }, params => client.request('GET', '/jobs', undefined, params));
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
