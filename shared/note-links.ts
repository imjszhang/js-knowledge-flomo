import { z } from 'zod';
import type { Memo } from './contracts.js';

export const noteLinkInputSchema = z.object({
  targetMemoId:z.string().trim().min(1).max(500).regex(/^[A-Za-z0-9_-]+$/),
  direction:z.enum(['outgoing','bidirectional']).default('outgoing'),
  relation:z.enum(['support','counterpoint','example','background']).default('background'),
  reason:z.string().trim().max(2000).default(''),
  baseVersion:z.number().int().positive(),
}).strict();
export const noteLinkPreviewSchema = noteLinkInputSchema;
export const noteLinkCreateSchema = noteLinkInputSchema.extend({
  previewHash:z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey:z.string().min(1).max(200),
}).strict();
export type NoteLinkInput = z.infer<typeof noteLinkInputSchema>;
export type NoteLinkCreateInput = z.infer<typeof noteLinkCreateSchema>;
export interface NoteLinkStep {
  memoId:string;
  linkedMemoId:string;
  before:Memo;
  afterContent:string;
  alreadyLinked:boolean;
  status:'pending'|'writing'|'verified'|'uncertain'|'failed';
  resultMemo?:Memo;
  error?:string;
}
export interface NoteLinkPreview {
  workspaceId:string;
  sourceMemo:Memo;
  targetMemo:Memo;
  input:NoteLinkInput;
  previewHash:string;
  steps:NoteLinkStep[];
}
