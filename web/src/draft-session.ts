import type { Workspace } from "../../shared/contracts";

export interface DraftSnapshot {
  draft: string;
  acknowledged: Workspace;
  conflict: Workspace | null;
  review: Workspace | null;
  saving: boolean;
  error: string | null;
}

type DraftTransport = {
  save: (id: string, draft: string, version: number) => Promise<Workspace>;
  read: (id: string) => Promise<Workspace>;
  onSaved: (workspace: Workspace) => void;
  holdExternalUpdates?: boolean;
};

/** Keeps the user's buffer separate from server revisions, including during an in-flight save. */
export class DraftSession {
  private snapshot: DraftSnapshot;
  private listeners = new Set<() => void>();
  private inFlight: Promise<Workspace> | null = null;
  private deferred: Workspace | null = null;

  constructor(
    workspace: Workspace,
    private transport: DraftTransport,
  ) {
    this.snapshot = {
      draft: workspace.draft,
      acknowledged: workspace,
      conflict: null,
      review: null,
      saving: false,
      error: null,
    };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get dirty() {
    return this.snapshot.draft !== this.snapshot.acknowledged.draft;
  }

  private update(change: Partial<DraftSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach((listener) => listener());
  }

  edit(draft: string) {
    const incoming = this.snapshot.review ?? this.snapshot.conflict;
    if (!incoming) { this.update({ draft, error: null }); return; }
    if (draft === incoming.draft) {
      this.update({ draft, acknowledged: incoming, review: null, conflict: null, error: null });
    } else if (draft === this.snapshot.acknowledged.draft && this.transport.holdExternalUpdates) {
      this.update({ draft, review: incoming, conflict: null, error: null });
    } else {
      this.update({ draft, conflict: incoming, review: null, error: null });
    }
  }
  append(content: string) {
    this.edit(`${this.snapshot.draft}\n\n${content}`);
  }

  receive(workspace: Workspace) {
    if (workspace.version <= this.snapshot.acknowledged.version) return;
    const pendingVersion = Math.max(this.snapshot.review?.version ?? 0, this.snapshot.conflict?.version ?? 0);
    if (workspace.version < pendingVersion) return;
    if (this.snapshot.saving) {
      if (!this.deferred || this.deferred.version < workspace.version)
        this.deferred = workspace;
      return;
    }
    if (workspace.draft === this.snapshot.draft) {
      this.update({
        acknowledged: workspace,
        draft: workspace.draft,
        conflict: null,
        review: null,
        error: null,
      });
    } else if (workspace.draft === this.snapshot.acknowledged.draft) {
      // Material or conversation updates can advance the revision without replacing local text.
      this.update({ acknowledged: workspace, conflict: null, review: null });
    } else if (!this.dirty && this.transport.holdExternalUpdates) {
      this.update({ review: workspace, conflict: null });
    } else if (!this.dirty) {
      this.update({ acknowledged: workspace, draft: workspace.draft, review: null, conflict: null, error: null });
    } else {
      this.update({ conflict: workspace, review: null });
    }
  }

  acceptReview() {
    const incoming = this.snapshot.review;
    if (!incoming) return;
    this.update({ acknowledged: incoming, draft: incoming.draft, review: null, conflict: null, error: null });
  }

  resolve(choice: "local" | "server") {
    const remote = this.snapshot.conflict;
    if (!remote) return;
    this.update({
      acknowledged: remote,
      draft: choice === "server" ? remote.draft : this.snapshot.draft,
      conflict: null,
      review: null,
      error: null,
    });
  }

  private saveOnce(): Promise<Workspace> {
    if (this.inFlight) return this.inFlight;
    if (this.snapshot.conflict)
      return Promise.reject(new Error("请先比较并处理草稿冲突。"));
    if (this.snapshot.review)
      return Promise.reject(new Error("有新的草稿修改待查看，请先确认后继续。"));
    if (!this.dirty) return Promise.resolve(this.snapshot.acknowledged);
    const { draft, acknowledged } = this.snapshot;
    this.update({ saving: true, error: null });
    this.inFlight = (async () => {
      try {
        const saved = await this.transport.save(
          acknowledged.id,
          draft,
          acknowledged.version,
        );
        this.update({ acknowledged: saved });
        this.transport.onSaved(saved);
        return saved;
      } catch (error) {
        this.update({
          error: error instanceof Error ? error.message : "草稿保存失败",
        });
        if (
          error &&
          typeof error === "object" &&
          "status" in error &&
          error.status === 409
        ) {
          try {
            this.deferred = await this.transport.read(acknowledged.id);
          } catch {
            /* Keep the local buffer if offline. */
          }
        }
        throw error;
      } finally {
        this.inFlight = null;
        this.update({ saving: false });
        const deferred = this.deferred;
        this.deferred = null;
        if (deferred) this.receive(deferred);
      }
    })();
    return this.inFlight;
  }

  async flush(): Promise<Workspace> {
    if (this.inFlight) await this.inFlight;
    if (this.snapshot.review) throw new Error("有新的草稿修改待查看，请先确认后继续。");
    while (this.dirty) {
      if (this.snapshot.conflict) throw new Error("请先比较并处理草稿冲突。");
      await this.saveOnce();
    }
    if (this.snapshot.conflict) throw new Error("请先比较并处理草稿冲突。");
    if (this.snapshot.review) throw new Error("有新的草稿修改待查看，请先确认后继续。");
    return this.snapshot.acknowledged;
  }
}
