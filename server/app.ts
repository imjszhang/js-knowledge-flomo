import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { createWorkspaceSchema, updateDraftSchema, materialsSchema, messageSchema, aiSchema, publishSchema, settingsSchema, versionSchema,
  contextSchema, goalSchema, candidatesSchema, candidateChoiceSchema, decisionSchema, decisionAnswerSchema } from '../shared/contracts.js';
import type { Actor, Change } from '../shared/contracts.js';
import { AppError } from './errors.js';
import { ProviderError } from './provider-types.js';
import { WorkbenchService } from './service.js';

interface Options {
  service: WorkbenchService;
  webRoot?: string;
  flomoConfigured?: () => Promise<boolean>;
  periodicRefresh?: boolean;
}
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const cursorSchema = z.coerce.number().int().nonnegative().safe();
function actor(request: FastifyRequest): Actor {
  const value = request.headers['x-workbench-actor'];
  return value === 'cli' || value === 'mcp' ? value : 'web';
}

export async function createApp({ service, webRoot, flomoConfigured, periodicRefresh = false }: Options) {
  const app = Fastify({ logger:false, bodyLimit:1_000_000 });
  const { store, flomo } = service;
  const streams = new Set<() => void>();
  app.addHook('onRequest', async (request, reply) => {
    const host = new URL(`http://${request.headers.host ?? 'localhost'}`).hostname;
    if (!loopback.has(host)) throw new AppError('INVALID_HOST', '工作台仅允许本机访问', 403);
    const origin = request.headers.origin;
    if (origin) {
      let allowed = false;
      try { const url = new URL(origin); allowed = loopback.has(url.hostname) && url.protocol === 'http:' && (url.host === request.headers.host || ['5173','5174'].includes(url.port)); }
      catch { /* invalid origin */ }
      if (!allowed) throw new AppError('INVALID_ORIGIN', '不允许此来源访问本地工作台', 403);
    }
    if (!['GET','HEAD','OPTIONS'].includes(request.method) && !['web','cli','mcp'].includes(String(request.headers['x-workbench-actor'] ?? '')))
      throw new AppError('ACTOR_REQUIRED', '写入请求必须声明工作台入口', 403);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'请求参数不正确',details:error.issues}});
    if (error instanceof AppError) return reply.code(error.status).send({error:{code:error.code,message:error.message,details:error.details}});
    if (error instanceof ProviderError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    const statusCode = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof statusCode === 'number' && statusCode < 500 ? statusCode : 500;
    return reply.code(status).send({error:{code:status === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR', message:status === 400 ? '请求格式不正确' : '工作台操作失败，请稍后重试'}});
  });
  const idOf = (request: FastifyRequest) => z.object({id:z.string().min(1)}).parse(request.params).id;
  const root = '/api/v1';
  app.get(`${root}/health`, async () => ({ok:true, aiConfigured:Boolean(service.ai), flomoConfigured:flomoConfigured ? await flomoConfigured() : true}));
  app.get(`${root}/settings`, () => store.getSettings());
  app.put(`${root}/settings`, request => store.setSettings(settingsSchema.parse(request.body), actor(request)));
  app.get(`${root}/context`, () => store.getContext());
  app.put(`${root}/context`, request => store.setContext(contextSchema.parse(request.body),actor(request)));
  app.get(`${root}/memos`, request => {
    const query = z.object({q:z.string().max(1000).optional(), tag:z.string().max(200).optional(), excludeTag:z.string().max(200).optional(),
      startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), limit:z.coerce.number().int().min(1).max(50).default(30)}).parse(request.query);
    return flomo.search({query:query.q, tag:query.tag, excludeTag:query.excludeTag, startDate:query.startDate, endDate:query.endDate, limit:query.limit});
  });
  app.get(`${root}/memos/:id`, request => flomo.get(idOf(request)));
  app.get(`${root}/memos/:id/related`, request => flomo.related(idOf(request)));
  app.get(`${root}/tags`, request => flomo.tags(z.object({prefix:z.string().optional()}).parse(request.query).prefix));
  app.get(`${root}/workspaces`, () => store.listWorkspaces());
  app.post(`${root}/workspaces`, async (request, reply) => {
    const body = createWorkspaceSchema.parse(request.body);
    reply.code(201);
    return service.createWorkspace(body.memoId, body.title, actor(request));
  });
  app.get(`${root}/workspaces/:id`, request => store.getWorkspace(idOf(request)));
  app.get(`${root}/workspaces/:id/revisions`, request => store.listDraftRevisions(idOf(request)));
  app.patch(`${root}/workspaces/:id/goal`, request => {
    const body = goalSchema.parse(request.body);
    return store.updateWorkspace(idOf(request),body.baseVersion,actor(request),'goal',workspace => ({...workspace,goal:body.goal}));
  });
  app.post(`${root}/workspaces/:id/candidates`, request => {
    const body = candidatesSchema.parse(request.body);
    return service.proposeCandidates(idOf(request),body.items,body.baseVersion,actor(request));
  });
  app.patch(`${root}/workspaces/:id/candidates/:memoId`, request => {
    const {id,memoId} = z.object({id:z.string().min(1),memoId:z.string().min(1)}).parse(request.params);
    const body = candidateChoiceSchema.parse(request.body);
    return service.chooseCandidate(id,memoId,body.status,body.baseVersion,actor(request));
  });
  app.post(`${root}/workspaces/:id/decisions`, request => {
    const body = decisionSchema.parse(request.body);
    return service.createDecision(idOf(request),body.question,body.options,body.baseVersion,actor(request));
  });
  app.patch(`${root}/workspaces/:id/decisions/:decisionId`, request => {
    const {id,decisionId} = z.object({id:z.string().min(1),decisionId:z.string().min(1)}).parse(request.params);
    const body = decisionAnswerSchema.parse(request.body);
    return service.answerDecision(id,decisionId,body.answer,body.baseVersion,actor(request));
  });
  app.patch(`${root}/workspaces/:id/draft`, request => {
    const body = updateDraftSchema.parse(request.body);
    return store.updateWorkspace(idOf(request), body.baseVersion, actor(request), 'draft', workspace => ({...workspace,draft:body.draft}),body.summary);
  });
  app.put(`${root}/workspaces/:id/materials`, request => {
    const body = materialsSchema.parse(request.body);
    return service.setMaterials(idOf(request), body.memoIds, body.baseVersion, actor(request));
  });
  app.post(`${root}/workspaces/:id/messages`, request => {
    const body = messageSchema.parse(request.body);
    return store.updateWorkspace(idOf(request), body.baseVersion, actor(request), 'message', workspace => ({...workspace,
      messages:[...workspace.messages,{id:randomUUID(),role:body.role,content:body.content,createdAt:new Date().toISOString(),actor:actor(request)}]}));
  });
  app.post(`${root}/workspaces/:id/refresh`, request => service.refresh(idOf(request), actor(request)));
  app.post(`${root}/workspaces/:id/rebase`, request => service.rebase(idOf(request), z.object({baseVersion:versionSchema}).strict().parse(request.body).baseVersion, actor(request)));
  app.post(`${root}/workspaces/:id/ai`, async (request, reply) => {
    const body = aiSchema.parse(request.body); reply.code(202);
    return service.generate(idOf(request), body.prompt, body.baseVersion, body.idempotencyKey, actor(request));
  });
  app.post(`${root}/workspaces/:id/publish`, async (request, reply) => {
    const body = publishSchema.parse(request.body); reply.code(202);
    return service.publish(idOf(request), body.baseVersion, body.idempotencyKey, actor(request));
  });
  app.post(`${root}/workspaces/:id/annotations`, async (request, reply) => {
    const body = z.object({content:z.string().trim().min(1).max(20000), idempotencyKey:z.string().min(1).max(200)}).strict().parse(request.body);
    reply.code(202);
    return service.annotate(idOf(request), body.content, body.idempotencyKey, actor(request));
  });
  app.get(`${root}/jobs`, request => store.listJobs(z.object({workspaceId:z.string().optional()}).parse(request.query).workspaceId));
  app.get(`${root}/jobs/:id`, request => store.getJob(idOf(request)));
  app.post(`${root}/jobs/:id/reconcile`, request => service.reconcile(idOf(request)));
  app.post(`${root}/jobs/:id/abandon`, request => {
    const body = z.object({baseVersion:versionSchema,acknowledge:z.literal(true)}).strict().parse(request.body);
    return service.abandon(idOf(request),body.baseVersion,actor(request));
  });
  app.get(`${root}/changes`, request => store.changes(z.object({after:cursorSchema.default(0)}).parse(request.query).after));
  app.get(`${root}/events`, async (request, reply) => {
    const query = z.object({after:cursorSchema.default(0)}).parse(request.query);
    let cursor = request.headers['last-event-id'] ? cursorSchema.parse(request.headers['last-event-id']) : query.after;
    reply.hijack();
    reply.raw.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
    let replaying = true;
    let closed = false;
    const buffered: Change[] = [];
    function send(change: Change) {
      if (closed || change.id <= cursor) return;
      cursor = change.id;
      // A stalled browser can reconnect from the last delivered ID instead of retaining an unbounded buffer.
      if (reply.raw.writableLength > 1_000_000) { reply.raw.end(); return; }
      reply.raw.write(`id: ${change.id}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`);
    }
    const listener = (change: Change) => { if (replaying) buffered.push(change); else send(change); };
    store.events.on('change', listener);
    const heartbeat = setInterval(() => { if (!closed) reply.raw.write(': heartbeat\n\n'); }, 15_000);
    const cleanup = () => { closed = true; clearInterval(heartbeat); store.events.off('change', listener); streams.delete(stop); };
    const stop = () => { cleanup(); reply.raw.end(); };
    streams.add(stop);
    reply.raw.on('close', cleanup);
    try {
      while (!closed) {
        const batch = await store.changes(cursor);
        batch.forEach(send);
        if (batch.length < 1000) break;
      }
      buffered.sort((a,b) => a.id-b.id).forEach(send);
      replaying = false;
      if (!closed) reply.raw.write(`event: ready\ndata: ${JSON.stringify({cursor})}\n\n`);
    } catch { stop(); }
  });
  if (webRoot && existsSync(webRoot)) {
    await app.register(fastifyStatic, {root:webRoot, index:'index.html'});
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({error:{code:'NOT_FOUND',message:'接口不存在'}});
      return reply.sendFile('index.html');
    });
  } else app.get('/', (_request, reply) => reply.type('text/html').send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>flomo 工作台</title><p>后台服务已就绪。开发时打开 Vite 地址；正式运行前请执行 npm run build。</p></html>'));

  let refreshTask: Promise<void> | undefined;
  const timer = periodicRefresh ? setInterval(() => {
    if (refreshTask) return;
    refreshTask = (async () => {
      const settings = await store.getSettings();
      if (!settings.refreshSeconds) return;
      const busy = new Set((await store.listJobs()).filter(job => job.kind === 'publish' && ['running','uncertain'].includes(job.status)).map(job => job.workspaceId));
      const due = (await store.listWorkspaces()).filter(w => !busy.has(w.id) && Date.now()-Date.parse(w.lastCheckedAt) >= settings.refreshSeconds*1000)
        .sort((a,b) => a.lastCheckedAt.localeCompare(b.lastCheckedAt)).slice(0,5);
      for (const workspace of due) await service.refresh(workspace.id, 'web').catch(() => undefined);
    })().catch(() => { /* a failed refresh never advances lastCheckedAt; the next interval retries */ })
      .finally(() => { refreshTask = undefined; });
  }, 15_000) : undefined;
  timer?.unref();
  app.addHook('preClose', async () => { if (timer) clearInterval(timer); for (const stop of streams) stop(); await refreshTask; await service.close(); });
  return app;
}
