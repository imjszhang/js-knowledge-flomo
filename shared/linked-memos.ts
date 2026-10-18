import type { Memo } from './contracts.js';

export interface LinkedMemoResolution {
  items: {
    id: string;
    direction: 'outgoing' | 'incoming' | 'bidirectional';
    status: 'available' | 'unavailable';
    memo?: Memo;
    message?: string;
  }[];
  truncated: boolean;
  checkedAt: string;
  warnings: string[];
}
