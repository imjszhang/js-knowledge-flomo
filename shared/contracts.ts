import { z } from 'zod';

export const pinnedTags = ['待编', '概要', '想法', '资源'] as const;
export type Actor = 'web' | 'cli' | 'mcp';
export interface Memo {
  id: string;
  url: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  content_truncated: boolean;
  linked_memos: string[];
}
export interface CollectorArticleSummary {
  id: string;
  title: string;
  sourceUrl: string;
  summary: string;
  digest: string;
  updatedAt: string;
}
export interface CollectorArticle extends CollectorArticleSummary {
  content: string;
  contentTruncated: boolean;
}
export interface CollectorMaterial {
  kind: 'collector';
  article: CollectorArticle;
  memoIds: string[];
  fetchedAt: string;
}
export interface SourceResolution {
  configured: boolean;
  truncated: boolean;
  items: {
    url: string;
    memoIds: string[];
    status: 'matched' | 'missing' | 'ambiguous' | 'unavailable';
    articles: CollectorArticleSummary[];
    message?: string;
  }[];
}
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  actor: Actor;
}
export type MaterialRelation = 'support' | 'counterpoint' | 'example' | 'background';
export interface MaterialCandidate {
  memo: Memo;
  reason: string;
  relation: MaterialRelation;
  status: 'proposed' | 'selected' | 'dismissed';
}
export interface Decision {
  id: string;
  question: string;
  options: string[];
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}
export type AnalysisKind = 'insights' | 'evolution' | 'connections' | 'outline' | 'cards';
export interface AnalysisSource {
  key: string;
  kind: 'flomo' | 'collector';
  id: string;
  url: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}
