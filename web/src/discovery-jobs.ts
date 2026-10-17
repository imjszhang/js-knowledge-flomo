import type { Job } from "../../shared/contracts";

export const emptyDiscoveryFilters = { tag: "", excludeTag: "", startDate: "", endDate: "", limit: 20 };
export type DiscoveryFilters = typeof emptyDiscoveryFilters;
export type AIDiscoveryRequest = {
  instruction: string;
  tag?: string;
  excludeTag?: string;
  startDate?: string;
  endDate?: string;
  limit: number;
  baseVersion: number;
  idempotencyKey: string;
};
export type DiscoveryAttempt = {
  payload: AIDiscoveryRequest;
  filters: DiscoveryFilters;
  instruction: string;
};

export function discoveryFilterInput(filters: DiscoveryFilters) {
  return {
    limit: filters.limit,
    ...(filters.tag.trim() ? {tag: filters.tag.trim().replace(/^#+/, "")} : {}),
    ...(filters.excludeTag.trim() ? {excludeTag: filters.excludeTag.trim().replace(/^#+/, "")} : {}),
    ...(filters.startDate ? {startDate: filters.startDate} : {}),
    ...(filters.endDate ? {endDate: filters.endDate} : {}),
  };
}

/** An unconfirmed submission always retries the exact payload, even after local edits. */
export function prepareDiscoveryAttempt(previous: DiscoveryAttempt | null, filters: DiscoveryFilters, instruction: string, baseVersion: number, createKey: () => string): DiscoveryAttempt {
  if (previous) return previous;
  return {
    payload: {...discoveryFilterInput(filters), instruction: instruction.trim(), baseVersion, idempotencyKey: createKey()},
    filters: {tag:filters.tag,excludeTag:filters.excludeTag,startDate:filters.startDate,endDate:filters.endDate,limit:filters.limit},
    instruction,
  };
}

/** SSE may have fetched a newer phase or completion before the start response arrives. */
export function mergeDiscoveryJob(jobs: Job[] | undefined, incoming: Job): Job[] {
  const previous = jobs?.find(job => job.id === incoming.id);
  const completed = previous && previous.status !== "running" && incoming.status === "running";
  const job = previous && (completed || previous.updatedAt > incoming.updatedAt) ? previous : incoming;
  return [job, ...(jobs ?? []).filter(item => item.id !== job.id)];
}

export function discoveryJobLabel(job: Job): string {
  if (job.status === "succeeded") return "查找完成";
  if (job.status === "failed") return "查找未完成";
  if (job.status === "uncertain") return "结果待核实";
  return {planning:"正在生成检索词",searching:"正在搜索并补读全文",ranking:"正在比较材料并整理推荐"}[job.discovery?.phase ?? "planning"];
}
