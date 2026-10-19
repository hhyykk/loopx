"""Source codecs and transport for the native full-source Todo read owner."""
from __future__ import annotations

from typing import Any


def project_todo_read(params: dict[str, Any]) -> dict[str, Any]:
    from ..effect_runtime import EffectRuntimeRejected, effect_runtime_result

    import base64
    import hashlib
    import json
    import os
    import tempfile
    from contextlib import ExitStack
    from pathlib import Path
    from ..effect_runtime import MAX_LOCAL_SNAPSHOT_BYTES

    request = {"schema_version": "todo_read_request_v0", **params}
    encoded = json.dumps(request, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    chunks = []
    identity = None
    try:
        with ExitStack() as stack:
            if len(encoded) > MAX_LOCAL_SNAPSHOT_BYTES - 4096:
                directory = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="loopx-effect-todo-")))
                source = directory / "facts.json"
                fd = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as file:
                    file.write(encoded)
                request = {"schema_version": "todo_read_request_v0", "facts_ref": {
                    "path": str(source), "byte_count": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest()}}
            consumed = 0
            while True:
                result = effect_runtime_result("todo.read", request, large_local_snapshot=True,
                    timeout=15.0 if params.get("kind") in {"query", "canonical_fields", "historical_fields"} else 10.0)
                if not isinstance(result, dict) or result.get("schema_version") != "todo_read_result_v0":
                    raise ValueError("invalid typed Todo read result")
                piece = result.get("result_piece")
                if piece is None:
                    if chunks and not (result.get("canonical") or result.get("rejection")):
                        raise ValueError("incomplete Todo read result")
                    break
                if not isinstance(piece, dict) or piece.get("offset") != consumed:
                    raise ValueError("invalid Todo read result page")
                current = (piece.get("sha256"), piece.get("byte_count"))
                if identity is None:
                    identity = current
                if identity != current or type(current[1]) is not int or current[1] <= consumed:
                    raise ValueError("Todo read result identity changed")
                block = base64.b64decode(piece["data"], validate=True)
                if not block:
                    raise ValueError("Todo read result page did not advance")
                chunks.append(block)
                consumed += len(block)
                if consumed > current[1]:
                    raise ValueError("Todo read result exceeds its declared population")
                after = piece.get("next")
                if after is None:
                    complete = b"".join(chunks)
                    if consumed != current[1] or hashlib.sha256(complete).hexdigest() != current[0]:
                        raise ValueError("Todo read result digest mismatch")
                    result = json.loads(complete)
                    break
                if not isinstance(after, dict) or after.get("offset") != consumed or after.get("sha256") != current[0]:
                    raise ValueError("invalid Todo read result continuation")
                request = {**request, "result_page": after}
    except EffectRuntimeRejected as exc:
        raise ValueError(str(exc)) from exc
    if not isinstance(result, dict) or result.get("schema_version") != "todo_read_result_v0":
        raise ValueError("invalid typed Todo read result")
    if result.get("rejection"):
        raise EffectRuntimeRejected(result["rejection"]["message"])
    if params.get("kind") == "group":
        summary = result.get("summary")
        if not isinstance(summary, dict) or summary.get("schema_version") != "todo_summary_v0":
            raise ValueError("invalid typed Todo summary fields")
        if params.get("role") == "agent":
            frontier = summary.get("advancement_frontier_revision_index")
            if not isinstance(frontier, dict) or frontier.get("schema_version") != "todo_frontier_revision_index_v0":
                raise ValueError("invalid typed Todo summary frontier index")
    return result


def restore_todo_field_evaluations(result):
    from .succession_warning import _EvaluatedTodo

    fields = result["fields"]
    for role, decisions in result["field_evaluations"].items():
        fields[role]["items"] = [_EvaluatedTodo(item, decision)
            for item, decision in zip(fields[role]["items"], decisions, strict=True)]
    return fields


def canonical_todo_fields(todos, *, rollout_events=None, **facts):
    from ..runtime.time import now_utc

    now = now_utc()
    if facts.get("available_capabilities") is not None:
        facts["available_capabilities"] = sorted({str(value).strip().lower()
            for value in facts["available_capabilities"] if str(value).strip()})
    return restore_todo_field_evaluations(project_todo_read({
        "kind": "fields", "todos": todos, **facts,
        "rollout_events": list(rollout_events or []),
        "rollout_event_source": getattr(rollout_events, "source", None),
        "observed_at": now.timestamp(), "evaluated_at": now.isoformat(),
    }))


def source_todo_fields(groups, *, lineage, rollout_events=None, available_capabilities=None,
                       preferred_todo_ids=None, item_limit=None, evaluated_at=None,
                       archived_items=None, standing_items=None, legacy_source_order=False,
                       vision_runs=None, include_task_orchestration_authority=False):
    from ..runtime.time import now_utc

    now = now_utc()
    prepared = prepare_todo_source_groups(groups, lineage=lineage)
    lineage_rows, lineage_facts = legacy_lineage_facts(lineage)
    result = project_todo_read({"kind": "source_fields", "groups": prepared,
        "lineage": lineage_rows, "lineage_facts": lineage_facts, "rollout_events": list(rollout_events or []),
        "rollout_event_source": getattr(rollout_events, "source", None),
        "available_capabilities": available_capabilities,
        "preferred_todo_ids": sorted(preferred_todo_ids or []), "item_limit": item_limit,
        "archived_items": archived_items, "standing_items": standing_items,
        "legacy_source_order": legacy_source_order,
        "include_full_source": bool(vision_runs),
        "include_task_orchestration_authority": include_task_orchestration_authority,
        "observed_at": now.timestamp(), "evaluated_at": evaluated_at or now.isoformat()})
    fields = restore_todo_field_evaluations(result)
    for role in ("user", "agent"):
        summary = fields.get(f"{role}_todos")
        if not summary:
            continue
        if include_task_orchestration_authority:
            from .todo_summary import _task_orchestration_authority
            summary["task_orchestration_authority"] = _task_orchestration_authority(
                result["source_orchestration"][role], role=role)
        if vision_runs:
            from .succession_warning import _EvaluatedTodo
            from ..goals.goal_vision_wait_projection import attach_active_vision_waits
            source = [_EvaluatedTodo(item, decision) for item, decision in zip(
                result["source_items"][role], result["source_evaluations"][role], strict=True)]
            attach_active_vision_waits(summary, vision_runs, role=role, items=source,
                lineage_items=lineage)
    return fields


