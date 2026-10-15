"""Derive scoped recovery evidence from canonical acceptance associations.

This projection never grants a binding. TypeScript replan semantics owns its
legal discharge outcomes; the canonical acceptance owner still guards execution.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from ...agents.agent_scope import agent_scope_item_claimed_by_agent_or_unclaimed

GOAL_ACCEPTANCE_HOLD_TRIGGERS = frozenset({"goal_acceptance_stale", "goal_acceptance_unbound"})


def acceptance_gaps_from_held_goal_binding(
    agent_todo_summary: dict[str, Any] | None,
    source_items: list[dict[str, Any]] | None,
    *,
    agent_id: str | None,
) -> list[dict[str, Any]]:
    """Retain native verification gaps and route scoped association holds.

    This is a read-only trigger, not an acceptance rebind. Other runnable work
    remains selectable; the frontier rule schedules a replan only when no
    advancement Todo can be selected for this agent.
    """

    if not isinstance(agent_todo_summary, dict):
        return []
    contract = agent_todo_summary.get("goal_acceptance_contract")
    if not isinstance(contract, dict) or contract.get("enabled") is not True:
        return []
    verification_gap = contract.get("verification_gap")
    gaps = ([{**verification_gap, "agent_id": agent_id}]
            if isinstance(verification_gap, dict) else [])
    if not agent_id:
        return gaps
    held_states = {
        task.get("todo_id"): task.get("state")
        for task in contract.get("tasks", [])
        if isinstance(task, dict)
        and task.get("state") in {"stale", "unbound"}
        and task.get("applicable") is True
    }
    for item in source_items or []:
        if (
            not isinstance(item, dict)
            or item.get("todo_id") not in held_states
            or item.get("role") != "agent"
            or item.get("status") not in {"open", "blocked"}
            or not agent_scope_item_claimed_by_agent_or_unclaimed(item, agent_id=agent_id)
        ):
            continue
        todo_id = str(item["todo_id"])
        state = held_states[todo_id]
        kind = f"goal_acceptance_{state}"
        generated_at = item.get("updated_at") or item.get("created_at")
        frontier_revision = hashlib.sha256(json.dumps(
            [todo_id, generated_at, contract.get("digest"), contract.get("revision"), state],
            ensure_ascii=True, separators=(",", ":"), default=str,
        ).encode("utf-8")).hexdigest()
        gap = {
            "kind": kind,
            "source": "goal_acceptance_contract",
            "agent_id": agent_id,
            "reason_code": kind,
            "vision_todo_ids": [todo_id],
            "frontier_revision": frontier_revision,
            "replan_trigger_summary": f"The acceptance association for {todo_id} is {state}.",
            "acceptance_summary": "Preserve the owner-confirmed criteria and the original Turn identity.",
            "resolution_hint": (
                f"Inspect {todo_id}, its acceptance binding and the owner's contract scope; "
                "a local validation contract must not unintentionally hold independent work. "
                "Prepare a scope/binding correction for the authorized owner when needed; "
                + ("restore the exact prior text/wait using todo update with --update-operation-id "
                   "and --update-expected-provider-revision after releasing any active lease; "
                   "if the prior declaration is unknown or cannot match, request owner rebind, " if state == "stale" else
                   "prepare the missing association for owner review, ") +
                "or record an evidence-linked path delta and continue via an eligible "
                "successor, or record a concrete blocker for the required owner confirmation. "
                "never rebind or settle a different Todo under the original Turn."
            ),
        }
        if isinstance(generated_at, str):
            gap["generated_at"] = generated_at
        gaps.append(gap)
        if len(gaps) == 3:
            break
    return gaps
