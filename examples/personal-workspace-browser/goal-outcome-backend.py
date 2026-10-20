"""Real disposable SQLite/packaged UI journey; no model or live Goal writes.

Run with an empty fixture directory and a free loopback port. Pass
--without-check-plan to exercise default review and failed-read recovery. The ordinary
Agent refinement uses the same native CLI as an external host after upgrade.
An explicit --assets-dir selects a frozen packaged UI for a UI counterfactual;
the default still requires a source-current bundle.
"""
import json
from pathlib import Path
import sys

from loopx.chat_server import serve_chat
from loopx.control_plane.coordination.runtime_shadow import build_todo_runtime_shadow_projection
from loopx.control_plane.testing.canary_harness import run_json_cli_result, write_fixture_registry

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests" / "control_plane"))
from canonical_authority_fixture import initialize_canonical_authority

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
project = root / "project"
project.mkdir()
state = project / "state.md"
state.write_text("---\nstatus: active\nobjective: Explain the product clearly\n---\n# Product launch\n\n"
    "## Objective\nExplain the product clearly. Keep accuracy, clarity and the approved introduction.\n\n"
    "## Agent Todo\n\n")
registry, runtime = root / "registry.json", root / "runtime"
write_fixture_registry(project=project, registry_path=registry, runtime_root=runtime,
    goal_id="product-launch", domain="product", adapter_kind="generic_project_goal_v0",
    state_file=str(state), registered_agents=["author"])
todo = {"schema_version": "todo_item_v0", "todo_id": "todo_tour", "role": "agent",
    "text": "Produce and improve the product presentation", "status": "open", "done": False,
    "task_class": "advancement_task", "action_kind": "implement", "index": 1,
    "source_section": "Agent Todo", "archive_state": "active", "claimed_by": "author"}
initialize_canonical_authority(runtime, "product-launch", build_todo_runtime_shadow_projection(
    goal_id="product-launch", todos=[todo], handoff_mode="soft_claim"), state_path=state, provider="sqlite")

def cli(*args):
    code, value = run_json_cli_result("goal-acceptance", *args, "--goal-id", "product-launch",
        registry_path=registry, runtime_root=runtime)
    if code:
        raise RuntimeError(value)
    return value

for index, (criterion, description) in enumerate([
    ("tour-opening", "Retain the approved introduction"),
    ("tour-order", "Show delegation before the task board"),
]):
    document = {"outcome_id": "product-tour", "owner_agent_id": "author", "objective": "Deliver a clear product tour",
        "requirements": [{"id": criterion, "description": description}], "todo_ids": ["todo_tour"],
        "source": {"ref": f"message:refinement-{index}", "summary": description}}
    path = root / f"refinement-{index}.json"
    path.write_text(json.dumps(document))
    cli("refine", "--agent-id", "author", "--document", str(path), "--operation-id", f"refine-{index}",
        "--expected-provider-revision", cli("inspect")["provider_revision"], "--execute")

(project / "tour.txt").write_text("Delegation\nTask board\n")
(project / "check-tour.py").write_text(
    "from pathlib import Path\nimport sys\ntext = Path('tour.txt').read_text()\n"
    "if sys.argv[1] == 'opening': assert text.startswith('Introduction\\n')\n"
    "else: assert text.index('Delegation') < text.index('Task board')\n"
)
review = {"outcome_id": "product-tour", "source": {"ref": "artifact:review", "summary": "Reviewed the first presentation"},
    "review": [
        {"id": "tour-opening", "conclusion": "unmet", "evidence_refs": ["tour.txt"], "note": "The introduction is still missing"},
        {"id": "tour-order", "conclusion": "met", "evidence_refs": ["tour.txt"], "note": "Delegation precedes the task board"},
    ]}
path = root / "review.json"
path.write_text(json.dumps(review))
cli("refine", "--agent-id", "author", "--document", str(path), "--operation-id", "review",
    "--expected-provider-revision", cli("inspect")["provider_revision"], "--execute")
path = root / "checks.json"
path.write_text(json.dumps({"outcome_id": "product-tour", "criteria": [
    {"id": "tour-opening", "validation_argv": ["python3", "check-tour.py", "opening"]},
    {"id": "tour-order", "validation_argv": ["python3", "check-tour.py", "order"]},
]}))
if "--without-check-plan" not in sys.argv[3:]:
    cli("prepare", "--agent-id", "author", "--document", str(path), "--operation-id", "check-plan", "--execute")

print(json.dumps({"ready": True, "port": int(sys.argv[2]), "registry": str(registry), "runtime": str(runtime)}), flush=True)
serve_chat(registry_path=registry, runtime_root_override=runtime, scan_roots=[project],
    port=int(sys.argv[2]), codex_bin="unavailable-synthetic-host", claude_bin="unavailable-synthetic-host",
    assets_dir=Path(sys.argv[sys.argv.index("--assets-dir") + 1]) if "--assets-dir" in sys.argv else None)
