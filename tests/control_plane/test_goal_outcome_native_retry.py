"""Native outcome recovery retains provenance without bypassing live admission."""

import json

from loopx.chat_loopx_mode import TOOL
from loopx.chat_runtime import ChatRuntimeController
from loopx.chat_store import ChatSessionStore
from loopx.control_plane.goals import acceptance
from test_goal_acceptance_cli import acceptance_goal as acceptance_goal
from test_goal_acceptance_prepared_action import conversation_check as conversation_check


def outcome_request(adapter):
    before = adapter.session.read_tool_handler(TOOL["name"], {"action": "outcomes"})
    return {
        "action": "refine_outcome", "operation_id": "retain-tour-request",
        "expected_provider_revision": before["provider_revision"],
        "document": {
            "outcome_id": "tour", "objective": "Deliver the requested tour",
            "requirements": [{"id": "opening", "description": "Keep the introduction"}],
            "source_summary": "The owner requested a tour retaining the introduction",
        },
    }


def test_committed_lost_reply_replays_original_envelope_after_restart_and_new_turn(
    conversation_check, monkeypatch,
):
    project, cli, controller, sid, _, _, adapter = conversation_check
    request = outcome_request(adapter)
    original_refine = acceptance.refine_goal_outcome

    def lose_reply(**arguments):
        original_refine(**arguments)
        raise OSError("response lost after canonical commit")

    monkeypatch.setattr(acceptance, "refine_goal_outcome", lose_reply)
    assert adapter.session.read_tool_handler(TOOL["name"], request)["ok"] is False
    monkeypatch.setattr(acceptance, "refine_goal_outcome", original_refine)
    committed = cli("inspect")[1]
    outcomes = committed["goal_acceptance_contract"]["outcome_requirements"]
    assert outcomes["revision"] == 1
    source = outcomes["outcomes"][0]["sources"][0]
    assert source["ref"].startswith("turn:admitted-tool-turn:")

    # Recreate both caller objects so recovery can only use durable Session data.
    restarted = ChatRuntimeController(store=ChatSessionStore(project.parent / "runtime"),
        codex_bin="unused", registry_path=controller.registry_path)
    try:
        resumed = adapter.prepare_turn("later-tool-turn", runtime_controller=restarted)
        handler = resumed.session.read_tool_handler
        replay = handler(TOOL["name"], request)
        assert replay["ok"] and replay["status"] == "replayed", replay
        retained = replay["goal_acceptance_contract"]["outcome_requirements"]
        assert retained["revision"] == 1
        assert retained["outcomes"][0]["sources"] == [source]
        assert cli("inspect")[1] == committed

        for changed in (
            {**request, "document": {**request["document"], "source_summary": "A different request"}},
            {**request, "expected_provider_revision": committed["provider_revision"]},
            {**request, "document": {**request["document"], "source": source}},
            {**request, "document": {**request["document"], "owner_agent_id": "agent-a"}},
        ):
            assert handler(TOOL["name"], changed)["error"] == "collaboration_request_rejected"
        assert cli("inspect")[1] == committed

        # Possession of a saved operation never substitutes for live admission.
        mode = restarted.store.load_session(sid)["loopx_mode"]
        restarted.store.update_session(sid, loopx_mode={**mode, "paused": True})
        assert handler(TOOL["name"], request)["error"] == "conversation_execution_inactive"
        restarted.store.update_session(sid, loopx_mode=mode)
        (project / ".loopx/config/delegations.json").unlink()
        assert handler(TOOL["name"], request)["error"] == "collaboration_request_rejected"
        assert cli("inspect")[1] == committed
    finally:
        restarted.close()


def test_another_session_or_actor_cannot_reuse_saved_outcome_operation(conversation_check):
    project, cli, controller, sid, _, _, adapter = conversation_check
    request = outcome_request(adapter)
    first = adapter.session.read_tool_handler(TOOL["name"], request)
    assert first["ok"], first
    committed = cli("inspect")[1]
    mode = controller.store.load_session(sid)["loopx_mode"]
    other = controller.store.create_session(goal_id="goal-acceptance", agent_id="codex",
        channel_id="goal.goal-acceptance", upstream_thread_id="another-thread",
        upstream_mode="chat", adapter_kind="codex_app_server")
    controller.store.update_session(other["session_id"], loopx_mode=mode)
    # Even an identical opaque Turn ID in another Session cannot inherit source.
    foreign = adapter.prepare_turn("admitted-tool-turn", session_id=other["session_id"])
    assert foreign.session.read_tool_handler(TOOL["name"], request)["error"] == "collaboration_request_rejected"

    registry = controller.registry_path
    payload = json.loads(registry.read_text())
    payload["goals"][0]["coordination"]["registered_agents"].append("other-coordinator")
    registry.write_text(json.dumps(payload))
    config = project / ".loopx/config/delegations.json"
    bindings = json.loads(config.read_text())
    bindings["bindings"][0]["requesters"].append("other-coordinator")
    config.write_text(json.dumps(bindings))
    controller.store.update_session(sid, loopx_mode={**mode,
        "settings": {**mode["settings"], "agent_id": "other-coordinator"}})
    changed_actor = foreign.prepare_turn("new-actor-turn", session_id=sid)
    result = changed_actor.session.read_tool_handler(TOOL["name"], request)
    assert result["error"] == "collaboration_request_rejected", result
    assert cli("inspect")[1] == committed


def test_outcome_observations_never_replace_or_emit_member_deliveries(conversation_check):
    _, _, controller, sid, _, _, adapter = conversation_check
    deliveries = [{"operation_id": "member-delivery", "agent_id": "agent-a",
        "todo_id": "todo_export", "status": "accepted"}]
    controller.store.update_session(sid, loopx_deliveries=deliveries)
    request = outcome_request(adapter)
    handler = adapter.session.read_tool_handler
    for arguments in (request, request, {"action": "outcomes"}):
        assert handler(TOOL["name"], arguments)["ok"]
        assert controller.store.load_session(sid)["loopx_deliveries"] == deliveries
    assert not any(kind == "collaboration.execution" for kind, _ in adapter.events)
