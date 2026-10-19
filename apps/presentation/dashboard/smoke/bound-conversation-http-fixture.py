"""Packaged UI against real Chat/Core; only provider identity/model are synthetic.

Everything lives in a disposable SQLite runtime. No personal App, source, Goal,
credentials or model account is read or contacted. Stdin controls source events.
"""
from __future__ import annotations

import json
from pathlib import Path
import runpy
import socket
import sys
import tempfile
import threading

import pytest

REPO = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(REPO), str(REPO / "tests/control_plane")]
from canonical_authority_fixture import isolate_sqlite_runtime, promoted_create_fixture
from loopx.chat_server import serve_chat


class SyntheticPrivateSource:
    transport_ref = "synthetic-private"
    cancelled = staticmethod(lambda: False)

    def __init__(self, root):
        self.root, self.verified = root, True

    def observe(self):
        return {"transport_ref": self.transport_ref, "provider_ref": "c" * 24,
                "operator_ref": "d" * 24, "verified": self.verified}

    def health_snapshot(self):
        return {"status": "listening"}

    def close(self):
        pass

    def start(self, server):
        runtime = server.runtime_controller
        runtime.codex_home = self.root / "synthetic-model-home"
        runtime.codex_home.mkdir(exist_ok=True)
        bindings = runtime.project_contexts.conversation_bindings
        binding = bindings.configure(transport_ref=self.transport_ref,
            project_ref=runtime.project_contexts.available()[0]["project_ref"],
            executor_endpoint_id="codex", context_kind="project", project_grant="workspace_read")
        source = {"source_ref": "a" * 24, "sender_ref": "d" * 24, "private_human_message": True}
        original, _ = runtime.open_session(goal_id=None, agent_id="codex", objective="",
            work_dir=self.root / "project", mode="resume_latest",
            conversation_binding_id=binding["binding_id"], source_context=source)
        sid = original["session_id"]
        server.chat_store.append_message(sid, role="user", text="Synthetic private conversation: review the research notes.")
        server.chat_store.append_message(sid, role="agent", text="The original conversation and its research notes are ready.")
        other, _ = runtime.open_session(goal_id=None, agent_id="codex", objective="", mode="new",
            work_dir=self.root / "project", project_ref=binding["project_ref"])
        server.chat_store.append_message(other["session_id"], role="agent", text="Unrelated desktop conversation — must remain separate.")
        print(json.dumps({"origin": f"http://127.0.0.1:{server.server_port}",
            "bindingId": binding["binding_id"], "sessionId": sid, "ordinarySessionId": other["session_id"]}), flush=True)

        def control():
            for line in sys.stdin:
                command = line.strip()
                if command in {"deny", "recover"}:
                    self.verified = command == "recover"
                    result = {"source_verified": self.verified}
                elif command == "source":
                    accepted, _ = runtime.enqueue_turn(session_id=sid, message="A new synthetic message from the original private source.",
                        client_turn_id="synthetic-source-update", origin="lark", work_dir=self.root / "project", objective="")
                    turn = runtime.wait_for_turn(session_id=sid, turn_id=accepted["turn_id"], timeout_sec=15)
                    result = {"source_turn_status": turn["status"]}
                elif command == "close":
                    server.chat_store.update_session(sid, status="closed")
                    result = {"closed": True}
                elif command == "inspect":
                    saved = server.chat_store.load_session(sid)
                    result = {"sessions": len(server.chat_store.list_sessions()), "original_thread": saved["upstream_thread_id"],
                              "messages": server.chat_store.messages(sid)}
                elif command == "stop":
                    server.shutdown()
                    return
                else:
                    result = {"unknown_command": command}
                print(json.dumps(result), flush=True)
        threading.Thread(target=control, daemon=True).start()


def main():
    with tempfile.TemporaryDirectory(prefix="loopx-bound-ui-") as directory, pytest.MonkeyPatch.context() as patch:
        root = Path(directory)
        isolate_sqlite_runtime(root, patch)
        patch.setenv("CODEX_HOME", str(root / "synthetic-model-home"))
        registry, _, _ = promoted_create_fixture(root, provider="sqlite")
        fake = root / "synthetic-codex"
        fake.write_text(runpy.run_path(str(REPO / "examples/loopx-chat-runtime-smoke.py"))["FAKE_CODEX"])
        fake.chmod(0o700)
        source = SyntheticPrivateSource(root)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        serve_chat(registry_path=registry, runtime_root_override=root / "runtime", scan_roots=[root / "project"],
            codex_bin=str(fake), lark_cli_bin="missing-synthetic-lark", port=port,
            external_conversation_factories=(lambda _: source,))


if __name__ == "__main__":
    main()
