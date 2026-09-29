import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Change, Workspace } from "../../shared/contracts";
import { api } from "./api";
import { DraftSession } from "./draft-session";

export function useDebounce<T>(value: T, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useChanges() {
  const client = useQueryClient();
  const cursor = useRef(0);
  const [connected, setConnected] = useState(false);
  const [lastChange, setLastChange] = useState<Change | null>(null);
  useEffect(() => {
    const invalidate = (change: Change) => {
      if (change.id <= cursor.current) return;
      cursor.current = change.id;
      setLastChange(change);
      if (change.entity === "workspace") {
        void client.invalidateQueries({
          queryKey: ["workspace", change.entityId],
        });
        void client.invalidateQueries({ queryKey: ["workspaces"] });
        void client.invalidateQueries({ queryKey: ["revisions", change.entityId] });
      } else if (change.entity === "job") {
        void client.invalidateQueries({ queryKey: ["jobs"] });
      } else if (change.entity === "context") {
        void client.invalidateQueries({ queryKey: ["context"] });
      } else if (change.entity === "settings") {
        void client.invalidateQueries({ queryKey: ["settings"] });
      }
    };
    const events = new EventSource(`/api/v1/events?after=${cursor.current}`);
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.addEventListener("change", (event) => {
      try {
        invalidate(JSON.parse((event as MessageEvent).data) as Change);
      } catch {
        /* A malformed event should not break reconnection. */
      }
    });
    events.addEventListener("ready", () => {
      setConnected(true);
      // Refetch on every connection, including reconnects after a lost event stream.
      void client.invalidateQueries({ queryKey: ["workspace"] });
      void client.invalidateQueries({ queryKey: ["workspaces"] });
      void client.invalidateQueries({ queryKey: ["jobs"] });
      void client.invalidateQueries({ queryKey: ["settings"] });
      void client.invalidateQueries({ queryKey: ["context"] });
      void client.invalidateQueries({ queryKey: ["revisions"] });
      void api
        .changes(cursor.current)
        .then((changes) => changes.forEach(invalidate))
        .catch(() => {});
    });
    return () => events.close();
  }, [client]);
  return { connected, lastChange };
}

export function useDraft(workspace: Workspace) {
  const client = useQueryClient();
  const [session] = useState(
    () =>
      new DraftSession(workspace, {
        save: api.draft,
        holdExternalUpdates: true,
        read: api.workspace,
        onSaved: (saved) => {
          client.setQueryData<Workspace>(["workspace", saved.id], (previous) =>
            !previous || previous.version <= saved.version ? saved : previous,
          );
          void client.invalidateQueries({ queryKey: ["workspaces"] });
          void client.invalidateQueries({ queryKey: ["revisions", saved.id] });
        },
      }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => session.receive(workspace), [session, workspace]);
  useEffect(() => {
    if (!session.dirty || state.conflict) return;
    const timer = setTimeout(() => {
      void session.flush().catch(() => {});
    }, 900);
    return () => clearTimeout(timer);
  }, [session, state.draft, state.acknowledged.version, state.conflict]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (session.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [session]);
  return { session, ...state, dirty: session.dirty };
}
