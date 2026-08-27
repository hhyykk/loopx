from __future__ import annotations

import base64
import json
import zlib

from loopx.control_plane.scheduler.scheduler_hint import (
    build_codex_app_scheduler_ack_hint,
    build_codex_app_scheduler_failure_hint,
)

FACTS_FLAG = "--scheduler-host-facts-chunk"


def _host_facts(operation: str) -> dict[str, object]:
    return {
        "schema_version": "loopx_scheduler_heartbeat_host_facts_v0",
        "operation": operation,
        "goal_id": "goal-native-followup",
        "agent_id": "agent-native-followup",
        "surface": "codex_app",
        "state_key": "scheduler_hint.codex_app.stateful_backoff",
        "reset_token": "reset-native-followup",
        "identity_signature": "identity-native-followup",
        "progression_index": 0,
        "progression_minutes": [15, 30, 60],
        "expected_rrule": "FREQ=MINUTELY;INTERVAL=15",
        "applied_rrule": "FREQ=MINUTELY;INTERVAL=15",
        "observed_host_rrule": "FREQ=MINUTELY;INTERVAL=3",
        "cadence_class": "active_work",
        "generated_at": "2026-08-27T06:30:00Z",
        "ack_needed": True,
        "apply_needed": True,
        "source": (
            "quota_scheduler_ack"
            if operation == "ack"
            else "quota_scheduler_host_update_failure"
        ),
        "host_match_observed": operation == "ack",
        "failure_kind": "timeout" if operation == "host_failure" else None,
    }


def _before() -> dict[str, object]:
    return {
        "should_run": True,
        "normal_delivery_allowed": True,
        "recovery_delivery_allowed": False,
        "effective_action": "normal_run",
        "self_repair_allowed": False,
        "capability_repair_allowed": False,
        "workspace_repair_allowed": False,
        "state": "eligible",
        "safe_bypass_allowed": False,
        "safe_bypass_kind": None,
        "blocked_action_scope": None,
        "quota": {
            "compute": 1,
            "window_hours": 4,
            "slot_minutes": 15,
            "spent_slots": 0,
            "allowed_slots": 16,
        },
    }


def _decode(cli_args: list[str]) -> dict[str, object]:
    encoded = "".join(
        cli_args[index + 1]
        for index, value in enumerate(cli_args)
        if value == FACTS_FLAG
    )
    padding = "=" * (-len(encoded) % 4)
    compressed = base64.urlsafe_b64decode(encoded + padding)
    return json.loads(zlib.decompress(compressed))


def test_ack_hint_carries_bounded_native_followup_facts_without_changing_verb() -> None:
    hint = build_codex_app_scheduler_ack_hint(
        goal_id="goal-native-followup",
        agent_id="agent-native-followup",
        applied_rrule="FREQ=MINUTELY;INTERVAL=15",
        reset_token="reset-native-followup",
        identity_signature="identity-native-followup",
        host_match_observed=True,
        scheduler_host_facts=_host_facts("ack"),
        scheduler_before=_before(),
    )

    cli_args = hint["cli_args"]
    assert cli_args[:2] == ["quota", "scheduler-ack-current"]
    assert FACTS_FLAG in cli_args
    assert cli_args[-6:] == [
        "--host-match-observed",
        "--reset-token",
        "reset-native-followup",
        "--identity-signature",
        "identity-native-followup",
        "--execute",
    ]
    assert len(cli_args) <= 64
    assert max(map(len, cli_args)) <= 512
    assert sum(map(len, cli_args)) <= 2_048
    payload = _decode(cli_args)
    assert payload["schema_version"] == "loopx_scheduler_host_followup_hint_v0"
    assert payload["host_facts"] == _host_facts("ack")
    assert payload["before"]["effective_action"] == "normal_run"
    assert payload["use_current_hint"] is True


def test_failure_hint_carries_the_same_versioned_native_boundary() -> None:
    facts = _host_facts("host_failure")
    hint = build_codex_app_scheduler_failure_hint(
        goal_id="goal-native-followup",
        agent_id="agent-native-followup",
        failed_rrule="FREQ=MINUTELY;INTERVAL=15",
        observed_host_rrule="FREQ=MINUTELY;INTERVAL=3",
        scheduler_host_facts=facts,
        scheduler_before=_before(),
    )

    cli_args = hint["cli_args"]
    assert cli_args[:2] == ["quota", "scheduler-fail-current"]
    assert FACTS_FLAG in cli_args
    assert cli_args[-1] == "--execute"
    assert sum(map(len, cli_args)) <= 2_048
    payload = _decode(cli_args)
    assert payload["host_facts"] == facts
    assert payload["use_current_hint"] is False


def test_legacy_hint_builder_without_host_facts_keeps_the_compatibility_route() -> None:
    hint = build_codex_app_scheduler_ack_hint(
        goal_id="goal-native-followup",
        agent_id="agent-native-followup",
        applied_rrule="FREQ=MINUTELY;INTERVAL=15",
        reset_token="reset-native-followup",
        identity_signature="identity-native-followup",
    )

    assert FACTS_FLAG not in hint["cli_args"]
    assert hint["cli_args"][-1] == "--execute"
