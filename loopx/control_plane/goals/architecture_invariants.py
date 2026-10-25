from __future__ import annotations

import ast
import fnmatch
import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .contract_health import contract_error_diagnostic

INVARIANT_SECTION_PATTERN = re.compile(
    r"^##\s+(?:Repo-Wide\s+Invariants|Architecture\s+Invariants|Invariants)\s*$",
    re.IGNORECASE,
)
ANY_H2_PATTERN = re.compile(r"^##\s+\S")
FORBID_IMPORT_RULE_PATTERN = re.compile(
    r"^(?:-\s+|\*\s+)?`?forbid_import:\s*([^\s`]+)\s*->\s*([^\s`]+)`?(?:\s*(?:—|--|#)\s*(.*))?$",
    re.IGNORECASE,
)
FORBID_PATTERN_RULE_PATTERN = re.compile(
    r"^(?:-\s+|\*\s+)?`?forbid_pattern:\s*([^\s`]+)\s*::\s*(.+?)`?(?:\s+#\s*(.*))?$",
    re.IGNORECASE,
)
MUST_EXIST_RULE_PATTERN = re.compile(
    r"^(?:-\s+|\*\s+)?`?must_exist:\s*([^\s`]+)`?(?:\s*(?:—|--|#)\s*(.*))?$",
    re.IGNORECASE,
)
IMMUTABLE_PATH_RULE_PATTERN = re.compile(
    r"^(?:-\s+|\*\s+)?`?immutable_path:\s*([^\s`]+)`?(?:\s*(?:—|--|#)\s*(.*))?$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ArchitectureInvariantRule:
    kind: str  # "forbid_import" | "forbid_pattern" | "must_exist" | "immutable_path"
    source_glob: str
    target: str
    rationale: str = ""
    raw_line: str = ""

    def to_dict(self) -> dict[str, str]:
        return {
            "kind": self.kind,
            "source_glob": self.source_glob,
            "target": self.target,
            "rationale": self.rationale,
            "raw_line": self.raw_line,
        }


def compute_file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract_invariant_section_lines(spec_text: str) -> list[str]:
    lines: list[str] = []
    in_section = False
    for raw_line in spec_text.splitlines():
        stripped = raw_line.strip()
        if INVARIANT_SECTION_PATTERN.match(stripped):
            in_section = True
            continue
        if in_section and ANY_H2_PATTERN.match(stripped):
            break
        if in_section and stripped:
            lines.append(stripped)
    return lines


def parse_architecture_invariants(spec_text: str) -> tuple[list[ArchitectureInvariantRule], list[str]]:
    """Parse structured invariant rules and free-form invariant statements."""
    section_lines = extract_invariant_section_lines(spec_text)
    rules: list[ArchitectureInvariantRule] = []
    principles: list[str] = []

    for line in section_lines:
        m_import = FORBID_IMPORT_RULE_PATTERN.match(line)
        if m_import:
            rules.append(
                ArchitectureInvariantRule(
                    kind="forbid_import",
                    source_glob=m_import.group(1).strip(),
                    target=m_import.group(2).strip(),
                    rationale=(m_import.group(3) or "").strip(),
                    raw_line=line,
                )
            )
            continue

        m_pattern = FORBID_PATTERN_RULE_PATTERN.match(line)
        if m_pattern:
            rules.append(
                ArchitectureInvariantRule(
                    kind="forbid_pattern",
                    source_glob=m_pattern.group(1).strip(),
                    target=m_pattern.group(2).strip().rstrip("`"),
                    rationale=(m_pattern.group(3) or "").strip(),
                    raw_line=line,
                )
            )
            continue

        m_exist = MUST_EXIST_RULE_PATTERN.match(line)
        if m_exist:
            rules.append(
                ArchitectureInvariantRule(
                    kind="must_exist",
                    source_glob=m_exist.group(1).strip(),
                    target="",
                    rationale=(m_exist.group(2) or "").strip(),
                    raw_line=line,
                )
            )
            continue

        m_imm = IMMUTABLE_PATH_RULE_PATTERN.match(line)
        if m_imm:
            rules.append(
                ArchitectureInvariantRule(
                    kind="immutable_path",
                    source_glob=m_imm.group(1).strip(),
                    target="",
                    rationale=(m_imm.group(2) or "").strip(),
                    raw_line=line,
                )
            )
            continue

        if line.startswith(("-", "*")):
            principles.append(line.lstrip("-* ").strip())

    return rules, principles


def discover_top_level_specs(project: Path) -> list[dict[str, Any]]:
    """Snapshot top-level specifications and their executable rules at bootstrap."""
    discovered: list[dict[str, Any]] = []
    candidates = [
        ("architecture_spec", "top_level_architecture_invariants", project / "architecture.md"),
        ("architecture_spec", "top_level_architecture_invariants", project / "docs" / "architecture.md"),
        ("requirements_spec", "goal_and_requirements", project / "goal-and-requirements.md"),
        ("requirements_spec", "goal_and_requirements", project / "docs" / "goal-and-requirements.md"),
    ]
    seen_kinds: set[str] = set()
    for kind, role, candidate_path in candidates:
        if kind in seen_kinds or not candidate_path.is_file():
            continue
        text = candidate_path.read_text(encoding="utf-8")
        rules, principles = parse_architecture_invariants(text)
        rel_path = str(candidate_path.relative_to(project))
        sha256_hex = compute_file_sha256(candidate_path)
        entry: dict[str, Any] = {
            "kind": kind,
            "path": rel_path,
            "role": role,
            "sha256": sha256_hex,
        }
        if rules or principles:
            entry["invariants"] = [r.to_dict() for r in rules]
            for rule in entry["invariants"]:
                if rule["kind"] == "immutable_path":
                    target = _project_rule_path(project, rule["source_glob"])
                    if target is not None and target.is_file():
                        rule["sha256"] = compute_file_sha256(target)
            entry["principles"] = principles
        discovered.append(entry)
        seen_kinds.add(kind)
    return discovered


def render_architecture_invariants_markdown(project: Path) -> str:
    specs = discover_top_level_specs(project)
    if not specs:
        return ""
    lines: list[str] = [
        "",
        "## Repo-Wide Architecture Invariants",
        "",
        "- Do not violate or silently weaken the repository-wide invariants declared below during replans or code edits.",
        "- Changed authority sources or immutable files fail verification until their registry locks are updated through a separately authorized review.",
    ]
    for spec in specs:
        lines.append(
            f"- Authority spec `{spec['path']}` (`{spec['kind']}`, sha256=`{spec['sha256'][:12]}...`)"
        )
        for principle in spec.get("principles") or []:
            lines.append(f"  - Principle: {principle}")
        for rule in spec.get("invariants") or []:
            kind = rule.get("kind")
            src = rule.get("source_glob")
            target = rule.get("target")
            rationale = f" ({rule['rationale']})" if rule.get("rationale") else ""
            if kind == "forbid_import":
                lines.append(f"  - Invariant [`forbid_import`]: `{src} -> {target}`{rationale}")
            elif kind == "forbid_pattern":
                lines.append(f"  - Invariant [`forbid_pattern`]: `{src} :: {target}`{rationale}")
            elif kind in {"must_exist", "immutable_path"}:
                lines.append(f"  - Invariant [`{kind}`]: `{src}`{rationale}")
    return "\n".join(lines) + "\n"


def _iter_project_code_files(project: Path) -> list[Path]:
    ignore_dirs = {".git", ".loopx", ".codex", "__pycache__", "node_modules", ".venv", "venv"}
    matched: list[Path] = []
    for root, dirs, files in os.walk(project, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in ignore_dirs)
        for name in sorted(files):
            path = Path(root) / name
            if not path.is_symlink():
                matched.append(path)
    return matched


def _project_rule_path(project: Path, relative: str) -> Path | None:
    """Executable rules may only read paths inside the selected repository."""
    if not relative or Path(relative).is_absolute():
        return None
    path = (project / relative).resolve()
    return path if path.is_relative_to(project.resolve()) else None


def _matches_glob(rel_path: str, pattern: str) -> bool:
    if fnmatch.fnmatch(rel_path, pattern):
        return True
    if pattern.endswith("/**"):
        prefix = pattern[:-3].rstrip("/")
        if rel_path == prefix or rel_path.startswith(prefix + "/"):
            return True
    return False


def _check_python_forbidden_imports(
    file_path: Path, rel_path: str, forbidden_prefix: str
) -> list[str]:
    try:
        source = file_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=rel_path)
    except (OSError, UnicodeError, SyntaxError):
        return [f"{rel_path}: cannot inspect Python imports"]

    violations: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.name
                if name == forbidden_prefix or name.startswith(forbidden_prefix + "."):
                    violations.append(
                        f"{rel_path}:{node.lineno}: forbidden import '{name}' "
                        f"(violates `forbid_import: -> {forbidden_prefix}`)"
                    )
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if mod == forbidden_prefix or mod.startswith(forbidden_prefix + "."):
                violations.append(
                    f"{rel_path}:{node.lineno}: forbidden from-import '{mod}' "
                    f"(violates `forbid_import: -> {forbidden_prefix}`)"
                )
    return violations


