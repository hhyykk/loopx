import {useState} from "react";
import {acceptanceRequest} from "../../data/goal-acceptance-actions";
import type {OutcomeRequirements} from "../../data/goal-acceptance-observation";
import {useWorkspaceI18n} from "./i18n";

/** One native declaration/readback owner. The form only appends a requirement. */
export function GoalOutcomeRequirements({goalId, declaration, fresh, canManage, providerRevision, onRefresh}: {
  goalId: string; declaration: OutcomeRequirements; fresh: boolean; canManage: boolean;
  providerRevision: string | null; onRefresh: () => Promise<void>;
}) {
  const zh = useWorkspaceI18n().locale === "zh-CN";
  return <section className="goal-outcomes" aria-label={zh ? "支撑成果" : "Supporting outcomes"}>
    <h4>{zh ? "支撑成果" : "Supporting outcomes"}</h4>
    <p>{zh ? "保留原始目标和累计要求。Agent 默认核对成果；自查结论与独立检查结果分别记录。" : "Keep original intent and accumulated requirements. Default Agent reviews remain distinct from independent checks."}</p>
    {declaration.outcomes.map(outcome => <Outcome key={`${goalId}:${outcome.id}`} goalId={goalId} outcome={outcome}
      fresh={fresh && declaration.current_lifetime} canManage={canManage && declaration.current_lifetime}
      revision={providerRevision} onRefresh={onRefresh} zh={zh}/>)}
  </section>;
}
function Outcome({goalId, outcome, fresh, canManage, revision, onRefresh, zh}: {
  goalId: string; outcome: OutcomeRequirements["outcomes"][number]; fresh: boolean; canManage: boolean;
  revision: string | null; onRefresh: () => Promise<void>; zh: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const status = {accepted: zh ? "当前检查通过" : "Checks passing", unverified: zh ? "尚未验证" : "Unverified",
    stale: zh ? "依据已变化" : "Evidence changed", failed: zh ? "检查失败" : "Checks failed",
    partial: zh ? "仅部分检查" : "Partial checks", held: zh ? "关联待确认" : "Association needs review"};
  async function save() {
    if (busy || !fresh || !canManage || !revision || !text.trim()) return;
    const identity = crypto.randomUUID();
    const request = pending ?? {action: "refine", expected_provider_revision: revision, operation_id: `outcome-ui:${identity}`,
      refinement: {outcome_id: outcome.id,
        requirements: [{id: `requirement-${identity}`, description: text.trim()}],
        source: {ref: `owner:${identity}`, summary: text.trim()}}};
    setPending(request); setBusy(true); setNotice("");
    try {
      await acceptanceRequest(goalId, request);
      await onRefresh(); setText(""); setPending(null);
      setNotice(zh ? "已保留新要求；原有要求保持，尚未运行检查。" : "Requirement retained alongside earlier requirements. No checks ran.");
    } catch {
      // Preserve the exact operation after ambiguity. A fresh read can reveal
      // a committed result; a conflicting basis requires explicit rebase.
      setNotice(zh ? "结果未确认。先刷新；重试保留原操作，版本冲突时重新准备。" : "Result unconfirmed. Refresh first; retry retains the original operation. Rebase after a version conflict.");
      await onRefresh();
    } finally {setBusy(false);}
  }
  return <article className="goal-outcome">
    <h5>{outcome.objective}</h5>
    <small>{outcome.owner_agent_id} · {zh ? "版本" : "Revision"} {outcome.revision}</small>
    <ul className="goal-overview-criteria">{outcome.requirements.map(requirement => <li key={requirement.id}>
      <span>{requirement.description}</span><small>{!fresh ? (zh ? "历史记录，需刷新" : "Retained; refresh required")
        : requirement.status !== "unverified" ? status[requirement.status]
        : requirement.agent_review?.basis_current ? ({met: zh ? "Agent 自查满足" : "Agent reports met", unmet: zh ? "Agent 发现缺口" : "Agent found gaps", uncertain: zh ? "Agent 尚不能确认" : "Agent uncertain"})[requirement.agent_review.conclusion]
        : requirement.agent_review ? (zh ? "要求或工作已变化，需重查" : "Requirements or work changed; review again") : status[requirement.status]}</small>
      {requirement.agent_review ? <details><summary>{zh ? "自查依据" : "Review basis"}</summary><p>{requirement.agent_review.conclusion} · {requirement.agent_review.note}</p>
        <ul>{requirement.agent_review.evidence_refs.map(ref => <li key={ref}>{ref}</li>)}</ul>
        <p>{zh ? "Agent 对所述证据的判断；不代表独立验证或用户确认。产物修改后需重新核对。" : "An Agent judgment about the cited evidence; not independent verification or owner approval. Review again after editing the artifact."}</p></details> : null}
    </li>)}</ul>
    <details><summary>{zh ? "关联工作与来源" : "Linked work and sources"}</summary>
      <ul>{outcome.work.map(work => <li key={work.todo_id}><code>{work.todo_id}</code> · {work.status}</li>)}</ul>
      {!outcome.work.length ? <p>{zh ? "尚未关联执行任务" : "No execution task linked"}</p> : null}
      <ul>{outcome.sources.map(source => <li key={source.ref}>{source.summary}</li>)}</ul>
    </details>
    {/* Keep an existing draft readable while its same-source write basis is unavailable. */}
    {canManage || text || pending ? <details><summary>{zh ? "补充要求" : "Add a requirement"}</summary>
      <form onSubmit={event => {event.preventDefault(); void save();}}>
        <label>{zh ? "新增要求（保留已有要求）" : "New requirement (earlier requirements stay)"}
          <textarea value={text} maxLength={512} disabled={busy || !!pending} onChange={event => setText(event.target.value)}/></label>
        <button type="submit" disabled={busy || !fresh || !canManage || !text.trim()}>{zh ? "保留要求" : "Retain requirement"}</button>
        <button type="button" disabled={busy} onClick={() => void onRefresh()}>{zh ? "刷新结果" : "Refresh result"}</button>
        {pending && !busy ? <button type="button" disabled={!fresh || !canManage || !revision} onClick={() => {setPending({...pending, operation_id: `outcome-ui:${crypto.randomUUID()}`, expected_provider_revision: revision}); setNotice("");}}>{zh ? "按当前版本重新准备" : "Rebase on current version"}</button> : null}
      </form>
    </details> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </article>;
}
