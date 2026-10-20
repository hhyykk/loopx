import { useEffect, useState } from "react";
import { fetchPrivateConversations, resolveBoundChatSession,
  type BoundConversationTarget, type ChatSessionSummary, type PrivateConversation } from "./chat";

/** Reads the source's title and executor. Admission remains with the Core owner. */
export function useBoundConversation(target: BoundConversationTarget | null, enabled: boolean) {
  const bindingId = target?.bindingId, sessionId = target?.sessionId;
  const key = JSON.stringify([bindingId, sessionId]);
  const [state, setState] = useState<{ key: string; session?: ChatSessionSummary; source?: PrivateConversation; error?: string }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled || bindingId === undefined || sessionId === undefined) return;
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    Promise.all([resolveBoundChatSession({ bindingId, sessionId }, controller.signal), fetchPrivateConversations(controller.signal)])
      .then(([session, connections]) => {
        if (!active) return;
        const source = connections.connections.find(row => row.binding_id === bindingId && row.audience === "owner" && row.context_available);
        if (!source) throw new Error("This private conversation connection is unavailable.");
        if (source.executor_endpoint_id !== session.agent_id) throw new Error("The original conversation's executor no longer matches its connection.");
        setState({ key, session, source });
      }).catch(error => { if (active) setState({ key, error: error instanceof Error ? error.message : String(error) }); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; controller.abort(); clearTimeout(timeout); };
  }, [bindingId, sessionId, key, enabled, revision]);
  return { ...(enabled && state?.key === key ? state : {}), retry: () => setRevision(value => value + 1) };
}
