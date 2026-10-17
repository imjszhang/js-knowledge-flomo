import type { DiscussionContext, Job, Message } from "../../shared/contracts";

export type PendingDiscussionRequest = { prompt: string; version: number; key: string; kind: "question" | "update" };

export async function prepareDiscussionRequest(
  pending: PendingDiscussionRequest | null,
  prompt: string,
  kind: PendingDiscussionRequest["kind"],
  prepareVersion: () => Promise<number>,
  newKey: () => string,
): Promise<PendingDiscussionRequest> {
  if (pending) return pending;
  return { prompt, kind, version: await prepareVersion(), key: newKey() };
}

export function confirmedDiscussionJob(pending: PendingDiscussionRequest | null, jobs: Job[], workspaceId: string) {
  return pending ? jobs.find(job => job.kind === "ai" && job.workspaceId === workspaceId && job.idempotencyKey === pending.key) : undefined;
}

export function promptAfterConfirmation(prompt: string, pending: PendingDiscussionRequest) {
  return pending.kind === "question" && prompt.trim() === pending.prompt ? "" : prompt;
}

function sameContext(a: DiscussionContext | undefined, b: DiscussionContext | undefined) {
  return !!a && !!b && a.capturedAt === b.capturedAt && a.workspaceVersion === b.workspaceVersion && a.fingerprint === b.fingerprint;
}

/** Match a generated answer to its own question even when another thought arrived meanwhile. */
export function conversationRounds(messages: Message[], activeContext?: DiscussionContext): Message[][] {
  const rounds: { messages: Message[]; lastIndex: number }[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") {
      rounds.push({ messages: [message], lastIndex: index });
      return;
    }
    const matching = message.discussionContext
      ? [...rounds].reverse().find(round => round.messages.some(item => item.role === "user" && sameContext(item.discussionContext, message.discussionContext)))
      : rounds.at(-1);
    if (matching) {
      matching.messages.push(message);
      matching.lastIndex = index;
    } else rounds.push({ messages: [message], lastIndex: index });
  });
  const sorted = rounds.sort((a, b) => a.lastIndex - b.lastIndex);
  const active = activeContext && sorted.find(round => round.messages.some(message => message.role === "user" && sameContext(message.discussionContext, activeContext)));
  return (active ? [...sorted.filter(round => round !== active), active] : sorted).map(round => round.messages);
}
