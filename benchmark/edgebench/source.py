"""Experiment-local SForge selection, before importing the native provider.

This research adapter owns a dependency choice, not scoring or LoopX policy.
One atomic source directory freezes the worker/judge cohort's revision.
"""
from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

DEFAULT_FILE = Path(__file__).with_name("source-default.json")
STATE_DIR = ".edgebench-source"
RECEIPT_ENV = "LOOPX_EDGEBENCH_SOURCE_RECEIPT"


def _git(checkout: Path, *args: str) -> str:
    try:
        result = subprocess.run(["git", "-C", str(checkout), *args],
                                capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"EdgeBench git {args[0]} timed out") from None
    if result.returncode:
        # A transport error can contain a credential-bearing remote URL.
        raise RuntimeError(f"EdgeBench git {args[0]} failed (exit {result.returncode})")
    return result.stdout.strip()


def _validate(state: Path) -> dict:
    receipt = json.loads((state / "receipt.json").read_text())
    if (not isinstance(receipt, dict)
            or receipt.get("schema_version") != "edgebench_source_v1"
            or not isinstance(receipt.get("commit"), str)
            or not re.fullmatch(r"[0-9a-f]{40}", receipt["commit"])
            or not all(isinstance(receipt.get(k), str) and receipt[k]
                       for k in ("repository", "ref"))):
        raise ValueError("Invalid EdgeBench source receipt; preserve it and use a new log directory")
    checkout = state / "checkout"
    if (_git(checkout, "rev-parse", "HEAD") != receipt["commit"]
            or _git(checkout, "remote", "get-url", "origin") != receipt["repository"]
            or _git(checkout, "status", "--porcelain", "--untracked-files=normal")):
        raise ValueError("Frozen EdgeBench source changed; restore it or use a new log directory")
    if not (checkout / "sforge/__init__.py").is_file():
        raise ValueError("Selected source does not contain the SForge package")
    return receipt


def prepare_source(log_dir: Path, *, repository: str | None = None,
                   ref: str | None = None, revision: str | None = None) -> tuple[Path, dict]:
    """Resolve once; an existing cohort can be reused offline, never refreshed."""
    if revision is not None and not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("--sforge-revision requires a full lowercase commit SHA")
    if ref is not None and revision is not None:
        raise ValueError("Select either --sforge-ref or --sforge-revision")
    if ref is not None and (not ref or ref.startswith("-")):
        raise ValueError("--sforge-ref must be a nonempty Git reference")
    if repository is not None and ref is None and revision is None:
        raise ValueError("An alternate repository requires --sforge-ref or --sforge-revision")
    log_dir = log_dir.resolve()
    log_dir.mkdir(parents=True, exist_ok=True)
    state = log_dir / STATE_DIR
    with (log_dir / f"{STATE_DIR}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if state.exists():
            receipt = _validate(state)
            for key, requested in (("repository", repository), ("ref", ref), ("commit", revision)):
                if requested is not None and receipt[key] != requested:
                    raise ValueError("EdgeBench selection conflicts with this cohort; use a new log directory")
            return state / "checkout", receipt
        if (log_dir / "runs").exists() and any((log_dir / "runs").iterdir()):
            raise ValueError("Existing runs have no source lock; preserve them and use a new log directory")
        defaults = json.loads(DEFAULT_FILE.read_text())
        repository = repository or defaults["repository"]
        ref = ref or (revision if revision else defaults["ref"])
        with tempfile.TemporaryDirectory(prefix=".edgebench-source-", dir=log_dir) as temporary:
            staged = Path(temporary) / "source"
            checkout = staged / "checkout"
            checkout.mkdir(parents=True)
            _git(checkout, "init", "--quiet")
            _git(checkout, "remote", "add", "origin", repository)
            _git(checkout, "fetch", "--quiet", "--depth=1", "--", "origin", revision or ref)
            commit = _git(checkout, "rev-parse", "FETCH_HEAD^{commit}")
            if revision is not None and commit != revision:
                raise ValueError("Fetched EdgeBench commit differs from the requested revision")
            _git(checkout, "checkout", "--quiet", "--detach", commit)
            receipt = dict(schema_version="edgebench_source_v1", repository=repository,
                           ref=ref, commit=commit)
            (staged / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            _validate(staged)
            staged.rename(state)
        return state / "checkout", receipt


def bootstrap(*, keep_log_arg: bool = True) -> None:
    """CLI-only bootstrap; imported Python APIs retain their explicit environment."""
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False,
        description="Select and freeze the shared EdgeBench source for a log directory.")
    parser.add_argument("--log-dir", type=Path, default=os.environ.get("SFORGE_LOG_DIR"))
    parser.add_argument("--sforge-repository")
    parser.add_argument("--sforge-ref")
    parser.add_argument("--sforge-revision")
    if "--help" in sys.argv[1:] or "-h" in sys.argv[1:]:
        parser.print_help()
        return
    args, remaining = parser.parse_known_args()
    if args.log_dir is None:
        parser.error("provide --log-dir or SFORGE_LOG_DIR to freeze the EdgeBench source")
    try:
        checkout, _ = prepare_source(args.log_dir, repository=args.sforge_repository,
                                     ref=args.sforge_ref, revision=args.sforge_revision)
    except (OSError, ValueError, RuntimeError) as error:
        parser.error(str(error))
    sys.path.insert(0, str(checkout))
    os.environ["PYTHONPATH"] = os.pathsep.join(filter(None, (str(checkout), os.environ.get("PYTHONPATH"))))
    os.environ["SFORGE_LOG_DIR"] = str(args.log_dir.resolve())
    os.environ[RECEIPT_ENV] = str(checkout.parent / "receipt.json")
    sys.argv[1:] = remaining + (["--log-dir", str(args.log_dir)] if keep_log_arg else [])
    active_source_receipt()


def active_source_receipt() -> dict | None:
    """Prove the module Python will load belongs to the frozen source."""
    path = os.environ.get(RECEIPT_ENV)
    if not path:
        return None  # Legacy imported API: the embedding caller owns its source.
    state = Path(path).resolve().parent
    receipt = _validate(state)
    spec = importlib.util.find_spec("sforge")
    if spec is None or not spec.origin or Path(spec.origin).resolve() != state / "checkout/sforge/__init__.py":
        raise ValueError("Imported SForge differs from the experiment's source receipt")
    return receipt


if __name__ == "__main__":
    # Prepare dependencies without launching a worker, judge or model call.
    bootstrap(keep_log_arg=False)
    if "--help" not in sys.argv[1:] and "-h" not in sys.argv[1:]:
        print(json.dumps(active_source_receipt(), indent=2))
