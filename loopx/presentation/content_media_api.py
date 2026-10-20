"""Loopback transport for Goal-owned private content compositions."""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path
import re
from typing import Any
from urllib.parse import parse_qs, urlparse

from ..capabilities.content_ops.media import MediaWorkspace
from ..feedback import validate_goal_id
from .goal_source_routing import source_registry_for_goal

CONTENT_MEDIA_PATH = "/api/chat/content-media"


class ContentMediaRequestMixin:
    server: Any
    path: str

    def _media_workspace(self, goal_id: str) -> MediaWorkspace:
        validate_goal_id(goal_id)
        selected = getattr(self.server, "selected_goal_id", None)
        if selected and selected != goal_id:
            raise ValueError("Goal is outside this workspace")
        source = source_registry_for_goal(self.server.registry_path, goal_id)
        return MediaWorkspace(
            registry_path=Path(source),
            goal_id=goal_id,
            runtime_root=Path(self.server.runtime_root),
        )

    def _content_media_request(self) -> None:
        try:
            if urlparse(self.path).query:
                raise ValueError("Use the request body")
            body = self._read_json(max_bytes=4096)
            if set(body) - {"goal_id", "action", "composition_id", "expected_revision"}:
                raise ValueError("Unsupported fields")
            workspace = self._media_workspace(body["goal_id"])
            action = body["action"]
            if action == "list" and set(body) == {"goal_id", "action"}:
                result = workspace.list()
            elif action == "inspect" and set(body) == {
                "goal_id",
                "action",
                "composition_id",
            }:
                result = workspace.inspect(body["composition_id"])
            elif action in {"render", "cancel"} and set(body) == {
                "goal_id",
                "action",
                "composition_id",
                "expected_revision",
            }:
                revision = body["expected_revision"]
                if isinstance(revision, bool) or not isinstance(revision, int):
                    raise ValueError("Read the current revision")
                method = workspace.render if action == "render" else workspace.cancel
                result = method(
                    body["composition_id"],
                    expected_revision=revision,
                    **({"background": True} if action == "render" else {}),
                )
            else:
                raise ValueError("Unsupported operation")
            self._send_json(result)
        except (OSError, ValueError, TypeError, KeyError, RuntimeError):
            self._send_error(
                "Video request unavailable. Reopen the selected Goal and composition, then retry.",
                status=400,
            )

    def _content_media_file(self) -> None:
        try:
            query = parse_qs(urlparse(self.path).query, strict_parsing=True)
            if set(query) != {"goal_id", "composition_id", "file"} or any(
                len(v) != 1 for v in query.values()
            ):
                raise ValueError("Invalid file request")
            workspace = self._media_workspace(query["goal_id"][0])
            name = query["file"][0]
            path = workspace.file(query["composition_id"][0], name)
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "rb") as source:
                size = os.fstat(source.fileno()).st_size
                start, end, status = 0, size - 1, 200
                header = self.headers.get("Range")
                if header:
                    match = re.fullmatch(r"bytes=(\d+)-(\d*)", header)
                    if not match:
                        raise ValueError("Unsupported byte range")
                    start, end = (
                        int(match[1]),
                        min(int(match[2]) if match[2] else size - 1, size - 1),
                    )
                    if not 0 <= start <= end < size:
                        raise ValueError("Invalid byte range")
                    status = 206
                self.send_response(status)
                self.send_header(
                    "Content-Type",
                    "text/vtt; charset=utf-8"
                    if name.endswith(".vtt")
                    else mimetypes.guess_type(name)[0] or "application/octet-stream",
                )
                self.send_header("Content-Length", str(end - start + 1))
                self.send_header("Content-Disposition", f'inline; filename="{name}"')
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Cross-Origin-Resource-Policy", "same-origin")
                self.send_header("X-Content-Type-Options", "nosniff")
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                source.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = source.read(min(remaining, 65536))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return
        except (OSError, ValueError, TypeError, KeyError):
            self._send_error("Verified video file unavailable.", status=404)
