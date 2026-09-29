import type { Memo, MemoSearch, SearchResult, TagResult, Workspace } from '../shared/contracts.js';

export interface FlomoProvider {
  search(params: MemoSearch): Promise<SearchResult>;
  /** Returns a complete memo, or fails rather than returning editable partial text. */
  get(id: string): Promise<Memo>;
  tags(prefix?: string): Promise<TagResult>;
  related(id: string): Promise<Memo[]>;
  update(id: string, content: string, expectedUpdatedAt?: string, expectedContent?: string): Promise<Memo>;
}

export interface AIProvider {
  generate(
    workspace: Workspace,
    prompt: string,
    onChunk: (text: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<string>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly code: string, public readonly statusCode = 502) {
    super(message);
    this.name = 'ProviderError';
  }
}
