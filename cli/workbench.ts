#!/usr/bin/env node
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { analysisCardPublishSchema, analysisCardUpdateSchema, analysisCreateSchema, analysisResultSchema, candidateChoiceSchema, candidatesSchema, contextSchema, decisionSchema, discoverySchema, noteDraftCreateSchema, noteDraftPublishSchema, noteDraftUpdateSchema, sourceAttachSchema, type ActiveContext, type Actor, type Change, type Workspace } from '../shared/contracts.js';

export class WorkbenchError extends Error {
  constructor(public readonly code: string, message: string, public readonly exitCode = 1, public readonly details?: unknown) {
    super(message);
  }
}

/** All adapters use the running service; none open the database independently. */
export class WorkbenchClient {
  readonly baseUrl: string;
  constructor(baseUrl = process.env.FLOMO_WORKBENCH_URL || 'http://127.0.0.1:3000', readonly actor: Actor = 'cli') {
    try {
      const url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      this.baseUrl = url.toString().replace(/\/$/, '');
    } catch {
      throw new WorkbenchError('INVALID_URL', 'FLOMO_WORKBENCH_URL must be an HTTP(S) URL without credentials, query or fragment.', 2);
    }
  }

  private url(path: string, query?: Record<string, unknown>) {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, query?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.url(path, query), {
        method,
        headers: { 'content-type': 'application/json', 'x-workbench-actor': this.actor },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ?? AbortSignal.timeout(120_000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new WorkbenchError('SERVICE_OFFLINE', 'Cannot reach the workbench service. Start it with npm start or npm run dev:server.', 4);
    }
    let data: unknown;
    try { data = await response.json(); } catch {
      throw new WorkbenchError('INVALID_RESPONSE', `Workbench returned an invalid JSON response (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const failure = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
      throw new WorkbenchError(failure?.code ?? 'REQUEST_FAILED', failure?.message ?? `Request failed (HTTP ${response.status}).`, response.status === 409 ? 3 : response.status === 400 || response.status === 422 ? 2 : 1, failure?.details);
    }
    return data as T;
  }

  async resolveWorkspaceId(id: string, contextRevision?: number): Promise<string> {
    if (id !== 'current') return id;
    const context = await this.request<ActiveContext>('GET', '/context');
    if (contextRevision !== undefined && context.revision !== contextRevision) throw new WorkbenchError('CONTEXT_CONFLICT', 'The active workspace or view changed. Read context again and confirm the intended workspace before updating.', 3, { expectedRevision: contextRevision, actualRevision: context.revision });
    if (!context.workspaceId) throw new WorkbenchError('NO_ACTIVE_WORKSPACE', 'Select a note in the Web workbench, or set an active workspace with context set.', 2);
    return context.workspaceId;
  }

  /** Resolve current once, so a concurrent Web selection cannot redirect an operation. */
  async workspaceRequest<T = unknown>(method: string, id: string, suffix = '', body?: unknown, contextRevision?: number): Promise<T> {
    if (method !== 'GET' && id === 'current' && contextRevision === undefined) throw new WorkbenchError('CONTEXT_REVISION_REQUIRED', 'Updating current requires --context-revision (MCP: contextRevision) from context get. For a longer task, use the explicit workspace.id returned by that read.', 2);
    const resolvedId = await this.resolveWorkspaceId(id, contextRevision);
    return this.request<T>(method, `/workspaces/${encodeURIComponent(resolvedId)}${suffix}`, body);
  }

  async diff(id: string) {
    const workspace = await this.workspaceRequest<Workspace>('GET', id);
    return {
      workspaceId: workspace.id,
      version: workspace.version,
      memoId: workspace.memoId,
      sourceChanged: workspace.sourceChanged,
      original: workspace.source.content,
      draft: workspace.draft,
      remote: workspace.remote?.content ?? null,
      changed: workspace.source.content !== workspace.draft,
    };
  }

  private async *changePages(after: number, signal?: AbortSignal): AsyncGenerator<Change> {
    let cursor = after;
    while (!signal?.aborted) {
      const page = await this.request<Change[]>('GET', '/changes', undefined, { after: cursor }, signal);
      for (const change of page) {
        if (change.id > cursor) { cursor = change.id; yield change; }
      }
      if (page.length < 1000 || cursor === after) return;
      after = cursor;
    }
  }

  /** Durable cursor + SSE replay/catch-up: reconnect without losing or duplicating changes. */
  async *watch(after = 0, signal?: AbortSignal, diagnostic: (message: string) => void = () => {}): AsyncGenerator<Change> {
    let cursor = after;
    let reportedOffline = false;
    while (!signal?.aborted) {
      try {
        for await (const change of this.changePages(cursor, signal)) {
          if (change.id > cursor) { cursor = change.id; yield change; }
        }
        const response = await fetch(this.url('/events', { after: cursor }), {
          headers: { accept: 'text/event-stream', 'x-workbench-actor': this.actor, 'last-event-id': String(cursor) },
          signal,
        });
        if (!response.ok || !response.body) throw new Error('Event stream unavailable');
        if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Invalid event stream');
        reportedOffline = false;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (!signal?.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let separator: RegExpExecArray | null;
            while ((separator = /\r?\n\r?\n/.exec(buffer))) {
              const frame = buffer.slice(0, separator.index);
              buffer = buffer.slice(separator.index + separator[0].length);
              const lines = frame.split(/\r?\n/);
              const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
              if (event === 'ready') {
                // The listener is now installed. Close the gap after the first HTTP fetch.
                for await (const change of this.changePages(cursor, signal)) {
                  if (change.id > cursor) { cursor = change.id; yield change; }
                }
              } else if (event === 'change') {
                const text = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                if (!text) continue;
                const change = JSON.parse(text) as Change;
                if (!Number.isSafeInteger(change.id) || change.id < 1) throw new Error('Invalid change cursor');
                if (change.id > cursor) { cursor = change.id; yield change; }
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch {
        if (signal?.aborted) return;
        if (!reportedOffline) diagnostic('Change stream disconnected; reconnecting from the last received cursor.');
        reportedOffline = true;
      }
      if (signal?.aborted) return;
      await new Promise<void>(resolve => {
        const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(); };
        const timer = setTimeout(stop, 1000);
        signal?.addEventListener('abort', stop, { once: true });
      });
    }
  }
}

const usage = `flomo workbench CLI (requires the local service)

  annotation create ID --text TEXT --idempotency-key KEY
  memo list [--query TEXT] [--tag TAG] [--exclude-tag TAG] [--unlinked-only] [--start-date DATE] [--end-date DATE] [--limit N]
  memo get ID | memo related ID
  tags list [--prefix TEXT]
  workspace list
  workspace create --memo ID [--title TEXT]
  workspace get ID | workspace refresh ID
  workspace rebase ID --base-version N
  workspace goal ID (--file PATH | --stdin | --text TEXT) --base-version N
  context get
  context set --workspace ID|none --view note|materials|writing|draft --base-revision N
  draft update ID (--file PATH | --stdin | --text TEXT) --base-version N [--summary TEXT]
  draft diff ID | draft history ID
  draft publish ID --expected-version N --idempotency-key KEY
  note-draft create ID --file PATH --base-version N --idempotency-key KEY [--basis ANALYSIS_ID]
  note-draft update ID --note-draft DRAFT_ID --file PATH --base-version N
  note-draft publish ID --note-draft DRAFT_ID --base-version N --idempotency-key KEY
  material set ID --memo ID1,ID2 --base-version N
  material propose ID --file PATH --base-version N
  material decide ID --memo ID --status selected|dismissed|proposed --base-version N
  material discover ID --terms TERM1,TERM2 [--tag TAG] [--exclude-tag TAG] [--start-date DATE] [--end-date DATE] [--limit N] --base-version N
  analysis create ID --kind insights|evolution|connections|outline|cards --engine builtin|external [--question TEXT] [--basis ANALYSIS_ID] [--file WRITING_JSON] --base-version N --idempotency-key KEY
  analysis list ID | analysis get ID --analysis ANALYSIS_ID
  analysis complete ID --analysis ANALYSIS_ID --file PATH --base-version N
  analysis card-update ID --analysis ANALYSIS_ID --card CARD_ID --file PATH --base-version N
  analysis card-publish ID --analysis ANALYSIS_ID --card CARD_ID --base-version N --idempotency-key KEY
  source resolve ID | source get ARTICLE_ID
  source attach ID --article ARTICLE_ID --base-version N
  source detach ID --article ARTICLE_ID --base-version N
  decision add ID --file PATH --base-version N
  decision answer ID --decision ID (--file PATH | --stdin | --text TEXT) --base-version N
  message add ID --role user|assistant (--file PATH | --stdin | --text TEXT) --base-version N
  ai run ID --prompt TEXT --base-version N --idempotency-key KEY
  job list [--workspace ID] | job get ID | job reconcile ID
  job abandon ID --base-version N --acknowledge
  changes list [--after N] | changes watch [--after N]
  settings get | settings set --file PATH
  service status

All commands support --json. Output is JSON; changes watch emits NDJSON.
Use current instead of a workspace ID to target the note selected in the Web.
Updating current requires --context-revision N from context get; explicit IDs do not.
context revision controls the shared selection; base-version controls workspace content.
material propose reads a JSON array of {memoId, reason, relation}; decision add reads {question, options}.
material set changes only flomo materials; collector materials use source attach/detach.
source resolve finds collector articles linked from the source and selected flomo materials.
source attach saves a full article snapshot; attaching it again explicitly refreshes that snapshot.
material discover searches each comma/newline-separated term and proposes full notes; it does not select them.
analysis complete reads {text, cards?}; card-update reads {title, body, tags, sourceKeys}.
external analyses prepare sources and instructions for an agent; saving a result does not publish cards.
card-publish creates a new flomo note after review; check analysis get until its card is published.
note-draft create/update read {title, content} from a JSON file and save local derived notes.
workspace get includes noteDrafts; note-draft publish explicitly creates a NEW flomo note with source links.
Check workspace get until the note draft is published; uncertain outcomes need manual verification in flomo.
FLOMO_WORKBENCH_URL defaults to http://127.0.0.1:3000.
Exit codes: 0 success; 1 service error; 2 invalid input; 3 version conflict; 4 service unavailable.
Reuse an idempotency key only when retrying the exact same AI/publish operation.
`;

const optionTypes: Record<string, { type: 'string' | 'boolean' }> = {
  'unlinked-only': { type: 'boolean' }, 'exclude-tag': { type: 'string' },
  json: { type: 'boolean' }, help: { type: 'boolean' }, query: { type: 'string' }, tag: { type: 'string' },
  'start-date': { type: 'string' }, 'end-date': { type: 'string' }, limit: { type: 'string' },
  memo: { type: 'string' }, title: { type: 'string' }, 'base-version': { type: 'string' },
  'expected-version': { type: 'string' }, 'idempotency-key': { type: 'string' }, file: { type: 'string' },
  stdin: { type: 'boolean' }, text: { type: 'string' }, role: { type: 'string' }, prompt: { type: 'string' },
  acknowledge: { type: 'boolean' }, workspace: { type: 'string' }, after: { type: 'string' }, prefix: { type: 'string' },
  view: { type: 'string' }, 'base-revision': { type: 'string' }, summary: { type: 'string' },
  status: { type: 'string' }, decision: { type: 'string' }, 'context-revision': { type: 'string' },
  article: { type: 'string' },
  terms: { type: 'string' }, kind: { type: 'string' }, engine: { type: 'string' }, question: { type: 'string' },
  basis: { type: 'string' }, analysis: { type: 'string' }, card: { type: 'string' }, 'note-draft': { type: 'string' },
};

const commandOptions: Record<string, { flags: string[]; id?: boolean }> = {
  'annotation create': { flags: ['file', 'stdin', 'text', 'idempotency-key'], id: true },
  'memo list': { flags: ['query', 'tag', 'exclude-tag', 'unlinked-only', 'start-date', 'end-date', 'limit'] },
  'memo get': { flags: [], id: true }, 'memo related': { flags: [], id: true }, 'tags list': { flags: ['prefix'] },
  'workspace list': { flags: [] }, 'workspace create': { flags: ['memo', 'title'] },
  'workspace get': { flags: [], id: true }, 'workspace refresh': { flags: [], id: true },
  'workspace rebase': { flags: ['base-version'], id: true },
  'workspace goal': { flags: ['file', 'stdin', 'text', 'base-version'], id: true },
  'context get': { flags: [] }, 'context set': { flags: ['workspace', 'view', 'base-revision'] },
  'draft update': { flags: ['file', 'stdin', 'text', 'base-version', 'summary'], id: true }, 'draft diff': { flags: [], id: true },
  'draft history': { flags: [], id: true },
  'draft publish': { flags: ['expected-version', 'idempotency-key'], id: true },
  'note-draft create': { flags: ['file', 'basis', 'base-version', 'idempotency-key'], id: true },
  'note-draft update': { flags: ['note-draft', 'file', 'base-version'], id: true },
  'note-draft publish': { flags: ['note-draft', 'base-version', 'idempotency-key'], id: true },
  'material set': { flags: ['memo', 'base-version'], id: true },
  'material propose': { flags: ['file', 'base-version'], id: true },
  'material decide': { flags: ['memo', 'status', 'base-version'], id: true },
  'material discover': { flags: ['terms', 'tag', 'exclude-tag', 'start-date', 'end-date', 'limit', 'base-version'], id: true },
  'analysis create': { flags: ['kind', 'engine', 'question', 'basis', 'file', 'base-version', 'idempotency-key'], id: true },
  'analysis list': { flags: [], id: true }, 'analysis get': { flags: ['analysis'], id: true },
  'analysis complete': { flags: ['analysis', 'file', 'base-version'], id: true },
  'analysis card-update': { flags: ['analysis', 'card', 'file', 'base-version'], id: true },
  'analysis card-publish': { flags: ['analysis', 'card', 'base-version', 'idempotency-key'], id: true },
  'source resolve': { flags: [], id: true }, 'source get': { flags: [], id: true },
  'source attach': { flags: ['article', 'base-version'], id: true },
  'source detach': { flags: ['article', 'base-version'], id: true },
  'decision add': { flags: ['file', 'base-version'], id: true },
  'decision answer': { flags: ['decision', 'file', 'stdin', 'text', 'base-version'], id: true },
  'message add': { flags: ['role', 'file', 'stdin', 'text', 'base-version'], id: true },
  'ai run': { flags: ['prompt', 'base-version', 'idempotency-key'], id: true },
  'job list': { flags: ['workspace'] }, 'job get': { flags: [], id: true }, 'job reconcile': { flags: [], id: true },
  'job abandon': { flags: ['base-version', 'acknowledge'], id: true },
  'changes list': { flags: ['after'] }, 'changes watch': { flags: ['after'] },
  'settings get': { flags: [] }, 'settings set': { flags: ['file'] }, 'service status': { flags: [] },
};
for (const command of ['annotation create', 'workspace refresh', 'workspace rebase', 'workspace goal', 'draft update', 'draft publish', 'note-draft create', 'note-draft update', 'note-draft publish', 'material set', 'material propose', 'material decide', 'material discover', 'analysis create', 'analysis complete', 'analysis card-update', 'analysis card-publish', 'source attach', 'source detach', 'decision add', 'decision answer', 'message add', 'ai run']) {
  commandOptions[command]!.flags.push('context-revision');
}

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: () => Promise<string>;
  signal?: AbortSignal;
}
const defaultIO: CliIO = {
  stdout: text => { process.stdout.write(text); },
  stderr: text => { process.stderr.write(text); },
  stdin: async () => { let text = ''; for await (const chunk of process.stdin) text += String(chunk); return text; },
};

export async function runCli(args: string[], io: CliIO = defaultIO, suppliedClient?: WorkbenchClient): Promise<number> {
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try { parsed = parseArgs({ args, options: optionTypes, allowPositionals: true, strict: true }); }
    catch { throw new WorkbenchError('INVALID_ARGUMENT', 'Invalid arguments. Run with --help for usage.', 2); }
    const { values, positionals } = parsed;
    if (values.help || !positionals.length) { io.stdout(usage); return 0; }
    const [group, action, id] = positionals;
    const command = `${group} ${action}`;
    const spec = commandOptions[command];
    if (!spec || positionals.length !== (spec.id ? 3 : 2)) throw new WorkbenchError('INVALID_COMMAND', 'Unknown command or incorrect positional arguments. Run with --help.', 2);
    if ((group === 'source' || group === 'analysis' || group === 'note-draft' || command === 'material discover') && !id?.trim()) throw new WorkbenchError('INVALID_ARGUMENT', 'A nonempty workspace or article ID is required.', 2);
    for (const key of Object.keys(values)) {
      if (key !== 'json' && !spec.flags.includes(key)) throw new WorkbenchError('INVALID_ARGUMENT', `Option --${key} does not apply to ${command}.`, 2);
    }
    const string = (key: string, required = false): string | undefined => {
      const value = values[key];
      if (typeof value === 'string' && (!required || value.length > 0)) return value;
      if (required) throw new WorkbenchError('INVALID_ARGUMENT', `--${key} is required.`, 2);
      return undefined;
    };
    const integer = (key: string, fallback?: number, min = 1): number => {
      const value = string(key);
      const number = value === undefined ? fallback : /^\d+$/.test(value) ? Number(value) : NaN;
      if (number === undefined || !Number.isSafeInteger(number) || number < min) throw new WorkbenchError('INVALID_ARGUMENT', `--${key} must be an integer >= ${min}.`, 2);
      return number;
    };
    const content = async (): Promise<string> => {
      if (['file', 'stdin', 'text'].filter(key => values[key] !== undefined).length !== 1) throw new WorkbenchError('INVALID_ARGUMENT', 'Use exactly one of --file, --stdin or --text.', 2);
      if (values.stdin) return io.stdin();
      if (values.file !== undefined) {
        try { return await readFile(string('file', true)!, 'utf8'); }
        catch { throw new WorkbenchError('INPUT_FILE_ERROR', 'Could not read the input file.', 2); }
      }
      return string('text')!;
    };
    const client = suppliedClient ?? new WorkbenchClient();
    const workspaceRequest = (method: string, suffix = '', body?: unknown) => client.workspaceRequest(method, id!, suffix, body, values['context-revision'] === undefined ? undefined : integer('context-revision', undefined, 0));
    const jsonFile = async (): Promise<unknown> => {
      const path = string('file', true)!;
      try { return JSON.parse(await readFile(path, 'utf8')); }
      catch { throw new WorkbenchError('INVALID_JSON_FILE', '--file must point to a readable JSON file.', 2); }
    };
    let result: unknown;
    switch (command) {
      case 'memo list': result = await client.request('GET', '/memos', undefined, { q: string('query'), tag: string('tag'), excludeTag: string('exclude-tag'), unlinkedOnly: values['unlinked-only'] ? 'true' : undefined, startDate: string('start-date'), endDate: string('end-date'), limit: values.limit === undefined ? undefined : integer('limit') }); break;
      case 'memo get': result = await client.request('GET', `/memos/${encodeURIComponent(id!)}`); break;
      case 'memo related': result = await client.request('GET', `/memos/${encodeURIComponent(id!)}/related`); break;
      case 'tags list': result = await client.request('GET', '/tags', undefined, { prefix: string('prefix') }); break;
      case 'workspace list': result = await client.request('GET', '/workspaces'); break;
      case 'workspace create': result = await client.request('POST', '/workspaces', { memoId: string('memo', true), title: string('title') }); break;
      case 'workspace get': result = await workspaceRequest('GET'); break;
      case 'workspace refresh': result = await workspaceRequest('POST', '/refresh', {}); break;
      case 'workspace rebase': result = await workspaceRequest('POST', '/rebase', { baseVersion: integer('base-version') }); break;
      case 'workspace goal': result = await workspaceRequest('PATCH', '/goal', { goal: await content(), baseVersion: integer('base-version') }); break;
      case 'context get': result = await client.request('GET', '/context'); break;
      case 'context set': {
        const workspaceId = string('workspace', true)!;
        const parsed = contextSchema.safeParse({ workspaceId: workspaceId === 'none' ? null : workspaceId, view: string('view', true), baseRevision: integer('base-revision', undefined, 0) });
        if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', '--view must be note, materials, writing or draft.', 2);
        if (parsed.data.workspaceId === 'current') parsed.data.workspaceId = await client.resolveWorkspaceId('current', parsed.data.baseRevision);
        result = await client.request('PUT', '/context', parsed.data);
        break;
      }
      case 'annotation create': result = await workspaceRequest('POST', '/annotations', { content: await content(), idempotencyKey: string('idempotency-key', true) }); break;
      case 'draft update': result = await workspaceRequest('PATCH', '/draft', { draft: await content(), baseVersion: integer('base-version'), summary: string('summary') }); break;
      case 'draft diff': result = await client.diff(id!); break;
      case 'draft history': result = await workspaceRequest('GET', '/revisions'); break;
      case 'draft publish': result = await workspaceRequest('POST', '/publish', { baseVersion: integer('expected-version'), idempotencyKey: string('idempotency-key', true) }); break;
      case 'note-draft create':
      case 'note-draft update': {
        const noteDraftId = command === 'note-draft update' ? string('note-draft', true)! : undefined;
        if (noteDraftId !== undefined && !noteDraftId.trim()) throw new WorkbenchError('INVALID_ARGUMENT', '--note-draft must be a nonempty draft ID.', 2);
        const file = await jsonFile();
        if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some(key => key !== 'title' && key !== 'content')) throw new WorkbenchError('INVALID_ARGUMENT', 'Note draft file must contain only {title, content}; supply version, idempotency key and optional analysis basis separately.', 2);
        const input = { ...file, baseVersion: integer('base-version') };
        if (command === 'note-draft create') {
          const parsed = noteDraftCreateSchema.safeParse({ ...input, idempotencyKey: string('idempotency-key', true), originAnalysisId: string('basis') });
          if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', 'Use a title up to 200 characters, content up to 100000 characters, and an idempotency key of 1 to 200 characters.', 2);
          result = await workspaceRequest('POST', '/note-drafts', parsed.data);
        } else {
          const parsed = noteDraftUpdateSchema.safeParse(input);
          if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', 'Note draft file requires title (up to 200 characters) and content (up to 100000 characters).', 2);
          result = await workspaceRequest('PATCH', `/note-drafts/${encodeURIComponent(noteDraftId!)}`, parsed.data);
        }
        break;
      }
      case 'note-draft publish': {
        const noteDraftId = string('note-draft', true)!;
        if (!noteDraftId.trim()) throw new WorkbenchError('INVALID_ARGUMENT', '--note-draft must be a nonempty draft ID.', 2);
        const parsed = noteDraftPublishSchema.safeParse({ baseVersion: integer('base-version'), idempotencyKey: string('idempotency-key', true) });
        if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', '--idempotency-key must contain 1 to 200 characters.', 2);
        result = await workspaceRequest('POST', `/note-drafts/${encodeURIComponent(noteDraftId)}/publish`, parsed.data);
        break;
      }
      case 'material set': {
        const memoIds = string('memo');
        if (memoIds === undefined) throw new WorkbenchError('INVALID_ARGUMENT', '--memo is required; pass an empty string to remove all flomo materials.', 2);
        result = await workspaceRequest('PUT', '/materials', { memoIds: memoIds.split(',').map(value => value.trim()).filter(Boolean), baseVersion: integer('base-version') });
        break;
      }
      case 'material propose': {
        const parsed = candidatesSchema.safeParse({ items: await jsonFile(), baseVersion: integer('base-version') });
        if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', 'Proposal file must contain an array of {memoId, reason, relation}; relation is support, counterpoint, example or background.', 2);
        result = await workspaceRequest('POST', '/candidates', parsed.data);
        break;
      }
      case 'material decide': {
        const memoId = string('memo', true)!;
        const parsed = candidateChoiceSchema.safeParse({ status: string('status', true), baseVersion: integer('base-version') });
        if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', '--status must be selected, dismissed or proposed.', 2);
        result = await workspaceRequest('PATCH', `/candidates/${encodeURIComponent(memoId)}`, parsed.data);
        break;
      }
      case 'material discover': {
        const parsed = discoverySchema.safeParse({ terms: string('terms', true)!.split(/[,，\r\n]+/).map(term => term.trim()).filter(Boolean), tag: string('tag'), excludeTag: string('exclude-tag'), startDate: string('start-date'), endDate: string('end-date'), limit: integer('limit', 20), baseVersion: integer('base-version') });
        if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', 'Use 1–6 terms (up to 100 characters each), ISO dates (YYYY-MM-DD), and a limit between 1 and 30.', 2);
        result = await workspaceRequest('POST', '/discover', parsed.data);
        break;
      }
      case 'analysis create': {
        const parsed = analysisCreateSchema.safeParse({ writing: string('file') ? await jsonFile() : undefined, kind: string('kind', true), engine: string('engine', true), question: string('question'), basisAnalysisId: string('basis'), baseVersion: integer('base-version'), idempotencyKey: string('idempotency-key', true) });
        if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', 'Use kind insights, evolution, connections, outline or cards; engine builtin or external; question up to 5000 characters; and a nonempty idempotency key up to 200 characters.', 2);
        result = await workspaceRequest('POST', '/analyses', parsed.data);
        break;
      }
      case 'analysis list': result = await workspaceRequest('GET', '/analyses'); break;
      case 'analysis get': result = await workspaceRequest('GET', `/analyses/${encodeURIComponent(string('analysis', true)!)}`); break;
      case 'analysis complete':
      case 'analysis card-update': {
        const analysisId = string('analysis', true)!;
        const cardId = command === 'analysis card-update' ? string('card', true)! : undefined;
        const file = await jsonFile();
        if (!file || typeof file !== 'object' || Array.isArray(file) || 'baseVersion' in file) throw new WorkbenchError('INVALID_ARGUMENT', 'Input file must contain a JSON object without baseVersion; supply the version separately with --base-version.', 2);
        const input = { ...file, baseVersion: integer('base-version') };
        if (command === 'analysis complete') {
          const parsed = analysisResultSchema.safeParse(input);
          if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', 'Result file must contain {text, cards?}. Each card requires title, body, tags and sourceKeys from the analysis.', 2);
          result = await workspaceRequest('POST', `/analyses/${encodeURIComponent(analysisId)}/result`, parsed.data);
        } else {
          const parsed = analysisCardUpdateSchema.safeParse(input);
          if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', 'Card file must contain {title, body, tags, sourceKeys}; tags omit # and sourceKeys must refer to analysis sources.', 2);
          result = await workspaceRequest('PATCH', `/analyses/${encodeURIComponent(analysisId)}/cards/${encodeURIComponent(cardId!)}`, parsed.data);
        }
        break;
      }
      case 'analysis card-publish': {
        const analysisId = string('analysis', true)!;
        const cardId = string('card', true)!;
        const parsed = analysisCardPublishSchema.safeParse({ baseVersion: integer('base-version'), idempotencyKey: string('idempotency-key', true) });
        if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', '--idempotency-key must contain 1 to 200 characters.', 2);
        result = await workspaceRequest('POST', `/analyses/${encodeURIComponent(analysisId)}/cards/${encodeURIComponent(cardId)}/publish`, parsed.data);
        break;
      }
      case 'source resolve': result = await workspaceRequest('GET', '/sources'); break;
      case 'source get': {
        const parsed = sourceAttachSchema.shape.articleId.safeParse(id);
        if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', 'ARTICLE_ID must contain 1 to 500 characters.', 2);
        result = await client.request('GET', `/sources/${encodeURIComponent(parsed.data)}`);
        break;
      }
      case 'source attach':
      case 'source detach': {
        const parsed = sourceAttachSchema.safeParse({ articleId: string('article', true), baseVersion: integer('base-version') });
        if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', '--article must contain 1 to 500 characters.', 2);
        const { articleId, baseVersion } = parsed.data;
        result = command === 'source attach'
          ? await workspaceRequest('POST', '/sources', { articleId, baseVersion })
          : await workspaceRequest('DELETE', `/sources/${encodeURIComponent(articleId)}`, { baseVersion });
        break;
      }
      case 'decision add': {
        const file = await jsonFile();
        if (!file || typeof file !== 'object' || Array.isArray(file) || 'baseVersion' in file) throw new WorkbenchError('INVALID_ARGUMENT', 'Decision file must contain {question, options}; supply the version separately with --base-version.', 2);
        const parsed = decisionSchema.safeParse({ ...file, baseVersion: integer('base-version') });
        if (!parsed.success) throw new WorkbenchError('INVALID_ARGUMENT', 'Decision file must contain a question and up to six optional string options.', 2);
        result = await workspaceRequest('POST', '/decisions', parsed.data);
        break;
      }
      case 'decision answer': {
        const decisionId = string('decision', true)!;
        result = await workspaceRequest('PATCH', `/decisions/${encodeURIComponent(decisionId)}`, { answer: await content(), baseVersion: integer('base-version') });
        break;
      }
      case 'message add': {
        const role = string('role', true);
        if (role !== 'user' && role !== 'assistant') throw new WorkbenchError('INVALID_ARGUMENT', '--role must be user or assistant.', 2);
        result = await workspaceRequest('POST', '/messages', { role, content: await content(), baseVersion: integer('base-version') });
        break;
      }
      case 'ai run': result = await workspaceRequest('POST', '/ai', { prompt: string('prompt', true), baseVersion: integer('base-version'), idempotencyKey: string('idempotency-key', true) }); break;
      case 'job list': {
        const workspaceId = string('workspace');
        result = await client.request('GET', '/jobs', undefined, { workspaceId: workspaceId === undefined ? undefined : await client.resolveWorkspaceId(workspaceId) });
        break;
      }
      case 'job get': result = await client.request('GET', `/jobs/${encodeURIComponent(id!)}`); break;
      case 'job reconcile': result = await client.request('POST', `/jobs/${encodeURIComponent(id!)}/reconcile`, {}); break;
      case 'job abandon': {
        if (values.acknowledge !== true) throw new WorkbenchError('ACKNOWLEDGEMENT_REQUIRED', 'After manually checking flomo, pass --acknowledge to release an uncertain publication. The original request may still commit later; this command does not cancel it.', 2);
        result = await client.request('POST', `/jobs/${encodeURIComponent(id!)}/abandon`, { baseVersion: integer('base-version'), acknowledge: true });
        break;
      }
      case 'changes list': result = await client.request('GET', '/changes', undefined, { after: integer('after', 0, 0) }); break;
      case 'changes watch': {
        for await (const change of client.watch(integer('after', 0, 0), io.signal, text => io.stderr(`${text}\n`))) io.stdout(`${JSON.stringify(change)}\n`);
        return 0;
      }
      case 'settings get': result = await client.request('GET', '/settings'); break;
      case 'settings set': {
        let settings: unknown;
        try { settings = JSON.parse(await readFile(string('file', true)!, 'utf8')); }
        catch { throw new WorkbenchError('INVALID_SETTINGS', '--file must point to a readable JSON settings file.', 2); }
        result = await client.request('PUT', '/settings', settings);
        break;
      }
      case 'service status': result = await client.request('GET', '/health'); break;
    }
    io.stdout(`${JSON.stringify(result, null, values.json ? undefined : 2)}\n`);
    return 0;
  } catch (error) {
    const failure = error instanceof WorkbenchError ? error : new WorkbenchError('CLI_ERROR', 'The operation could not be completed.');
    io.stderr(`${JSON.stringify({ error: { code: failure.code, message: failure.message, ...(failure.details === undefined ? {} : { details: failure.details }) } })}\n`);
    return failure.exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.exitCode = await runCli(process.argv.slice(2), { ...defaultIO, signal: controller.signal });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
