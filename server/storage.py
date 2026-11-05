from __future__ import annotations

import copy
import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("FRAME_STUDIO_DATA", str(ROOT / "data"))).resolve()
PROJECTS = DATA / "projects"
MODELS = DATA / "models"
for directory in (PROJECTS, MODELS):
    directory.mkdir(parents=True, exist_ok=True)
locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def now():
    return datetime.now(timezone.utc).isoformat()


def project_dir(pid: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{16}", pid):
        raise ValueError("无效的项目 ID")
    return PROJECTS / pid


def lock(pid):
    with _locks_guard:
        return locks.setdefault(pid, threading.RLock())


def read(pid):
    with lock(pid):
        path = project_dir(pid) / "project.json"
        if not path.exists():
            raise FileNotFoundError("项目不存在")
        return defaults(json.loads(path.read_text()))


def defaults(project):
    from .imaging import AssetOptions, Settings
    from .exporting import ExportOptions
    from .normals import NormalSettings
    project["settings"] = Settings(**project["settings"]).model_dump()
    project["asset_options"] = AssetOptions(**project.get("asset_options", {})).model_dump()
    project["export_options"] = ExportOptions(**project.get("export_options", {})).model_dump()
    project["normal_settings"] = NormalSettings(**project.get("normal_settings", {})).model_dump()
    for frame in project["frames"]:
        if frame.get("settings"):
            frame["settings"] = Settings(**frame["settings"]).model_dump()
        if frame.get("normal_settings"):
            frame["normal_settings"] = NormalSettings(**frame["normal_settings"]).model_dump()
    return project


def write(project):
    pid = project["id"]
    with lock(pid):
        project["updated_at"] = now()
        project["revision"] = project.get("revision", 0) + 1
        path = project_dir(pid) / "project.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(project, ensure_ascii=False, indent=2))
        os.replace(tmp, path)


def create(name, fps, style):
    pid = uuid.uuid4().hex[:16]
    path = project_dir(pid)
    for part in ("originals", "derived", "thumbs", "uploads", "exports"):
        (path / part).mkdir(parents=True)
    from .imaging import Settings
    project = dict(id=pid, name=name[:100] or "未命名序列", fps=fps, style=style,
                   frames=[], actions=[], palette=None, palette_colors=None, history=[],
                   settings=Settings(style=style, size=128 if style == "pixel" else 384).model_dump(),
                   created_at=now(), revision=0, import_status="pending")
    write(project)
    return project


def checkpoint(project):
    snap = copy.deepcopy({k: v for k, v in project.items() if k not in ("history", "revision", "updated_at")})
    project["history"] = (project.get("history", []) + [snap])[-12:]


def public(project):
    p = defaults(copy.deepcopy(project))
    p["can_undo"] = bool(p.pop("history", []))
    position = 0.0
    for i, frame in enumerate(p["frames"]):
        frame["timeline_time"] = position
        frame["source_time"] = frame["time"]
        if frame["enabled"]:
            speed = next((a["fps"] for a in p["actions"] if a["start"] <= i <= a["end"]), p["fps"])
            position += frame["duration"] * p["fps"] / speed
        for key in ("original", "output", "thumb", "normal"):
            if frame.get(key):
                frame[key + "_url"] = f'/media/{p["id"]}/{frame[key]}'
    return p
