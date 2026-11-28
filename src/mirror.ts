import type { Bot, DeliveredResult, Result, RunDetail, Task, TaskProgress } from './model.ts';

export type BotOwner = 'web' | 'desktop';
export const ownerLabel: Record<BotOwner, string> = { web: 'Web', desktop: 'Desktop' };
export const oppositeOwner = (owner: BotOwner): BotOwner => (owner === 'web' ? 'desktop' : 'web');
export const managedSessionId = /^session-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export type SessionOrigin = { owner: BotOwner; local: boolean };

export type MirrorBot = Pick<Bot, 'id' | 'name'>;
export type MirrorCatalog = {
  owner: BotOwner;
  peer: BotOwner;
  state: 'disabled' | 'online' | 'offline' | 'unverified';
  reason?: string;
  bots: MirrorBot[];
};
export type MirrorSelection = { owner: BotOwner; bot: MirrorBot };
export type ResultRecord = Pick<
  Result,
  'id' | 'runId' | 'taskRevision' | 'summary' | 'checks' | 'createdAt' | 'humanAcceptedAt'
> & { fileCount: number };
export type DeliveredResultRecord = ResultRecord &
  Pick<DeliveredResult, 'deliveredAt' | 'deliveryText' | 'links' | 'primaryLink'>;
export type ReviewRecord = {
  id: string;
  resultId: string;
  actor: 'user' | 'bot';
  verdict: string;
  createdAt: number;
};
export type MirrorRecords = {
  results: ResultRecord[];
  reviews: ReviewRecord[];
  moreResults: boolean;
  moreReviews: boolean;
};
export type MirrorEvent = {
  id: number;
  kind: string;
  data: string;
  createdAt: number;
  report?: { kind: string; summary: string; runId: string | null };
};
export type MirrorDetail = {
  task: Task;
  result: ResultRecord | null;
  deliveredResult?: DeliveredResultRecord | null;
  records: MirrorRecords;
  events: MirrorEvent[];
  progress?: Omit<TaskProgress, 'reload'> & {
    reload: Pick<NonNullable<TaskProgress['reload']>, 'build' | 'at'> | null;
  };
  chatDelivery: 'awaiting-review' | 'pending' | 'uncertain' | 'delivered' | 'handled' | null;
  run: (Pick<RunDetail, 'id' | 'createdAt' | 'finishedAt' | 'outcome'> & { state: string }) | null;
};
