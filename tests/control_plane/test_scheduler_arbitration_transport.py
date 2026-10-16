"""Fused scheduler facts must retain complete reads at the ordinary wire boundary."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from loopx.control_plane import effect_runtime
from loopx.control_plane.scheduler.arbitration import (
    SchedulerArbitration,
    SchedulerDisposition,
    _scheduler_arbitration_facts,
)
from loopx.control_plane.work_items.interaction_contract import _interaction_reads_and_arbitration


def contract() -> dict:
    return {"schema_version": "loopx_interaction_contract_v0", "mode": "bounded_delivery",
        "user_channel": {"action_required": False},
        "agent_channel": {"must_attempt": True, "delivery_allowed": True, "quiet_noop_allowed": False},
        "cli_channel": {"spend_allowed_now": False, "spend_after_validation": False}}


def encoded_size(value: dict) -> int:
    return len(json.dumps(value, separators=(",", ":")).encode())


def assert_private_files_removed(root: Path) -> None:
    assert list(root.glob("loopx-effect-*/params.json")) == []
    assert list(root.glob("loopx-effect-*/response.json")) == []


@pytest.mark.parametrize("reject", [False, True], ids=["complete", "rejected"])
def test_near_limit_read_survives_fused_arbitration_and_cleans_private_files(
    isolated_effect_runtime, reject: bool,
) -> None:
    root = Path(tempfile.gettempdir())
    read = {"command": "bad\0command" if reject else "read-complete-source",
        "source": "existing", "evidence": ""}
    # Match the legacy carrier and envelope sizes; nonce values themselves do not matter.
    params = {"required_reads": [read], "goal_id": None, "goal_state_file": None,
        "goal_acceptance_enabled": False, "selected_todo": {"todo_id": None},
        "task_orchestration_contract": {"schema_version": None, "mode": None, "primary_todo_id": None},
        "should_run": False, "delivery_allowed": True, "selection_required": False,
        "has_replan": False, "settlement_only": False, "effective_action": None,
        "command_prefix": "loopx"}
    envelope = {"schema_version": effect_runtime.EFFECT_RUNTIME_REQUEST_SCHEMA_VERSION,
        "token": "t" * 43, "request_id": "0" * 36,
        "method": "work_item.interaction_reads.project", "params": params}
    read["evidence"] = "x" * (effect_runtime.MAX_REQUEST_BYTES - encoded_size(envelope) - 128)
    assert encoded_size(envelope) + 1 < effect_runtime.MAX_REQUEST_BYTES
    fused = {**params, "arbitration_facts": _scheduler_arbitration_facts(contract())}
    assert encoded_size({**envelope, "params": fused}) > effect_runtime.MAX_REQUEST_BYTES
    try:
        if reject:
            with pytest.raises(effect_runtime.EffectRuntimeRejected, match="required read command contains NUL"):
                _interaction_reads_and_arbitration({"required_reads": [read]}, contract(),
                    runtime_root=None, registry_path=None, agent_scope_frontier_actions=())
        else:
            reads, arbitration = _interaction_reads_and_arbitration({"required_reads": [read]}, contract(),
                runtime_root=None, registry_path=None, agent_scope_frontier_actions=())
            assert reads == [read]
            assert arbitration == SchedulerArbitration(SchedulerDisposition.ACTIVE_WORK,
                "interaction_agent_attempt_required", "bounded_delivery")
    finally:
        assert_private_files_removed(root)
    assert effect_runtime.effect_runtime_result("runtime.ping", {})["ready"] is True


@pytest.mark.parametrize("reject", [False, True], ids=["complete", "rejected"])
def test_small_request_retains_large_generated_read_reply_and_cleans_private_files(
    isolated_effect_runtime, reject: bool,
) -> None:
    root = Path(tempfile.gettempdir())
    runtime_root = "/" + "r" * (effect_runtime.MAX_RESPONSE_BYTES // 2)
    prefix = "loopx --runtime-root " + runtime_root
    payload = {"goal_id": "goal-wire", "should_run": True,
        "agent_todo_summary": {"goal_acceptance_contract": {"enabled": True}},
        "selected_todo": {"todo_id": "todo_selected"},
        "required_reads": [{"command": "bad\0command"}] if reject else []}
    # The input carries this prefix once; generated acceptance/Todo reads each retain it.
    assert encoded_size({**payload, "command_prefix": prefix,
        "arbitration_facts": _scheduler_arbitration_facts(contract())}) < effect_runtime.MAX_REQUEST_BYTES - 4096
    expected = [{
        "command": prefix + " --format json goal-acceptance inspect --goal-id goal-wire",
        "source": "goal_acceptance", "ordering": "before_work",
        "reason": "Read full configured objective, non-goals and criteria with scope/revision. Scoped acceptance does not replace Goal intent or prove completion; disabled/changed criteria require a fresh guard.",
    }, {
        "command": prefix + " --format json todo list --goal-id goal-wire --todo-id todo_selected",
        "source": "selected_todo", "ordering": "before_work",
        "reason": "Read full current requirements and status/claim. Require one matching active Todo; missing, ambiguous or changed work requires a fresh guard. A summary cannot replace this read.",
    }]
    assert encoded_size({"required_reads": expected}) > effect_runtime.MAX_RESPONSE_BYTES
    try:
        if reject:
            with pytest.raises(effect_runtime.EffectRuntimeRejected, match="required read command contains NUL"):
                _interaction_reads_and_arbitration(payload, contract(), runtime_root=runtime_root,
                    registry_path=None, agent_scope_frontier_actions=())
        else:
            reads, arbitration = _interaction_reads_and_arbitration(payload, contract(), runtime_root=runtime_root,
                registry_path=None, agent_scope_frontier_actions=())
            assert reads == expected
            assert arbitration == SchedulerArbitration(SchedulerDisposition.ACTIVE_WORK,
                "interaction_agent_attempt_required", "bounded_delivery")
    finally:
        assert_private_files_removed(root)
    assert effect_runtime.effect_runtime_result("runtime.ping", {})["ready"] is True