def verify_authority_source_digests(
    goal: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Verify every local digest-bearing authority, independent of its domain.

    Legacy entries without a digest retain their previous behavior. This is a
    read-only check: prose in active state cannot approve or replace a lock.
    """
    diagnostics: list[dict[str, Any]] = []
    checks: list[str] = []
    project = Path(str(goal.get("repo") or "")).expanduser()
    goal_id = str(goal.get("id") or "")
    for source in goal.get("authority_sources") or []:
        if not isinstance(source, dict) or not source.get("sha256"):
            continue
        relative = str(source.get("path") or "")
        path = project / relative
        code = ""
        if not relative or not path.is_file():
            code = "authority_source_missing"
        else:
            try:
                actual = compute_file_sha256(path)
            except OSError:
                code = "authority_source_unreadable"
            else:
                if actual != source["sha256"]:
                    code = "authority_source_digest_mismatch"
        if code:
            diagnostics.append(contract_error_diagnostic(
                code=code,
                message=f"{goal_id}: authority source `{relative}` failed verification ({code})",
                goal_id=goal_id,
            ))
        else:
            checks.append(f"{goal_id}: authority source `{relative}` digest verified")
    return diagnostics, checks


def verify_executable_architecture_invariants(
    goal: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Inspect bootstrap-snapshotted software rules; never infer new authority.

    Import checks cover Python static imports only. Prose principles are
    guidance, and executable rules neither approve changes nor write state.
    """
    diagnostics: list[dict[str, Any]] = []
    checks: list[str] = []
    goal_id = str(goal.get("id") or "")
    project = Path(str(goal.get("repo") or "")).expanduser().resolve()
    code_files: list[Path] | None = None
    for source in goal.get("authority_sources") or []:
        if not isinstance(source, dict):
            continue
        rules = source.get("invariants")
        if not isinstance(rules, list):
            continue
        hits: list[str] = []
        for item in rules:
            if not isinstance(item, dict):
                hits.append("invalid executable invariant record")
                continue
            kind = str(item.get("kind") or "")
            pattern = str(item.get("source_glob") or "")
            target = _project_rule_path(project, pattern)
            if target is None:
                hits.append(f"invalid repository-relative invariant path `{pattern}`")
                continue
            if kind == "must_exist":
                if not target.exists():
                    hits.append(f"required architectural artifact `{pattern}` is missing")
            elif kind == "immutable_path":
                try:
                    digest = compute_file_sha256(target)
                except OSError:
                    hits.append(f"immutable artifact `{pattern}` is missing or unreadable")
                else:
                    if not item.get("sha256") or digest != item["sha256"]:
                        hits.append(f"immutable artifact `{pattern}` differs from its bootstrap lock")
            elif kind in {"forbid_import", "forbid_pattern"}:
                forbidden = str(item.get("target") or "")
                try:
                    regex = re.compile(forbidden) if kind == "forbid_pattern" else None
                except re.error:
                    hits.append(f"invalid regular expression in `{pattern}` invariant")
                    continue
                if code_files is None:
                    code_files = _iter_project_code_files(project)
                for path in code_files:
                    relative = path.relative_to(project).as_posix()
                    if not _matches_glob(relative, pattern):
                        continue
                    if kind == "forbid_import":
                        if path.suffix == ".py":
                            hits.extend(_check_python_forbidden_imports(path, relative, forbidden))
                    else:
                        try:
                            lines = path.read_text(encoding="utf-8").splitlines()
                        except (OSError, UnicodeError):
                            hits.append(f"cannot inspect `{relative}` for forbidden patterns")
                            continue
                        for number, line in enumerate(lines, 1):
                            if regex is not None and regex.search(line):
                                hits.append(f"{relative}:{number}: forbidden pattern `{forbidden}`")
            else:
                hits.append(f"unsupported executable invariant `{kind}`")
        for hit in hits:
            diagnostics.append(contract_error_diagnostic(
                code="architecture_invariant_violation",
                message=f"{goal_id}: {hit}", goal_id=goal_id,
            ))
        checks.append(
            f"{goal_id}: executable invariants in `{source.get('path', '')}` checked "
            f"(rules={len(rules)}, violations={len(hits)})"
        )
    return diagnostics, checks
