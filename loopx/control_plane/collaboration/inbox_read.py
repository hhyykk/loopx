"""Transport for the native Inbox owner; callers retain their Goal lifetime fence."""
from pathlib import Path

from ..effect_runtime import (
    EffectRuntimeIOError,
    EffectRuntimeRejected,
    effect_runtime_result,
)


def read_inbox_transaction(root: Path, request: dict, *, scope=None) -> dict:
    from .inbox import _now

    facts = {
        "runtime_root": str(Path(root).resolve()),
        "scope": {
            "profile_id": scope.profile_id if scope is not None else None,
            "caller_goal_ref": scope.caller_goal_ref if scope is not None else None,
            "current_goal_ref": scope.current_goal_ref if scope is not None else None,
        },
        "observed_at": _now(),
        **request,
    }
    if request.get("operation") == "record_read":
        facts["items"] = [{key: item[key] for key in (
            "goal_id", "agent_id", "goal_ref", "request_id", "request_revision", "request_revision_digest",
        ) if key in item} for item in request["items"]]
    # Full source pages may exceed the ordinary wire even when every record is legal.
    snapshot = request["operation"] in {"pending", "turn_start", "receiver_read", "returns"}
    snapshot = snapshot or len(request.get("rows", [])) > 1
    try:
        result = effect_runtime_result("collaboration.inbox.read", facts, large_local_snapshot=snapshot)
    except EffectRuntimeRejected as exc:
        raise ValueError(str(exc)) from exc
    except EffectRuntimeIOError as exc:
        # The native owner reports filesystem failures as typed runtime errors.
        # Callers and the CLI still classify them as IO failures; keep the
        # retryable/permanent diagnostic instead of leaking a runtime traceback.
        raise OSError(f"{exc.diagnostic_code}: {exc}") from exc
    if not isinstance(result, dict):
        raise RuntimeError("native Inbox read must return an object")
    return result
