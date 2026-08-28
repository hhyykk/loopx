from __future__ import annotations

from typing import Any

from loopx.control_plane.quota import monitor_poll


def _quiet_decision() -> dict[str, Any]:
    return {
        "goal_id": "monitor-runtime-fixture",
        "should_run": False,
        "normal_delivery_allowed": False,
        "recovery_delivery_allowed": False,
        "effective_action": "monitor_quiet_skip",
        "self_repair_allowed": False,
        "capability_repair_allowed": False,
        "workspace_repair_allowed": False,
        "state": "waiting",
        "safe_bypass_allowed": False,
        "agent_identity": {"agent_id": "codex-main-control"},
        "heartbeat_recommendation": {
            "recommended_mode": "monitor_quiet_until_material_transition"
        },
    }


def test_no_provider_path_crosses_one_native_transaction(
    tmp_path, monkeypatch
) -> None:
    before = _quiet_decision()
    calls: list[tuple[str, dict[str, Any]]] = []

    def native(method: str, params: dict[str, Any]) -> dict[str, Any]:
        calls.append((method, params))
        return {
            "schema_version": monitor_poll.QUOTA_MONITOR_POLL_COMMIT_RESULT_SCHEMA,
            "status": "preview",
            "payload": {
                "ok": True,
                "monitor_event": {
                    "before": monitor_poll.compact_quota_decision(before)
                },
            },
            "index_record": None,
        }

    monkeypatch.setattr(monitor_poll, "effect_runtime_result", native)
    result = monitor_poll.record_quota_monitor_poll_for_decision(
        before,
        {"runtime_root": str(tmp_path)},
        goal_id="monitor-runtime-fixture",
        after_decision=lambda _status: before,
        render_markdown=lambda _record: "unused",
    )

    assert result["ok"] is True
    assert len(calls) == 1
    assert calls[0][0] == "quota.monitor_poll.commit"
    assert calls[0][1]["phase"] == "commit"
