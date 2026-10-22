import {useState} from "react";
import {GoalResearchHistory} from "./goal-research-history";
import {GoalExploreResults} from "./goal-explore-results";

/** One read surface for the selected original Goal; opening it never starts research. */
export function GoalResearchWorkbench(props: {goalId: string; active: boolean; zh: boolean; refreshRevision: number; readSourceUrl?: string}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  return <div className="goal-research-workbench">
    <GoalResearchHistory {...props}/>
    <details className="research-saved-evidence" open={evidenceOpen} onToggle={event => setEvidenceOpen(event.currentTarget.open)}>
      <summary>{props.zh ? "阅读已保存的结论" : "Read saved findings"}</summary>
      {evidenceOpen ? <GoalExploreResults goalId={props.goalId} zh={props.zh} active={props.active} readSourceUrl={props.readSourceUrl}/> : null}
    </details>
  </div>;
}