def project_todo_read_group(items, *, source_section, role, preferred_todo_ids=None,
                            lineage=None, rollout_events=None, available_capabilities=None,
                            item_limit=None, evaluated_at=None, evaluated=False,
                            full_selection=True, selection=None, resume_lineage=None,
                            include_full_source=False, include_task_orchestration_authority=False):
    from .succession_warning import _EvaluatedTodo
    from ..runtime.time import now_utc

    now = now_utc()
    lineage_rows, lineage_facts = legacy_lineage_facts(lineage or [])
    result = project_todo_read({
        "kind": "group", "items": items, "lineage": lineage_rows, "lineage_facts": lineage_facts,
        "resume_lineage": resume_lineage,
        "evaluated": evaluated,
        "evaluations": [item.succession_evaluation if isinstance(item, _EvaluatedTodo) else None
            for item in items] if evaluated else None,
        "source_section": source_section, "role": role,
        "preferred_todo_ids": sorted(preferred_todo_ids or []),
        "rollout_events": list(rollout_events or []),
        "rollout_event_source": getattr(rollout_events, "source", None),
        "available_capabilities": sorted(available_capabilities) if available_capabilities is not None else None,
        "item_limit": item_limit, "evaluated_at": evaluated_at or now.isoformat(),
        "observed_at": now.timestamp(), "full_selection": full_selection,
        "selection": selection,
        "include_full_source": include_full_source,
        "include_task_orchestration_authority": include_task_orchestration_authority,
    })
    # The native owner validates this ephemeral evidence again on filtered reads.
    if "items" in result:
        result["items"] = [_EvaluatedTodo(item, decision)
            for item, decision in zip(result["items"], result["evaluations"], strict=True)]
    result["summary"]["items"] = [
        _EvaluatedTodo(item, decision) for item, decision in zip(
            result["summary"].get("items", []), result["visible_evaluations"], strict=True)
    ]
    return result


def prepare_todo_source_groups(groups, *, lineage):
    from .todo_summary import _structured_todo_group_items, _structured_resume_source_items
    from .resume_condition import build_todo_resume_evaluation_request

    prepared = []
    for group in groups:
        items = _structured_todo_group_items(group["items"], source_section=group["source_section"],
            role=group["role"], text_limit=group.get("text_limit", 500),
            include_content_revision=group.get("include_content_revision", True))
        prepared.append({**group, "items": items,
            "resume_lineage": build_todo_resume_evaluation_request([], source_items=_structured_resume_source_items(
                lineage, source_section=group["source_section"]))["source_items"]
                if any(item.get("resume_when") for item in items) else None})
    return prepared


def legacy_lineage_facts(items):
    from .succession_warning import succession_facts

    return ([{"todo_id": item.get("todo_id"), "role": item.get("role"), "source_section": item.get("source_section"),
              "archive_state": item.get("archive_state") or "active"} for item in items],
            [succession_facts(item) for item in items])


def prepare_todo_source_text(goal, state_text, state_path, *, todo_id=None, retained=False):
    from .active_state_todo_parser import parse_todo_source
    from .todo_summary import _structured_resume_source_items
    from .standing_decision import standing_decision_source_items
    from .active_state_editing import TODO_SECTION_HEADINGS
    from .contract import normalize_todo_id

    active, archived, sections = parse_todo_source(state_text, goal=goal, state_path=state_path)
    records = [*active["user"], *active["agent"], *archived]
    groups = [{"role": role, "source_section": TODO_SECTION_HEADINGS[role] if retained else sections[role],
        "items": [item for item in records if item.get("role") == role] if retained else active[role],
        "include_empty_source": retained or sections[role] is not None,
        "text_limit": None if retained else 500, "include_content_revision": not retained}
        for role in ("user", "agent")]
    archived_decisions = [item for item in archived if item.get("role") == "user"]
    archived_query = _structured_resume_source_items(archived, source_section="Completed Work Archive") if todo_id else []
    lineage = records if retained else [*active["user"], *active["agent"], *[item for item in archived if normalize_todo_id(item.get("todo_id"))]]
    lineage_rows, lineage_facts = legacy_lineage_facts(lineage)
    return {"groups": prepare_todo_source_groups(groups, lineage=records), "lineage": lineage_rows, "lineage_facts": lineage_facts,
        "archived_items": None if retained else archived,
        "standing_items": None if retained else standing_decision_source_items([*active["user"], *archived_decisions]),
        "legacy_source_order": not archived_decisions,
        "archived_items_for_query": archived_query,
        "full_bodies": [item for item in records if item.get("todo_id") == todo_id] if todo_id else [],
        "source_count": len(records)}
