"""Project todo summaries and items from one active-state text.

The text is a parameter rather than a file read so a writer that still holds
the state-file lock can project the exact bytes it is about to commit;
``loopx.control_plane.todos.list_readback.list_goal_todos`` passes the on-disk
text. Everything here is a projection of those bytes and rollout metadata. Retired event sources are
rejected before any Markdown substitution.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..goals.legacy_event_source import require_no_legacy_todo_events
from .active_state_editing import TODO_SECTION_HEADINGS
from .contract import (
    normalize_todo_claimed_by,
    normalize_todo_id,
    normalize_todo_status,
)
from .todo_summary import compact_evaluated_todo_group


def empty_todo_summary(*, role: str) -> dict[str, Any]:
    return {
        "schema_version": "todo_summary_v0",
        "role": role,
        "source_section": TODO_SECTION_HEADINGS[role],
        "total_count": 0,
        "open_count": 0,
        "done_count": 0,
        "items": [],
        "first_open_items": [],
    }

def filtered_todo_summary(
    summary: dict[str, Any] | None,
    *,
    role: str,
    status: str | None = None,
    todo_id: str | None = None,
    agent_id: str | None = None,
    item_limit: int | None = None,
) -> dict[str, Any]:
    items = list((summary or {}).get("items") or [])
    selection = {"role": role, "status": normalize_todo_status(status),
        "todo_id": normalize_todo_id(todo_id) if todo_id else None,
        "agent_id": normalize_todo_claimed_by(agent_id) if agent_id else None}
    source_section = str((summary or {}).get("source_section") or TODO_SECTION_HEADINGS[role])
    return (
        compact_evaluated_todo_group(
            items,
            source_section=source_section,
            role=role,
            item_limit=item_limit,
            selection=selection,
        )
        or empty_todo_summary(role=role)
    )

def summary_items(fields: dict[str, Any], role: str) -> list[dict[str, Any]]:
    summary = fields.get(f"{role}_todos") if isinstance(fields, dict) else None
    if not isinstance(summary, dict):
        return []
    return [item for item in summary.get("items") or [] if isinstance(item, dict)]


class GoalTodoSummaries:
    """Role summaries and todo items projected from one active-state text."""

    __slots__ = (
        "source",
        "summaries",
        "todos",
        "unfiltered_count",
        "uncapped_todo_count",
    )

    def __init__(
        self,
        *,
        source: str,
        summaries: dict[str, dict[str, Any]],
        todos: list[dict[str, Any]],
        unfiltered_count: int,
        uncapped_todo_count: int,
    ) -> None:
        self.source = source
        self.summaries = summaries
        self.todos = todos
        self.unfiltered_count = unfiltered_count
        self.uncapped_todo_count = uncapped_todo_count

def goal_todo_summaries(
    goal: dict[str, Any] | None,
    *,
    state_text: str,
    state_path: Path,
    rollout_events: list[dict[str, Any]],
    roles: list[str],
    status: str | None,
    todo_id: str | None,
    agent_id: str | None,
    limit: int | None,
    include_retained: bool = False,
) -> GoalTodoSummaries:
    from .read_projection import prepare_todo_source_text, project_todo_read
    from ..runtime.time import now_utc

    require_no_legacy_todo_events(goal or {}, state_path=state_path)
    facts = prepare_todo_source_text(goal, state_text, state_path, todo_id=todo_id, retained=include_retained)
    now = now_utc()
    projected = project_todo_read({"kind": "source_fields", **facts,
        "rollout_events": list(rollout_events), "rollout_event_source": getattr(rollout_events, "source", None),
        "observed_at": now.timestamp(), "evaluated_at": now.isoformat(),
        "projection_query": {"roles": roles, "status": normalize_todo_status(status),
            "todo_id": normalize_todo_id(todo_id) if todo_id else None,
            "agent_id": normalize_todo_claimed_by(agent_id) if agent_id else None,
            "limit": limit, "source_name": "markdown_active_state"}})["projection"]
    return GoalTodoSummaries(**projected)


def todo_summaries_from_fields(
    *,
    fields: dict[str, Any],
    source: str,
    rollout_events: list[dict[str, Any]],
    roles: list[str],
    status: str | None,
    todo_id: str | None,
    agent_id: str | None,
    limit: int | None,
) -> GoalTodoSummaries:
    from .read_projection import project_todo_read
    from ..runtime.time import now_utc

    now = now_utc()
    result = project_todo_read({"kind": "select", "fields": fields,
        "field_evaluations": {f"{item_role}_todos": [getattr(item, "succession_evaluation", None)
            for item in (fields.get(f"{item_role}_todos") or {}).get("items") or []] for item_role in roles},
        "roles": roles, "status": normalize_todo_status(status),
        "todo_id": normalize_todo_id(todo_id) if todo_id else None,
        "agent_id": normalize_todo_claimed_by(agent_id) if agent_id else None,
        "limit": limit, "source_name": source,
        "observed_at": now.timestamp(), "evaluated_at": now.isoformat()})["projection"]
    return GoalTodoSummaries(**result)


def retained_todo_summary_fields(
    items: list[dict[str, Any]],
    *,
    rollout_events: list[dict[str, Any]],
) -> dict[str, Any]:
    from .read_projection import source_todo_fields

    return source_todo_fields([
        {"role": role, "source_section": TODO_SECTION_HEADINGS[role],
         "items": [item for item in items if item.get("role") == role],
         "include_empty_source": True, "text_limit": None, "include_content_revision": False}
        for role in ("user", "agent")], lineage=items, rollout_events=rollout_events)


def exact_archived_todo_summaries(
    *,
    archived_items: list[dict[str, Any]],
    source: str,
    rollout_events: list[dict[str, Any]],
    roles: list[str],
    status: str | None,
    todo_id: str,
    agent_id: str | None,
    limit: int | None,
) -> GoalTodoSummaries | None:
    from .read_projection import project_todo_read, prepare_todo_source_groups, legacy_lineage_facts
    from ..runtime.time import now_utc

    lineage, facts = legacy_lineage_facts(archived_items)
    groups = [{"role": role, "source_section": "Completed Work Archive", "include_empty_source": True,
        "items": [row for row in archived_items if row.get("role") == role]} for role in ("user", "agent")]
    now = now_utc()
    projected = project_todo_read({"kind": "source_fields", "groups": prepare_todo_source_groups(groups, lineage=archived_items),
        "lineage": lineage, "lineage_facts": facts, "rollout_events": list(rollout_events),
        "rollout_event_source": getattr(rollout_events, "source", None),
        "observed_at": now.timestamp(), "evaluated_at": now.isoformat(),
        "projection_query": {"exact_archive": True, "roles": roles, "status": normalize_todo_status(status),
            "todo_id": normalize_todo_id(todo_id), "agent_id": normalize_todo_claimed_by(agent_id) if agent_id else None,
            "limit": limit, "source_name": source}})["projection"]
    return GoalTodoSummaries(**projected) if projected is not None else None

def project_goal_todo_items(
    goal: dict[str, Any] | None,
    *,
    state_text: str,
    state_path: Path,
    rollout_events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Every user and agent todo item projected from one active-state text.

    Same items ``list_goal_todos`` returns without filters, computed from the
    caller's text instead of the file so it can run inside the writer's lock.
    """

    return goal_todo_summaries(
        goal,
        state_text=state_text,
        state_path=state_path,
        rollout_events=rollout_events,
        roles=["user", "agent"],
        status=None,
        todo_id=None,
        agent_id=None,
        limit=None,
    ).todos


__all__ = [
    "GoalTodoSummaries",
    "empty_todo_summary",
    "exact_archived_todo_summaries",
    "filtered_todo_summary",
    "goal_todo_summaries",
    "project_goal_todo_items",
    "summary_items",
    "todo_summaries_from_fields",
]
