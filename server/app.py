from __future__ import annotations

import copy
import logging
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import analysis, editing, exporting, imaging, pipeline, storage as store
from .normals import NormalSettings

app = FastAPI(title="Frame Studio", version="0.5.0")
pool = ThreadPoolExecutor(max_workers=2)
jobs: dict[str, dict] = {}
busy: dict[str, str] = {}
jobs_lock = threading.RLock()
reports: dict[str, dict] = {}
log = logging.getLogger("frame-studio")


@app.middleware("http")
async def local_only(request: Request, call_next):
    # Browser-origin writes must come from this local editor.
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin not in (
        "http://127.0.0.1:8971", "http://localhost:8971", "http://127.0.0.1:5178", "http://localhost:5178"
    ):
        return JSONResponse({"detail": "只接受本地编辑器请求"}, status_code=403)
    return await call_next(request)


@app.exception_handler(ValueError)
async def value_error(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(FileNotFoundError)
async def not_found(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=404)


def idle(pid):
    if pid in busy:
        raise HTTPException(409, "项目正在处理，请等待完成或取消任务")


def submit(pid, kind, work):
    with jobs_lock:
        idle(pid)
        jid = uuid.uuid4().hex[:16]
        job = dict(id=jid, project_id=pid, kind=kind, state="queued", progress=0,
                   message="等待处理", cancel=False, started=time.time(), result=None)
        jobs[jid] = job
        busy[pid] = jid

    def update(value, message):
        with jobs_lock:
            job.update(progress=value, message=message)

    def run():
        job.update(state="running")
        try:
            result = work(update, lambda: job["cancel"])
            job.update(state="done", progress=1, message="已完成", result=result)
        except InterruptedError as exc:
            job.update(state="canceled", message=str(exc))
        except Exception as exc:
            log.exception("Job %s failed", jid)
            job.update(state="failed", message=str(exc))
            if kind == "import":
                project = store.read(pid)
                project.update(import_status="failed", import_error=str(exc))
                store.write(project)
        finally:
            with jobs_lock:
                busy.pop(pid, None)
    pool.submit(run)
    return dict(job_id=jid, project_id=pid)


@app.get("/api/health")
def health():
    return dict(ok=True, app="frame-studio", version="0.5.0", ai_ready=imaging.model_path(store.MODELS) is not None)


@app.post("/api/models/install")
def install():
    return submit("_model", "model", lambda update, cancel: _install(update))


def _install(update):
    update(.1, "正在下载并初始化 U2NetP（首次可能需要一分钟）")
    imaging.ai_session(store.MODELS)
    return {"ready": True}


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    if jid not in jobs:
        raise HTTPException(404, "任务不存在，服务可能已重启")
    return {k: v for k, v in jobs[jid].items() if k != "cancel"}


@app.post("/api/jobs/{jid}/cancel")
def cancel_job(jid: str):
    if jid not in jobs:
        raise HTTPException(404, "任务不存在")
    jobs[jid]["cancel"] = True
    return {"ok": True}


@app.get("/api/projects")
def projects():
    result = []
    for path in store.PROJECTS.glob("*/project.json"):
        try:
            p = store.read(path.parent.name)
            result.append({k: p.get(k) for k in ("id", "name", "style", "updated_at", "import_status")} |
                          {"frame_count": len(p["frames"]), "job_id": busy.get(p["id"])})
        except (ValueError, OSError):
            continue
    return sorted(result, key=lambda p: p.get("updated_at", ""), reverse=True)


@app.get("/api/projects/{pid}")
def project(pid: str):
    return store.public(store.read(pid)) | {"job_id": busy.get(pid)}


@app.post("/api/demo")
def demo():
    p = store.create("潮汐 · 水母漂浮", 12, "smooth")
    def work(update, cancel):
        pipeline.ingest(p, [], 12, 0, 0, update, cancel)
        return pipeline.process(p["id"], None, imaging.Settings(**p["settings"]), False, update, cancel)
    return submit(p["id"], "import", work)


@app.post("/api/import")
async def import_files(files: list[UploadFile] = File(...), name: str = Form("未命名序列"),
                       fps: float = Form(12), style: Literal["smooth", "pixel"] = Form("smooth"),
                       start: float = Form(0), end: float = Form(0)):
    if not 1 <= fps <= 60 or start < 0 or end < 0 or (end and end <= start):
        raise HTTPException(400, "帧率应在 1–60，结束时间必须晚于开始时间（0 表示到结尾）")
    if not files or len(files) > pipeline.MAX_FRAMES:
        raise HTTPException(400, "请选择一个视频或不超过 480 张图片")
    image_ext = {".png", ".webp", ".jpg", ".jpeg"}
    allowed = image_ext | {".mp4", ".mov", ".mkv", ".webm", ".avi"}
    suffixes = [Path(f.filename or "").suffix.lower() for f in files]
    if any(s not in allowed for s in suffixes) or (len(files) > 1 and any(s not in image_ext for s in suffixes)):
        raise HTTPException(400, "请选择一个 MP4/MOV/WebM 视频，或一组 PNG/JPG/WebP 图片")
    p = store.create(name, fps, style)
    paths, total = [], 0
    try:
        for i, file in enumerate(files):
            # Keep a sanitized filename for natural ordering.
            filename = re.sub(r"[^a-zA-Z0-9_.\-\u4e00-\u9fff]", "_", Path(file.filename or f"{i}.png").name)
            path = store.project_dir(p["id"]) / "uploads" / f"{filename}.{i}{suffixes[i]}"
            with path.open("wb") as out:
                while chunk := await file.read(1024*1024):
                    total += len(chunk)
                    if total > 512*1024*1024:
                        raise ValueError("一次导入最多 512 MB")
                    out.write(chunk)
            paths.append(path)
    except Exception as exc:
        p.update(import_status="failed", import_error=str(exc))
        store.write(p)
        raise
    finally:
        for file in files:
            await file.close()
    return submit(p["id"], "import", lambda update, cancel: pipeline.ingest(p, paths, fps, start, end, update, cancel))


class ProcessRequest(BaseModel):
    indices: list[int] | None = None
    settings: imaging.Settings | None = None
    rebuild_palette: bool = False
    asset_options: imaging.AssetOptions | None = None
    asset_patch: imaging.AssetEdits | None = None
    expected_revision: int | None = None
    settings_patch: dict[str,Any] | None = Field(default=None,max_length=64)


@app.post("/api/projects/{pid}/process")
def process(pid: str, request: ProcessRequest):
    store.read(pid)
    def work(update, cancel):
        if request.expected_revision is not None:
            editing.check_revision(store.read(pid), request.expected_revision)
        return pipeline.process(pid, request.indices, request.settings, request.rebuild_palette,
                                update, cancel, asset_options=request.asset_options, asset_patch=request.asset_patch,
                                settings_patch=request.settings_patch)
    return submit(pid, "process", work)


class PreviewRequest(BaseModel):
    index: int
    settings: imaging.Settings | None = None
    indices: list[int] | None = None
    asset_options: imaging.AssetOptions | None = None
    asset_patch: imaging.AssetEdits | None = None
    expected_revision: int | None = None
    settings_patch: dict[str,Any] | None = Field(default=None,max_length=64)


@app.post("/api/projects/{pid}/preview")
def preview(pid: str, request: PreviewRequest):
    with jobs_lock:
        idle(pid)
        # Reserve project during preview so disk writes cannot race a mutation.
        busy[pid] = "preview"
    try:
        if request.expected_revision is not None:
            editing.check_revision(store.read(pid), request.expected_revision)
        path, geometry = pipeline.preview(pid, request.index, request.settings, request.indices,
                                          request.asset_options, request.asset_patch, request.settings_patch)
        return {"url": f"/media/{pid}/{path}", "geometry": geometry}
    finally:
        with jobs_lock:
            busy.pop(pid, None)


class BrushRequest(BaseModel):
    strokes: list[imaging.Stroke] = Field(max_length=200)


@app.put("/api/projects/{pid}/frames/{index}/mask")
def brush(pid: str, index: int, request: BrushRequest):
    return submit(pid, "brush", lambda update, cancel: pipeline.process(
        pid, [index], None, False, update, cancel, [s.model_dump() for s in request.strokes]))


class FramePatch(BaseModel):
    indices: list[int] = Field(min_length=1, max_length=480)
    enabled: bool


@app.patch("/api/projects/{pid}/frames")
def patch_frames(pid: str, request: FramePatch):
    with jobs_lock, store.lock(pid):
        idle(pid)
        p = store.read(pid)
        if any(i < 0 or i >= len(p["frames"]) for i in request.indices):
            raise ValueError("无效帧索引")
        store.checkpoint(p)
        before = copy.deepcopy(p)
        for i in request.indices:
            p["frames"][i]["enabled"] = request.enabled
        editing.update_dependents(before, p)
        store.write(p)
        return store.public(p)


class ActionRequest(BaseModel):
    name: str = Field(min_length=1, max_length=50, pattern=r"^[\w\-\u4e00-\u9fff ]+$")
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    fps: float = Field(ge=1, le=60)
    loop: bool = True


@app.post("/api/projects/{pid}/actions")
def action(pid: str, request: ActionRequest):
    with jobs_lock, store.lock(pid):
        idle(pid)
        p = store.read(pid)
        if request.start > request.end or request.end >= len(p["frames"]):
            raise ValueError("无效动作范围")
        store.checkpoint(p)
        before = copy.deepcopy(p)
        remaining = []
        for a in p["actions"]:
            if a["end"] < request.start or a["start"] > request.end:
                remaining.append(a)
            else:
                if a["start"] < request.start:
                    remaining.append(a | {"end": request.start-1, "name": a["name"]+"_前", "id": uuid.uuid4().hex[:8]})
                if a["end"] > request.end:
                    remaining.append(a | {"start": request.end+1, "name": a["name"]+"_后", "id": uuid.uuid4().hex[:8]})
        names = {a["name"] for a in remaining}
        if request.name in names:
            raise ValueError("动作名称已存在，请使用不同名称")
        p["actions"] = sorted(remaining + [request.model_dump() | {"id": uuid.uuid4().hex[:8]}], key=lambda a: a["start"])
        editing.update_dependents(before, p)
        store.write(p)
        return store.public(p)


class FrameEditRequest(BaseModel):
    expected_revision: int
    operation: Literal["order", "reverse", "duplicate", "delete", "duration"]
    indices: list[int] = Field(default_factory=list, max_length=480)
    order: list[int] | None = Field(default=None, max_length=480)
    duration: float | None = Field(default=None, ge=.001, le=60, allow_inf_nan=False)


def project_operation(pid, work):
    with jobs_lock:
        idle(pid)
        busy[pid] = "preview"  # Synchronous reservation; never expose a nonexistent job id.
    try:
        with store.lock(pid):
            return work()
    finally:
        with jobs_lock:
            busy.pop(pid, None)


class NormalPreviewRequest(BaseModel):
    index: int = Field(ge=0)
    settings: NormalSettings | None = None
    expected_revision: int


class NormalApplyRequest(BaseModel):
    settings: NormalSettings
    indices: list[int] | None = Field(default=None, max_length=480)
    expected_revision: int


@app.post("/api/projects/{pid}/normals/preview")
def preview_normals(pid: str, request: NormalPreviewRequest):
    return project_operation(pid, lambda: pipeline.normal_preview(
        pid, request.index, request.settings, request.expected_revision))


@app.post("/api/projects/{pid}/normals")
def generate_normals(pid: str, request: NormalApplyRequest):
    store.read(pid)
    return submit(pid, "normals", lambda update, cancel: pipeline.apply_normals(
        pid, request.indices, request.settings, request.expected_revision, update, cancel))


@app.post("/api/projects/{pid}/edit")
def edit_frames(pid: str, request: FrameEditRequest):
    return project_operation(pid, lambda: editing.edit(pid, request))


class AnalysisRequest(BaseModel):
    expected_revision: int
    source: Literal["original", "result"] = "result"
    scope: Literal["all", "action"] = "all"
    action_id: str | None = None
    duplicate_threshold: float = Field(default=1, ge=0, le=20, allow_inf_nan=False)
    window: int = Field(default=6, ge=1, le=24)
    jump_k: float = Field(default=3, ge=1, le=10, allow_inf_nan=False)
    jump_floor: float = Field(default=3, ge=.5, le=30, allow_inf_nan=False)
    min_period: int = Field(default=2, ge=2, le=120)
    max_period: int = Field(default=60, ge=2, le=120)
    loop_max_error: float = Field(default=5, ge=.1, le=30, allow_inf_nan=False)


@app.post("/api/projects/{pid}/analyze")
def analyze(pid: str, request: AnalysisRequest):
    def work(update, cancel):
        project = store.read(pid)
        editing.check_revision(project, request.expected_revision)
        result = analysis.check(project, request, update, cancel)
        with jobs_lock:
            if len(reports) >= 64:
                reports.pop(next(iter(reports)))
            reports[result["id"]] = copy.deepcopy(result)
        return {"analysis": result}
    store.read(pid)
    return submit(pid, "analysis", work)


class AnalysisApplyRequest(BaseModel):
    expected_revision: int
    report_id: str
    operation: Literal["compress", "skip", "loop"]
    candidate_ids: list[str] = Field(min_length=1, max_length=480)
    name: str | None = Field(default=None, max_length=50, pattern=r"^[\w\-\u4e00-\u9fff ]+$")


@app.post("/api/projects/{pid}/analysis/apply")
def apply_analysis(pid: str, request: AnalysisApplyRequest):
    def work():
        if request.report_id not in reports:
            raise ValueError("检查结果已清除或服务已重启，请重新检查。")
        return editing.apply_report(pid, reports[request.report_id], request)
    return project_operation(pid, work)


@app.post("/api/projects/{pid}/undo")
def undo(pid: str):
    with jobs_lock, store.lock(pid):
        idle(pid)
        p = store.read(pid)
        if not p["history"]:
            raise ValueError("没有可撤销的操作")
        prev = p["history"].pop()
        prev["history"], prev["revision"] = p["history"], p["revision"]
        store.write(prev)
        return store.public(prev)


class ExportRequest(BaseModel):
    options: exporting.ExportOptions | None = None
    expected_revision: int | None = None


@app.post("/api/projects/{pid}/export/preview")
def export_preview(pid: str, request: ExportRequest):
    return project_operation(pid, lambda: exporting.preview_layout(pid, request.options, request.expected_revision))


@app.post("/api/projects/{pid}/export")
def export(pid: str, request: ExportRequest | None = None):
    request = request or ExportRequest()
    return submit(pid, "export", lambda update, cancel: exporting.export_project(
        pid, update, cancel, request.options, request.expected_revision))


@app.get("/media/{pid}/{relative:path}")
def media(pid: str, relative: str):
    root = store.project_dir(pid).resolve()
    target = (root / relative).resolve()
    if not target.is_relative_to(root) or target.suffix not in (".png", ".zip"):
        raise HTTPException(403, "无法读取此资源")
    if not target.is_file():
        raise HTTPException(404, "文件不存在")
    return FileResponse(target, filename="FrameStudio-export.zip" if target.suffix == ".zip" else None)


WEB = store.ROOT / "web" / "dist"
if WEB.exists():
    app.mount("/", StaticFiles(directory=WEB, html=True), name="editor")
