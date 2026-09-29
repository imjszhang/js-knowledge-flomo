import { z } from 'zod';

export const pinnedTags = ['待编', '概要', '想法', '摘要', '资源'] as const;
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
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  actor: Actor;
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
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string;
}
export interface Change {
  id: number;
  entity: 'workspace' | 'job' | 'settings';
  entityId: string;
  kind: string;
  actor: Actor;
  version?: number;
  createdAt: string;
}
export interface Job {
  id: string;
  workspaceId: string;
  kind: 'ai' | 'publish';
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
export const updateDraftSchema = z.object({ draft: z.string().max(500_000), baseVersion: versionSchema }).strict();
export const materialsSchema = z.object({ memoIds: z.array(z.string().min(1)).max(30), baseVersion: versionSchema }).strict();
export const messageSchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(100_000), baseVersion: versionSchema }).strict();
export const aiSchema = z.object({ prompt: z.string().min(1).max(30_000), baseVersion: versionSchema, idempotencyKey: z.string().min(1).max(200) }).strict();
export const publishSchema = z.object({ baseVersion: versionSchema, idempotencyKey: z.string().min(1).max(200) }).strict();
export const settingsSchema = z.object({ pinnedTags: z.array(z.string().min(1).max(100)).min(1).max(20), refreshSeconds: z.union([z.literal(0), z.number().int().min(30).max(3600)]) }).strict();
