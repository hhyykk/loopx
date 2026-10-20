"""Rejected refinements explain the rule without echoing caller values.

The real CLI and canonical File/SQLite owner prove that rejection writes
nothing and that correcting the same operation commits exactly once.
"""
from __future__ import annotations

import json
import subprocess
import sys

import pytest

from test_goal_acceptance_cli import acceptance_goal as acceptance_goal


def refinement(source_ref):
    return {
        "outcome_id": "export",
        "owner_agent_id": "agent-a",
        "objective": "Produce a usable export",
        "requirements": [{"id": "content", "description": "Retain the content"}],
        "source": {"ref": source_ref, "summary": "Synthetic source summary"},
    }


def arguments(project, cli, entrypoint, document, operation):
    revision = cli("inspect")[1]["provider_revision"]
    path = project / "refinement.json"
    if entrypoint == "refine":
        path.write_text(json.dumps(document))
        return path, ("goal-acceptance", "refine", "--goal-id", "goal-acceptance",
            "--agent-id", "agent-a", "--document", str(path), "--operation-id", operation,
            "--expected-provider-revision", revision, "--execute")
    path.write_text(json.dumps({"refinement": document, "operation_id": operation,
        "expected_provider_revision": revision}))
    return path, ("refresh-state", "--goal-id", "goal-acceptance", "--agent-id", "agent-a",
        "--no-global-sync", "--goal-outcome-update-json", str(path))


@pytest.mark.parametrize("entrypoint", ["refine", "refresh"])
@pytest.mark.parametrize(("source_ref", "detail"), [
    ("synthetic/private-ref", "source ref must be an opaque identifier"),
    ("synthetic-private-ref ", "source ref must be bounded nonempty text"),
])
def test_native_rejection_then_corrected_same_operation(acceptance_goal, entrypoint, source_ref, detail):
    project, _, cli, run = acceptance_goal
    before = cli("inspect")[1]
    state_before = (project / "state.md").read_bytes()
    path, args = arguments(project, cli, entrypoint, refinement(source_ref), "correctable-operation")
    code, rejected = run(*args)
    assert code == 1 and rejected["error"] == "goal_acceptance_invalid_request", rejected
    assert rejected["error_code"] == "goal_acceptance_invalid_request"
    assert rejected["error_detail"] == detail
    assert source_ref not in json.dumps(rejected)
    assert "Synthetic source summary" not in json.dumps(rejected)
    assert cli("inspect")[1] == before
    assert (project / "state.md").read_bytes() == state_before
    if entrypoint == "refresh":
        assert rejected["appended"] is False

    document = json.loads(path.read_text())
    patch = document if entrypoint == "refine" else document["refinement"]
    patch["source"]["ref"] = "evidence:export-v1"
    path.write_text(json.dumps(document))
    code, applied = run(*args)
    assert code == 0, applied
    result = applied if entrypoint == "refine" else applied["goal_outcome_update"]
    assert result["status"] == "applied"
    assert "error_detail" not in applied and "error_detail" not in result
    accepted = cli("inspect")[1]
    assert accepted["provider_revision"] != before["provider_revision"]
    code, repeated = run(*args)
    assert code == 0, repeated
    replay = repeated if entrypoint == "refine" else repeated["goal_outcome_update"]
    assert replay["status"] == "replayed"
    assert cli("inspect")[1] == accepted


@pytest.mark.parametrize("entrypoint", ["refine", "refresh"])
def test_native_markdown_shows_rule_without_the_rejected_value(acceptance_goal, entrypoint):
    project, _, cli, _ = acceptance_goal
    source_ref = "synthetic/private-markdown-value"
    _, args = arguments(project, cli, entrypoint, refinement(source_ref), "markdown-operation")
    result = subprocess.run([sys.executable, "-m", "loopx.cli",
        "--registry", str(project.parent / "registry.json"),
        "--runtime-root", str(project.parent / "runtime"), *args],
        capture_output=True, text=True, timeout=60)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "goal_acceptance_invalid_request" in result.stdout
    assert "source ref must be an opaque identifier" in result.stdout
    assert source_ref not in result.stdout + result.stderr


def test_unqualified_effect_reason_is_not_promoted_to_public_detail(monkeypatch):
    from loopx.control_plane.goals import acceptance

    private_reason = "synthetic-private-provider-context"
    monkeypatch.setattr(acceptance, "effect_runtime_result", lambda *_: {
        "status": "failed", "reason_code": "goal_acceptance_effect_failed",
        "reason": private_reason,
    })
    with pytest.raises(ValueError) as failure:
        acceptance._result("goal.acceptance.refine", {})
    assert str(failure.value) == "goal_acceptance_effect_failed"
    assert private_reason not in str(failure.value)
    assert not getattr(failure.value, "payload", {}).get("error_detail")
