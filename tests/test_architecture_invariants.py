from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from loopx.bootstrap import bootstrap_project, build_goal_entry, render_state_markdown
from loopx.contract import check_contract
from loopx.control_plane.goals.architecture_invariants import (
    discover_top_level_specs,
    parse_architecture_invariants,
    verify_authority_source_digests,
    verify_executable_architecture_invariants,
)


def test_parse_and_discover_top_level_specs(tmp_path: Path) -> None:
    arch = tmp_path / "architecture.md"
    arch.write_text(
        """# Architecture

## Repo-Wide Invariants
- Keep presentation separate from persistence.
- `forbid_import: api/** -> db` — API must not import DB
- `forbid_pattern: api/** :: \\bexecute_raw_sql\\(` # No raw SQL
- `must_exist: services/audit.py` — Audit module required
""",
        encoding="utf-8",
    )
    req = tmp_path / "goal-and-requirements.md"
    req.write_text("# Goal and Requirements\n\n## Goal\nFast and safe.\n", encoding="utf-8")

    rules, principles = parse_architecture_invariants(arch.read_text(encoding="utf-8"))
    assert len(rules) == 3
    assert principles == ["Keep presentation separate from persistence."]

    specs = discover_top_level_specs(tmp_path)
    assert len(specs) == 2
    assert specs[0]["kind"] == "architecture_spec"
    assert specs[0]["path"] == "architecture.md"
    assert len(specs[0]["invariants"]) == 3
    assert specs[1]["kind"] == "requirements_spec"


def test_evaluate_goal_architecture_invariants_catches_violations_and_tampering(
    tmp_path: Path,
) -> None:
    (tmp_path / "api").mkdir()
    (tmp_path / "services").mkdir()
    (tmp_path / "db").mkdir()

    (tmp_path / "architecture.md").write_text(
        """# Architecture

## Repo-Wide Invariants
- `forbid_import: api/** -> db`
- `must_exist: services/audit.py`
""",
        encoding="utf-8",
    )
    (tmp_path / "services" / "audit.py").write_text("def audit(): pass\n", encoding="utf-8")
    (tmp_path / "api" / "handler.py").write_text("def handle(): return 200\n", encoding="utf-8")

    goal_entry = build_goal_entry(
        project=tmp_path,
        goal_id="test-goal",
        domain="backend",
        role="primary",
        parent_goal_id=None,
        state_file=tmp_path / ".loopx" / "ACTIVE_GOAL_STATE.md",
        goal_doc=None,
        adapter_kind="read_only_project_map_v0",
        adapter_status="connected-read-only",
        next_probe=None,
        spawn_allowed=False,
        max_children=0,
        allowed_domains=[],
        write_scope=[],
        execution_profile=None,
    )
    state_md = render_state_markdown(
        project=tmp_path,
        goal_id="test-goal",
        adapter_kind="read_only_project_map_v0",
        objective="Test objective",
        updated_at="2026-10-25T21:00:00+08:00",
        goal_doc=None,
        execution_profile=None,
    )
    assert "## Repo-Wide Architecture Invariants" in state_md

    # 1. Compliant state passes cleanly
    diags, checks = _verify(goal_entry)
    assert diags == []
    assert len(checks) == 2

    # 2. Introduce forbidden import and delete required file
    (tmp_path / "api" / "handler.py").write_text("import db.conn\n", encoding="utf-8")
    (tmp_path / "services" / "audit.py").unlink()
    diags, _ = _verify(goal_entry)
    codes = [d["code"] for d in diags]
    assert codes == ["architecture_invariant_violation", "architecture_invariant_violation"]

    # 3. Unapproved mutation of architecture.md is caught even if rules are erased
    (tmp_path / "architecture.md").write_text("# Architecture\n", encoding="utf-8")
    diags_tamper, _ = _verify(goal_entry)
    assert any(d["code"] == "authority_source_digest_mismatch" for d in diags_tamper)
    assert sum(1 for d in diags_tamper if d["code"] == "architecture_invariant_violation") == 2

    # 4. Prose cannot approve a lock change. A reviewed registry update can.
    (tmp_path / "services" / "audit.py").write_text("def audit(): pass\n", encoding="utf-8")
    (tmp_path / "api" / "handler.py").write_text("def handle(): return 200\n", encoding="utf-8")
    new_sha = hashlib.sha256((tmp_path / "architecture.md").read_bytes()).hexdigest()
    (tmp_path / ".loopx").mkdir()
    (tmp_path / ".loopx" / "ACTIVE_GOAL_STATE.md").write_text(
        state_md + f"\n- [x] USER-GATE-1 (`approved_architecture_digest: {new_sha}`)\n",
        encoding="utf-8",
    )
    assert verify_authority_source_digests(goal_entry)[0]
    goal_entry["authority_sources"][0]["sha256"] = new_sha
    assert _verify(goal_entry)[0] == []


def _verify(goal):
    digest_diags, digest_checks = verify_authority_source_digests(goal)
    code_diags, code_checks = verify_executable_architecture_invariants(goal)
    return digest_diags + code_diags, digest_checks + code_checks


@pytest.fixture
def bootstrapped(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "architecture.md").write_text(
        "## Repo-Wide Invariants\n- `must_exist: required.txt`\n", encoding="utf-8"
    )
    (project / "goal-and-requirements.md").write_text("# Requirements\n", encoding="utf-8")
    (project / "intent.md").write_text("# Explicit goal\n", encoding="utf-8")
    runtime = tmp_path / "runtime"
    registry = project / ".loopx" / "registry.json"
    bootstrap_project(
        project=project, registry_path=registry, runtime_root=runtime,
        goal_id="digest-test", objective="Preserve accepted sources", domain="research",
        role="primary", parent_goal_id=None, state_file=None, goal_doc=Path("intent.md"),
        adapter_kind="read_only_project_map_v0", adapter_status="connected-read-only",
        next_probe=None, spawn_allowed=False, max_children=0, allowed_domains=[],
        write_scope=[], force=False, dry_run=False, sync_global=False,
    )
    return project, registry, runtime


