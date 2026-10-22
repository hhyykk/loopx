"""Source selection is cohort-wide, explicit, and independent of installed SForge."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
import subprocess
import sys

import pytest

from benchmark.edgebench import source


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


@pytest.fixture
def repository(tmp_path, monkeypatch):
    repo = tmp_path / "remote"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "integration")
    git(repo, "config", "user.name", "Fixture")
    git(repo, "config", "user.email", "fixture@example.invalid")
    # Synthetic provider: the serve CLI identifies the imported source, without Docker.
    (repo / "sforge").mkdir()
    (repo / "sforge/__init__.py").write_text("MARKER = 'shared-source'\n")
    (repo / "sforge/cli.py").write_text(
        "def main():\n"
        " import json, sys, sforge\n"
        " from benchmark.edgebench.source import active_source_receipt\n"
        " print(json.dumps({'marker':sforge.MARKER,'source':active_source_receipt(),'args':sys.argv[1:]}))\n")
    (repo / ".gitignore").write_text("__pycache__/\n")
    git(repo, "add", ".")
    git(repo, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "synthetic source")
    defaults = tmp_path / "defaults.json"
    defaults.write_text(json.dumps({"repository": str(repo), "ref": "refs/heads/integration"}))
    monkeypatch.setattr(source, "DEFAULT_FILE", defaults)
    return repo


def test_default_freezes_cohort_while_new_cohort_sees_branch_advance(repository, tmp_path):
    first = git(repository, "rev-parse", "HEAD")
    checkout, receipt = source.prepare_source(tmp_path / "old")
    assert receipt["commit"] == first
    assert (checkout / "sforge/__init__.py").read_text() == "MARKER = 'shared-source'\n"
    (repository / "new.txt").write_text("second revision")
    git(repository, "add", "new.txt")
    git(repository, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "advance")
    second = git(repository, "rev-parse", "HEAD")
    assert source.prepare_source(tmp_path / "old")[1] == receipt
    assert source.prepare_source(tmp_path / "new")[1]["commit"] == second != first


def test_frozen_cohort_reuses_source_without_network(repository, tmp_path, monkeypatch):
    expected = source.prepare_source(tmp_path / "logs")[1]
    original = source._git

    def offline(checkout, *args):
        assert args[0] not in {"fetch", "clone", "ls-remote"}
        return original(checkout, *args)

    monkeypatch.setattr(source, "_git", offline)
    assert source.prepare_source(tmp_path / "logs")[1] == expected


def test_parallel_worker_and_judge_share_one_source(repository, tmp_path):
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: source.prepare_source(tmp_path / "logs")[1], range(4)))
    assert all(result == results[0] for result in results)


def test_explicit_pin_overrides_default_but_cannot_change_existing_cohort(repository, tmp_path):
    revision = git(repository, "rev-parse", "HEAD")
    log = tmp_path / "logs"
    _, receipt = source.prepare_source(log, repository=str(repository), revision=revision)
    assert receipt["ref"] == receipt["commit"] == revision
    with pytest.raises(ValueError, match="conflicts"):
        source.prepare_source(log, revision="f" * 40)
    with pytest.raises(ValueError, match="conflicts"):
        source.prepare_source(log, repository="https://example.invalid/other.git", ref=revision)
    assert source.prepare_source(log)[1] == receipt


@pytest.mark.parametrize("change", ["tracked", "untracked", "head", "receipt", "repository", "receipt_type"])
def test_source_drift_rejected(repository, tmp_path, change):
    checkout, _ = source.prepare_source(tmp_path / "logs")
    if change == "tracked":
        (checkout / "sforge/__init__.py").write_text("MARKER='changed'\n")
    elif change == "untracked":
        (checkout / "sforge/injected.py").write_text("injected=True\n")
    elif change == "head":
        git(checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
            "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "changed head")
    else:
        path = checkout.parent / "receipt.json"
        receipt = json.loads(path.read_text())
        if change == "receipt_type":
            receipt = []
        elif change == "repository":
            receipt["repository"] = "https://example.invalid/different.git"
        else:
            receipt["commit"] = "not-a-sha"
        path.write_text(json.dumps(receipt))
    with pytest.raises(ValueError):
        source.prepare_source(tmp_path / "logs")


def test_legacy_runs_cannot_be_silently_relabelled(repository, tmp_path):
    (tmp_path / "logs/runs/existing").mkdir(parents=True)
    with pytest.raises(ValueError, match="Existing runs"):
        source.prepare_source(tmp_path / "logs")
    assert not (tmp_path / "logs" / source.STATE_DIR).exists()


def test_failed_fetch_leaves_no_source_receipt_and_can_retry(repository, tmp_path):
    with pytest.raises(RuntimeError, match="fetch failed"):
        source.prepare_source(tmp_path / "logs", ref="refs/heads/missing")
    assert not (tmp_path / "logs" / source.STATE_DIR).exists()
    assert source.prepare_source(tmp_path / "logs")[1]["commit"] == git(repository, "rev-parse", "HEAD")


def test_real_serve_entry_loads_selected_provider_over_ambient_pythonpath(repository, tmp_path):
    shadow = tmp_path / "ambient/sforge"
    shadow.mkdir(parents=True)
    (shadow / "__init__.py").write_text("raise AssertionError('wrong installed provider')\n")
    env = {**os.environ, "PYTHONPATH": str(shadow.parent)}
    env.pop(source.RECEIPT_ENV, None)
    cmd = [sys.executable, "-m", "benchmark.edgebench.serve", "--log-dir", str(tmp_path / "logs"),
           "--sforge-repository", str(repository), "--sforge-ref", "refs/heads/integration", "--port", "8088"]
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, check=True)
    observed = json.loads(result.stdout)
    assert observed["marker"] == "shared-source"
    assert observed["source"]["commit"] == git(repository, "rev-parse", "HEAD")
    assert observed["args"] == ["serve", "--port", "8088"]


def test_imported_wrong_provider_rejected(repository, tmp_path, monkeypatch):
    checkout, _ = source.prepare_source(tmp_path / "logs")
    monkeypatch.setenv(source.RECEIPT_ENV, str(checkout.parent / "receipt.json"))
    from types import SimpleNamespace
    monkeypatch.setattr(source.importlib.util, "find_spec", lambda _: SimpleNamespace(origin="unrelated.py"))
    with pytest.raises(ValueError, match="Imported SForge differs"):
        source.active_source_receipt()


def test_annotated_tag_resolves_to_commit(repository, tmp_path):
    git(repository, "tag", "-a", "release", "-m", "synthetic release")
    _, receipt = source.prepare_source(tmp_path / "logs", ref="refs/tags/release")
    assert receipt["commit"] == git(repository, "rev-parse", "HEAD")


@pytest.mark.parametrize("selection", [
    {"ref": "--upload-pack=unexpected"}, {"ref": ""}, {"revision": "short"},
    {"ref": "main", "revision": "f" * 40}, {"repository": "https://example.invalid/repo"},
])
def test_invalid_selection_rejected_before_creating_cohort(tmp_path, selection):
    with pytest.raises(ValueError):
        source.prepare_source(tmp_path / "logs", **selection)
    assert not (tmp_path / "logs").exists()


def test_transport_timeout_omits_command_and_credentials(tmp_path, monkeypatch):
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(["git", "https://user:secret@example.invalid/repo"], 180)

    monkeypatch.setattr(source.subprocess, "run", timeout)
    with pytest.raises(RuntimeError, match="^EdgeBench git fetch timed out$"):
        source._git(tmp_path, "fetch", "origin", "main")


def test_prepare_help_does_not_need_provider_or_create_source(tmp_path):
    result = subprocess.run(
        [sys.executable, "-m", "benchmark.edgebench.source", "--help", "--log-dir", str(tmp_path / "logs")],
        capture_output=True, text=True, check=True,
    )
    assert "--sforge-revision" in result.stdout
    assert "null" not in result.stdout
    assert not (tmp_path / "logs").exists()