export interface NoteDraft {
  id: string;
  title: string;
  content: string;
  sources: AnalysisSource[];
  originAnalysisId?: string;
  status: 'draft' | 'publishing' | 'published' | 'uncertain' | 'failed';
  resultMemo?: Memo;
  error?: string;
  createdAt: string;
  updatedAt: string;
  actor: Actor;
  idempotencyKey: string;
  requestHash: string;
  publicationKey?: string;
  publicationHash?: string;
  publicationActor?: Actor;
}
export interface AnalysisCardInput {
  title: string;
  body: string;
  tags: string[];
  sourceKeys: string[];
}
export interface AnalysisCard extends AnalysisCardInput {
  id: string;
  status: 'draft' | 'publishing' | 'published' | 'uncertain' | 'failed';
  resultMemo?: Memo;
  error?: string;
  reviewedAt?: string;
  publicationKey?: string;
  publicationHash?: string;
  publicationActor?: Actor;
}
export interface AnalysisRecord {
  id: string;
  kind: AnalysisKind;
  engine: 'builtin' | 'external';
  question: string;
  basisAnalysisId?: string;
  writing?: WritingInput;
  status: 'prepared' | 'running' | 'succeeded' | 'failed';
  workspaceVersion: number;
  inputFingerprint: string;
  goal: string;
  sources: AnalysisSource[];
  instructions: string;
  output: string;
  cards: AnalysisCard[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  actor: Actor;
  idempotencyKey: string;
  requestHash: string;
}
export interface DiscoveryResult {
  workspace: Workspace;
  terms: string[];
  possiblyLimited: boolean;
  readCount: number;
  omitted: { memoId: string; reason: string }[];
}
export type WorkbenchView = 'note' | 'materials' | 'writing' | 'draft';
export interface ActiveContext {
  workspaceId: string | null;
  view: WorkbenchView;
  revision: number;
  updatedAt: string;
  workspace: Workspace | null;
}
export interface DraftRevision {
  id: string;
  workspaceId: string;
  fromVersion: number;
  toVersion: number;
  before: string;
  after: string;
  summary: string;
  actor: Actor;
  createdAt: string;
}
export interface Workspace {
  id: string;
  title: string;
  memoId: string;
  source: Memo;
  remote: Memo | null;
  sourceChanged: boolean;
  draft: string;
  version: number;
  materials: Memo[];
  collectorMaterials?: CollectorMaterial[];
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string;
  goal?: string;
  materialCandidates?: MaterialCandidate[];
  decisions?: Decision[];
  analyses?: AnalysisRecord[];
  noteDrafts?: NoteDraft[];
}
export interface Change {
  id: number;
  entity: 'workspace' | 'job' | 'settings' | 'context';
  entityId: string;
  kind: string;
  actor: Actor;
  version?: number;
  createdAt: string;
  summary?: string;
}
export interface Job {
  id: string;
  workspaceId: string;
  kind: 'ai' | 'publish' | 'annotation';
  resultMemo?: Memo;
  status: 'running' | 'succeeded' | 'failed' | 'uncertain';
  actor: Actor;
  text: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
  baseVersion: number;
  targetContent?: string;
}
export interface MemoSearch {
  unlinkedOnly?: boolean;
  excludeTag?: string;
  query?: string;
  tag?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}
export interface SearchResult {
  memos: Memo[];
  scope: 'remote-search';
  limit: number;
  possiblyLimited: boolean;
  checkedAt: string;
}
export interface TagResult {
  tags: string[];
  total: number;
  returned: number;
  truncated: boolean;
}
export interface Settings {
  pinnedTags: string[];
  refreshSeconds: number;
}
export const versionSchema = z.number().int().positive();
export const createWorkspaceSchema = z.object({ memoId: z.string().min(1), title: z.string().min(1).max(200).optional() }).strict();
export const updateDraftSchema = z.object({ draft: z.string().max(500_000), baseVersion: versionSchema, summary: z.string().max(500).optional() }).strict();
export const materialsSchema = z.object({ memoIds: z.array(z.string().min(1)).max(30), baseVersion: versionSchema }).strict();
export const sourceAttachSchema = z.object({ articleId:z.string().min(1).max(500), baseVersion:versionSchema }).strict();
export const messageSchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(100_000), baseVersion: versionSchema }).strict();
export const aiSchema = z.object({ prompt: z.string().min(1).max(30_000), baseVersion: versionSchema, idempotencyKey: z.string().min(1).max(200) }).strict();
export const publishSchema = z.object({ baseVersion: versionSchema, idempotencyKey: z.string().min(1).max(200) }).strict();
export const noteDraftCreateSchema = z.object({
  title:z.string().trim().max(200).default(''), content:z.string().max(100_000).default(''),
  baseVersion:versionSchema, idempotencyKey:z.string().min(1).max(200), originAnalysisId:z.string().min(1).optional(),
}).strict();
export const noteDraftUpdateSchema = z.object({title:z.string().trim().max(200),content:z.string().max(100_000),baseVersion:versionSchema}).strict();
export const noteDraftPublishSchema = publishSchema;
export const settingsSchema = z.object({ pinnedTags: z.array(z.string().min(1).max(100)).min(1).max(20), refreshSeconds: z.union([z.literal(0), z.number().int().min(30).max(3600)]) }).strict();
export const contextSchema = z.object({ workspaceId:z.string().min(1).nullable(), view:z.enum(['note','materials','writing','draft']), baseRevision:z.number().int().nonnegative() }).strict();
export const goalSchema = z.object({ goal:z.string().max(5000), baseVersion:versionSchema }).strict();
export const candidatesSchema = z.object({ items:z.array(z.object({ memoId:z.string().min(1), reason:z.string().min(1).max(2000), relation:z.enum(['support','counterpoint','example','background']) }).strict()).min(1).max(30), baseVersion:versionSchema }).strict();
export const candidateChoiceSchema = z.object({ status:z.enum(['selected','dismissed','proposed']), baseVersion:versionSchema }).strict();
export const decisionSchema = z.object({ question:z.string().min(1).max(2000), options:z.array(z.string().min(1).max(1000)).max(6).default([]), baseVersion:versionSchema }).strict();
export const decisionAnswerSchema = z.object({ answer:z.string().min(1).max(5000), baseVersion:versionSchema }).strict();
export const analysisKindSchema = z.enum(['insights','evolution','connections','outline','cards']);
export const discoverySchema = z.object({
  terms:z.array(z.string().trim().min(1).max(100)).min(1).max(6), tag:z.string().max(200).optional(), excludeTag:z.string().max(200).optional(),
  startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit:z.number().int().min(1).max(30).default(20), baseVersion:versionSchema,
}).strict();
export const writingInputSchema = z.object({
  stage:z.enum(['questions','outline','paragraph']), claim:z.string().trim().min(1).max(2000),
  audience:z.string().trim().max(1000).default(''), answers:z.string().trim().max(10000).default(''),
  structure:z.enum(['direct','scqa','golden-circle']),
  outline:z.string().trim().max(20000).default(''), section:z.string().trim().max(2000).default(''),
}).strict();
export type WritingInput = z.infer<typeof writingInputSchema>;
export const analysisCreateSchema = z.object({kind:analysisKindSchema, question:z.string().trim().max(5000).default(''),
  writing:writingInputSchema.optional(), engine:z.enum(['builtin','external']), basisAnalysisId:z.string().min(1).optional(), baseVersion:versionSchema,
  idempotencyKey:z.string().min(1).max(200),
}).strict();
export const analysisCardInputSchema = z.object({title:z.string().trim().min(1).max(200),body:z.string().trim().min(1).max(15000),
  tags:z.array(z.string().regex(/^[^\s#<>]+$/).max(100)).max(10),sourceKeys:z.array(z.string().min(1)).min(1).max(31),
}).strict();
export const analysisResultSchema = z.object({text:z.string().trim().min(1).max(100000),cards:z.array(analysisCardInputSchema).max(12).optional(),baseVersion:versionSchema}).strict();
export const analysisCardUpdateSchema = analysisCardInputSchema.extend({baseVersion:versionSchema}).strict();
export const analysisCardPublishSchema = z.object({baseVersion:versionSchema,idempotencyKey:z.string().min(1).max(200)}).strict();
