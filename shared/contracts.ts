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
export type WorkbenchView = 'note' | 'materials' | 'draft';
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
export const settingsSchema = z.object({ pinnedTags: z.array(z.string().min(1).max(100)).min(1).max(20), refreshSeconds: z.union([z.literal(0), z.number().int().min(30).max(3600)]) }).strict();
export const contextSchema = z.object({ workspaceId:z.string().min(1).nullable(), view:z.enum(['note','materials','draft']), baseRevision:z.number().int().nonnegative() }).strict();
export const goalSchema = z.object({ goal:z.string().max(5000), baseVersion:versionSchema }).strict();
export const candidatesSchema = z.object({ items:z.array(z.object({ memoId:z.string().min(1), reason:z.string().min(1).max(2000), relation:z.enum(['support','counterpoint','example','background']) }).strict()).min(1).max(30), baseVersion:versionSchema }).strict();
export const candidateChoiceSchema = z.object({ status:z.enum(['selected','dismissed','proposed']), baseVersion:versionSchema }).strict();
export const decisionSchema = z.object({ question:z.string().min(1).max(2000), options:z.array(z.string().min(1).max(1000)).max(6).default([]), baseVersion:versionSchema }).strict();
export const decisionAnswerSchema = z.object({ answer:z.string().min(1).max(5000), baseVersion:versionSchema }).strict();
