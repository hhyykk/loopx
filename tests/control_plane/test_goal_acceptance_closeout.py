"""An exhausted Todo frontier cannot erase declared Goal acceptance."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from loopx.control_plane import effect_runtime
from loopx.control_plane.coordination.runtime_shadow import build_todo_runtime_shadow_projection
from loopx.control_plane.todos.active_state_todo_parser import parse_active_state_todos
from tests.control_plane.canonical_authority_fixture import initialize_canonical_authority
from tests.test_loopx_turn_driver import _write_live_fixture

GOAL = "loopx-turn-fixture"
REPO = Path(__file__).resolve().parents[2]


@pytest.fixture
def owned_runtime(tmp_path, monkeypatch):
    for name in ("TMPDIR", "TEMP", "TMP"):
        monkeypatch.setenv(name, str(tmp_path))
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    yield
    assert effect_runtime._runtime_dir().resolve().is_relative_to(tmp_path.resolve())
    effect_runtime.restart_effect_runtime(wait_for_exit=True)


def _invoke(argv):
    result = subprocess.run([sys.executable, "-m", "loopx.entrypoint", *argv],
                            cwd=REPO, capture_output=True, text=True, timeout=60)
    assert not result.stderr, result.stderr
    return result.returncode, json.loads(result.stdout)


@pytest.mark.parametrize("provider", ["file", "sqlite"])
def test_goal_criteria_survive_closed_work_restart_and_revised_acceptance(tmp_path, owned_runtime, provider):
    project, runtime, registry = _write_live_fixture(tmp_path)
    registered = json.loads(registry.read_text())
    registered["goals"][0]["coordination"]["registered_agents"].append("peer-fixture")
    registry.write_text(json.dumps(registered))
    state = project / ".codex/goals" / GOAL / "ACTIVE_GOAL_STATE.md"
    todos = parse_active_state_todos(state.read_text(), item_limit=None)["agent_todos"]["items"]
    initialize_canonical_authority(runtime, GOAL,
        build_todo_runtime_shadow_projection(goal_id=GOAL, todos=todos, handoff_mode="soft_claim"),
        state_path=state, provider=provider)
    common = ["--registry", str(registry), "--runtime-root", str(runtime), "--format", "json"]
    acceptance = [*common, "goal-acceptance"]
    inspect = [*acceptance, "inspect", "--goal-id", GOAL]
    quota = [*common, "quota", "should-run", "--goal-id", GOAL, "--agent-id", "codex-fixture"]
    verify = [*acceptance, "verify", "--goal-id", GOAL, "--agent-id", "codex-fixture", "--execute"]
    document = {
        "scope": {"kind": "all_advancement"}, "objective": "Deliver both declared outcomes", "non_goals": [],
        "criteria": [
            {"id": "local-artifact", "description": "Local artifact check", "validation_argv": [sys.executable, "-c", "pass"]},
            {"id": "remaining-outcome", "description": "Retain the second required outcome",
             "validation_argv": [sys.executable, "-c", "from pathlib import Path; assert Path('required.txt').read_text() == 'accepted'"]},
        ],
        "bindings": [{"todo_id": "todo_fixture0001", "criterion_ids": ["local-artifact"]}],
    }
    path = tmp_path / "acceptance.json"
    path.write_text(json.dumps(document))
    code, basis = _invoke(inspect)
    assert code == 0, basis
    code, configured = _invoke([*acceptance, "configure", "--goal-id", GOAL, "--document", str(path),
        "--expected-provider-revision", basis["provider_revision"], "--execute"])
    assert code == 0, configured
    assert "verification_gap" not in configured["goal_acceptance_contract"]
    code, completed = _invoke([*common, "todo", "complete", "--goal-id", GOAL,
        "--todo-id", "todo_fixture0001", "--agent-id", "codex-fixture", "--no-follow-up",
        "--evidence", "Local criterion validated; separate Goal criteria remain"])
    assert code == 0 and completed["changed"] is True, completed
    assert completed["goal_acceptance_completion"]["results"] == [
        {"criterion_id": "local-artifact", "exit_code": 0, "passed": True},
    ]

    def requires_verification(expected_status):
        code, observed = _invoke(inspect)
        assert code == 0, observed
        contract = observed["goal_acceptance_contract"]
        assert contract["status"] == expected_status
        assert [criterion["id"] for criterion in contract["criteria"]] == ["local-artifact", "remaining-outcome"]
        code, decision = _invoke(quota)
        assert code == 0, decision
        assert decision["should_run"] is True
        assert decision["effective_action"] == "autonomous_replan_required"
        assert "terminal_state" not in decision["goal_frontier_projection"]
        gap = next(gap for gap in decision["goal_frontier_projection"]["acceptance_gaps"]
                   if gap.get("canonical_verification_required"))
        assert gap["criterion_ids"] == ["local-artifact", "remaining-outcome"]
        assert decision["autonomous_replan_obligation"]["todo_actions"] == []
        return gap["frontier_revision"]

    original_gap = requires_verification("unverified")
    assert effect_runtime._runtime_dir().resolve().is_relative_to(tmp_path.resolve())
    effect_runtime.restart_effect_runtime(wait_for_exit=True)
    assert requires_verification("unverified") == original_gap
    code, peer = _invoke([*quota[:-1], "peer-fixture"])
    assert code == 0 and peer["effective_action"] == "autonomous_replan_required", peer
    assert peer["goal_frontier_projection"]["acceptance_gaps"][0]["criterion_ids"] == ["local-artifact", "remaining-outcome"]
    code, plan = _invoke([*common, "turn", "plan", "--goal-id", GOAL, "--agent-id", "peer-fixture",
        "--host", "generic-cli", "--execution-mode", "isolated-headless",
        "--scan-root", str(project), "--include-transaction-detail"])
    assert code == 0, plan
    assert plan["turn_envelope"]["effective_action"] == "autonomous_replan_required"
    source = next(source for source in plan["turn_envelope"]["work_context"]["sources"]
                  if source["source"] == "goal_acceptance")
    assert [criterion["id"] for criterion in source["content"]["contract"]["criteria"]] == ["local-artifact", "remaining-outcome"]
    # The existing Todo-bound Host remains blocked without a selected Todo;
    # retaining a Goal obligation grants no new execution authority.
    assert plan["route"]["would_invoke_host"] is False
    code, failed = _invoke(verify)
    assert code == 1 and failed.get("goal_acceptance_contract", {}).get("status") == "failed", failed
    assert requires_verification("failed") != original_gap

    (project / "required.txt").write_text("accepted")
    code, passed = _invoke(verify)
    assert code == 0 and passed["goal_acceptance_contract"]["status"] == "accepted", passed
    code, finished = _invoke(quota)
    assert code == 0 and finished["effective_action"] == "terminal_no_followup", finished

    # An authorized contract revision invalidates the prior success; the same
    # criterion IDs survive, and the old receipt is retained as stale evidence.
    document["criteria"][1]["description"] = "Recheck the retained second outcome"
    path.write_text(json.dumps(document))
    code, current = _invoke(inspect)
    assert code == 0, current
    code, revised = _invoke([*acceptance, "configure", "--goal-id", GOAL, "--document", str(path),
        "--expected-provider-revision", current["provider_revision"], "--execute"])
    assert code == 0 and revised["goal_acceptance_contract"]["revision"] == 2, revised
    requires_verification("stale")
    code, reverified = _invoke(verify)
    assert code == 0 and reverified["goal_acceptance_contract"]["status"] == "accepted", reverified
    assert _invoke(quota)[1]["effective_action"] == "terminal_no_followup"