def test_bootstrap_explicit_goal_doc_and_discovered_sources_have_digests(bootstrapped):
    project, registry, _ = bootstrapped
    goal = json.loads(registry.read_text())["goals"][0]
    assert {s["path"] for s in goal["authority_sources"]} == {
        "intent.md", "architecture.md", "goal-and-requirements.md"
    }
    for source in goal["authority_sources"]:
        assert source["sha256"] == hashlib.sha256((project / source["path"]).read_bytes()).hexdigest()
    assert verify_authority_source_digests(goal)[0] == []


@pytest.mark.parametrize("include_probe", [False, True])
def test_contract_toggle_preserves_digest_lock(bootstrapped, include_probe, monkeypatch):
    project, registry, runtime = bootstrapped
    if not include_probe:
        def unexpected_probe(_goal):
            raise AssertionError("disabled executable scanning must not run")

        monkeypatch.setattr("loopx.contract.verify_executable_architecture_invariants", unexpected_probe)

    def check():
        return check_contract(
            registry_path=registry, runtime_root_override=str(runtime), scan_roots=[],
            limit=20, include_architecture_invariants=include_probe,
            include_public_boundary_scan=False,
        )

    initial = check()
    codes = {d["code"] for d in initial["error_diagnostics"]}
    assert ("architecture_invariant_violation" in codes) == include_probe
    assert initial["ok"] == (not include_probe), initial["errors"]
    (project / "required.txt").write_text("present", encoding="utf-8")
    assert check()["ok"]
    (project / "intent.md").write_text("changed", encoding="utf-8")
    assert "authority_source_digest_mismatch" in {
        d["code"] for d in check()["error_diagnostics"]
    }
    (project / "intent.md").unlink()
    assert "authority_source_missing" in {
        d["code"] for d in check()["error_diagnostics"]
    }


def test_legacy_unhashed_authority_is_unchanged(tmp_path):
    goal = {"id": "legacy", "repo": str(tmp_path), "authority_sources": [
        {"kind": "document", "path": "missing.md"}
    ]}
    assert verify_authority_source_digests(goal) == ([], [])
    assert verify_executable_architecture_invariants(goal) == ([], [])


def test_immutable_snapshot_and_pattern_rules(tmp_path):
    (tmp_path / "fixed.txt").write_text("stable", encoding="utf-8")
    (tmp_path / "code.py").write_text("safe = True\n", encoding="utf-8")
    spec = tmp_path / "architecture.md"
    spec.write_text(
        "## Invariants\n- `immutable_path: fixed.txt`\n"
        "- `forbid_pattern: *.py :: UNSAFE`\n", encoding="utf-8"
    )
    goal = {"id": "rules", "repo": str(tmp_path),
            "authority_sources": discover_top_level_specs(tmp_path)}
    assert verify_executable_architecture_invariants(goal)[0] == []
    (tmp_path / "fixed.txt").write_text("changed", encoding="utf-8")
    (tmp_path / "code.py").write_text("UNSAFE = True\n", encoding="utf-8")
    assert len(verify_executable_architecture_invariants(goal)[0]) == 2
    spec.unlink()
    # A deleted spec cannot erase its locked executable rules.
    assert len(verify_executable_architecture_invariants(goal)[0]) == 2
    assert verify_authority_source_digests(goal)[0][0]["code"] == "authority_source_missing"


@pytest.mark.parametrize("rule", [
    {"kind": "forbid_pattern", "source_glob": "*.py", "target": "["},
    {"kind": "must_exist", "source_glob": "../outside.txt"},
    {"kind": "immutable_path", "source_glob": "missing.txt"},
])
def test_invalid_rules_fail_closed(tmp_path, rule):
    goal = {"id": "invalid", "repo": str(tmp_path), "authority_sources": [
        {"path": "architecture.md", "invariants": [rule]}
    ]}
    assert verify_executable_architecture_invariants(goal)[0]


@pytest.mark.parametrize("filename", ["architecture.md", "goal-and-requirements.md"])
def test_docs_discovery_locks_documents_without_executable_rules(tmp_path, filename):
    docs = tmp_path / "docs"
    docs.mkdir()
    source = docs / filename
    source.write_text("# Accepted document\n", encoding="utf-8")
    entries = discover_top_level_specs(tmp_path)
    assert len(entries) == 1
    assert entries[0]["path"] == f"docs/{filename}"
    assert entries[0]["sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()


def test_bootstrap_nonexistent_goal_doc_preserves_unhashed_authority(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    registry = project / ".loopx" / "registry.json"
    result = bootstrap_project(
        project=project, registry_path=registry, runtime_root=tmp_path / "runtime",
        goal_id="future-document", objective="Prepare a future goal document", domain="research",
        role="primary", parent_goal_id=None, state_file=None, goal_doc=Path("future.md"),
        adapter_kind="read_only_project_map_v0", adapter_status="connected-read-only",
        next_probe=None, spawn_allowed=False, max_children=0, allowed_domains=[],
        write_scope=[], force=False, dry_run=False, sync_global=False,
    )
    assert result["ok"] is True
    assert result["goal_doc_exists"] is False
    assert not (project / "future.md").exists()
    goal = json.loads(registry.read_text(encoding="utf-8"))["goals"][0]
    assert goal["authority_sources"] == [{
        "kind": "goal_doc", "path": "future.md", "role": "primary_goal_document",
    }]
    assert verify_authority_source_digests(goal) == ([], [])
