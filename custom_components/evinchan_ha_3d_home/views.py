"""HTTP views: serve the built frontend and expose the 3D Home REST API.

All API routes are mounted under ``/api/evinchan_ha_3d_home/api/`` and mirror the
Add-on's Fastify endpoints so the unmodified prebuilt SPA (which derives its
base path from ``window.location.pathname``) works without rebuild.
"""

from __future__ import annotations

import datetime
import email.utils
import hashlib
import json
import logging
import os
import re
from typing import Any

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import API_PREFIX, DOMAIN
from .ha_client import HaClient
from .project_store import EXPORT_LAYOUTS_KEY, ProjectStore

_LOGGER = logging.getLogger(__name__)

WWW_PATH = os.path.join(os.path.dirname(__file__), "www")
# 缓存 www/ 的真实路径，供 _read_static 逐请求做 symlink 越界校验（避免重复解析根目录）。
_WWW_ROOT = os.path.realpath(WWW_PATH)

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".zip": "application/zip",
    ".md": "text/markdown; charset=utf-8",
}

_KIND_FROM_DOMAIN = {
    "light": "light", "switch": "switch", "cover": "cover", "climate": "climate",
    "sensor": "sensor", "binary_sensor": "binary_sensor", "camera": "camera",
    "fan": "fan", "media_player": "media_player",
    "alarm_control_panel": "alarm_control_panel",
}


def _guess_type(path: str) -> str:
    _, ext = os.path.splitext(path)
    return _CONTENT_TYPES.get(ext.lower(), "application/octet-stream")


def _is_safe_static(full: str) -> bool:
    """True only when ``full`` really resolves to a path inside ``www/``.

    ``os.path.normpath`` does not resolve symlinks and ``open``/``isfile``
    follow them, so a link placed inside ``www/`` could otherwise disclose any
    file readable by the HA process. A link pointing to another file *inside*
    ``www/`` stays valid. Callers must check ``os.path.isfile(full)`` first so
    we never resolve a path that does not exist.
    """
    try:
        resolved = os.path.realpath(full)
        return os.path.commonpath([_WWW_ROOT, resolved]) == _WWW_ROOT
    except (OSError, ValueError):
        # Mixed absolute/relative paths or different drives: fail closed.
        return False


def _read_static(rel: str) -> tuple[bytes | None, str]:
    """Read a file from ``www/`` with SPA fallback.

    Runs in the executor (never on the event loop). Returns ``(None, path)`` when
    the frontend build is missing.
    """
    full = os.path.normpath(os.path.join(WWW_PATH, rel))
    # 为何加 os.sep：裸 startswith 会放过同前缀兄弟目录（如 www_evil/secret.js）。
    # 顺序刻意如此：先做廉价词法守卫与 isfile，文件确实存在才解析 realpath。
    if (
        not full.startswith(WWW_PATH + os.sep)
        or not os.path.isfile(full)
        or not _is_safe_static(full)
    ):
        full = os.path.join(WWW_PATH, "index.html")
        # fallback 自身也做轻量校验：www/index.html 若被换成指向外部的链接，
        # 不能因为「回落」就把外部内容当首页返回。
        if not os.path.isfile(full) or not _is_safe_static(full):
            return None, full
    try:
        with open(full, "rb") as fh:
            return fh.read(), full
    except OSError:
        return None, full


# Vite emits ``name-<base64url hash>.ext``. The hash is NOT strictly
# alphanumeric: real chunks here include ``scene-DONJeQs_.js`` and
# ``antd-vendor-uE--Rlfu.js``, so the charset must allow ``_`` and ``-``.
_HASHED_ASSET_RE = re.compile(r"^.+-[A-Za-z0-9_-]{8,}\.(?:js|css)$")
_CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
_CACHE_NO_STORE = "no-cache, must-revalidate"


def _cache_control_for(full: str) -> str:
    """Decide Cache-Control from the file ``_read_static`` ACTUALLY served.

    ``_read_static`` falls back to ``www/index.html`` whenever ``rel`` is
    missing or escapes ``WWW_PATH``. Classifying by the requested name would
    mark a deep-link fallback as ``immutable`` and pin a stale asset set
    forever after an upgrade — so ``full`` (not ``rel``) is the only input.
    """
    normalized = os.path.normpath(full)
    if os.path.basename(normalized) == "index.html":
        return _CACHE_NO_STORE
    assets_root = os.path.join(WWW_PATH, "assets")
    if normalized.startswith(assets_root + os.sep) and _HASHED_ASSET_RE.match(
        os.path.basename(normalized)
    ):
        return _CACHE_IMMUTABLE
    # Unhashed CSS/JS, textures, fonts: conservative, but the validators below
    # still turn a revalidation round trip into a cheap 304.
    return _CACHE_NO_STORE


def _read_static_with_meta(rel: str) -> tuple[bytes | None, str, str, str]:
    """Read + compute validators in ONE executor job (HA flags loop I/O).

    Keeps ``_read_static`` untouched: path normalisation, traversal guard and
    SPA fallback semantics stay exactly as before. ``os.stat`` and SHA-256
    also run off the event loop.
    """
    body, full = _read_static(rel)
    if body is None:
        return None, full, "", ""
    try:
        mtime = os.stat(full).st_mtime
    except OSError:
        mtime = 0.0
    last_modified = email.utils.formatdate(mtime, usegmt=True)
    # Strong, content-addressed ETag: an upgrade always changes the hash,
    # unlike a stat-based tag that can be reused across same-size edits.
    etag = '"' + hashlib.sha256(body).hexdigest() + '"'
    return body, full, etag, last_modified


def _validator_headers(etag: str, last_modified: str) -> dict[str, str]:
    headers = {"ETag": etag}
    if last_modified:
        headers["Last-Modified"] = last_modified
    return headers


def _not_modified(request: web.Request, headers: dict[str, str]) -> bool:
    """RFC 7232 conditional GET. If-None-Match wins over If-Modified-Since.

    GET/HEAD use the weak comparison function: a ``W/`` prefix on either side
    does not prevent a match. An unparseable date simply means "not proven".
    """
    inm = request.headers.get("If-None-Match")
    if inm:
        ours = headers.get("ETag", "")
        ours = ours[2:] if ours.startswith("W/") else ours
        for raw in inm.split(","):
            token = raw.strip()
            if token == "*":
                return True
            token = token[2:] if token.startswith("W/") else token
            if token == ours:
                return True
        return False  # INM present but no match -> IMS must be ignored
    ims = request.headers.get("If-Modified-Since")
    modified_str = headers.get("Last-Modified")
    if not ims or not modified_str:
        return False
    try:
        since = email.utils.parsedate_to_datetime(ims)
        modified = email.utils.parsedate_to_datetime(modified_str)
        if since.tzinfo is None:
            since = since.replace(tzinfo=datetime.timezone.utc)
        if modified.tzinfo is None:
            modified = modified.replace(tzinfo=datetime.timezone.utc)
        return modified <= since
    except (TypeError, ValueError, OverflowError):
        return False


def _ok(payload: Any, status: int = 200) -> web.Response:
    return web.json_response(payload, status=status)


def _broadcast_project(hass: HomeAssistant, project: dict[str, Any]) -> None:
    """Push a project.updated event to connected SPA websocket clients."""
    gateway = hass.data.get(DOMAIN, {}).get("gateway")
    if gateway is not None:
        gateway.broadcast({"type": "project.updated", "payload": project})


def _err(message: str, status: int = 400) -> web.Response:
    return web.json_response({"error": message}, status=status)


class ThreeDHomeApiView(HomeAssistantView):
    """Dispatch all ``/api/evinchan_ha_3d_home/api/...`` requests."""

    name = "api:evinchan_ha_3d_home:api"
    url = f"{API_PREFIX}/api/{{path:.*}}"
    # The prebuilt SPA cannot present a HA Bearer token, and the iframe panel is
    # only reachable inside an already-authenticated HA session, so we serve the
    # API without HA's standard auth check (local-network trust model).
    requires_auth = False

    async def _dispatch(self, request: web.Request, path: str) -> web.Response:
        # Normalise: strip query, ensure leading slash segment list.
        segments = [s for s in path.split("/") if s]
        method = request.method
        hass: HomeAssistant = request.app["hass"]
        ha: HaClient = hass.data[DOMAIN]["ha_client"]
        store: ProjectStore = hass.data[DOMAIN]["project_store"]

        # /api/health
        if path == "health" and method == "GET":
            return _ok({"ok": True, "mode": "integration", "timestamp": _now_iso()})

        # /api/license — 授权状态查询与激活
        if segments[:1] == ["license"]:
            return await self._handle_license(request, hass)

        # /api/ha/*
        if segments[:1] == ["ha"]:
            return await self._handle_ha(request, segments[1:], ha, store)

        # /api/projects* and /api/assets*
        if segments[:1] == ["projects"]:
            return await self._handle_projects(request, segments[1:], store)
        if segments[:1] == ["assets"]:
            return await self._handle_assets(request, segments[1:], store)

        # /api/layouts[?projectId=...&roomId=...] — room card configuration
        if segments[:1] == ["layouts"]:
            return await self._handle_layouts(request, store)

        return _err("Not found", 404)

    async def _handle_license(self, request: web.Request, hass: HomeAssistant) -> web.Response:
        """授权状态查询 / 激活。

        GET  /api/license        -> { activated, tier, features, expiresAt, reason, machineId }
        POST /api/license {key}  -> 同上（提交后立即重新验签）

        注意：这里的 activated/tier 是**服务端验签结果**，前端只做展示与降级；
        真正的功能限制必须在服务端业务接口里用 ``license_store.has_feature()``
        判定，不能只信这个响应。
        """
        lic_store = hass.data.get(DOMAIN, {}).get("license_store")
        if lic_store is None:
            return _err("License store unavailable", 503)

        if request.method == "GET":
            payload = lic_store.status()
            payload["machineId"] = lic_store.machine_id()
            return _ok(payload)

        if request.method == "POST":
            body = await _json(request)
            key = body.get("key")
            if not isinstance(key, str):
                return _err("key is required", 400)
            status = await lic_store.async_set_key(key)
            status["machineId"] = lic_store.machine_id()
            return _ok(status)

        return _err("Method not allowed", 405)

    async def _handle_layouts(self, request: web.Request, store: ProjectStore) -> web.Response:
        """Read / write the per-room device-card layout (hidden + order).

        GET  /api/layouts                      -> { projectId, layouts: {roomId: {...}} }
        GET  /api/layouts?roomId=X             -> { projectId, roomId, layout: {...} }
        PUT  /api/layouts   {roomId, layout}   -> { projectId, roomId, layout: {...} }

        Stored on the server so removing/reordering devices is shared by every
        browser instead of living in one browser's localStorage.
        """
        project_id = request.query.get("projectId") or None
        if project_id is None:
            project_id = store.get_current_project_id()
        if not project_id:
            return _err("Project not found", 404)
        if not store.get_project(project_id):
            return _err("Project not found", 404)

        if request.method == "GET":
            room_id = request.query.get("roomId")
            if room_id:
                return _ok({
                    "projectId": project_id,
                    "roomId": room_id,
                    "layout": store.get_layout(room_id, project_id),
                })
            return _ok({"projectId": project_id, "layouts": store.get_layouts(project_id)})

        if request.method in ("PUT", "POST"):
            body = await _json(request)
            room_id = body.get("roomId")
            layout = body.get("layout")
            if not isinstance(room_id, str) or not room_id.strip():
                return _err("roomId is required", 400)
            if layout is not None and not isinstance(layout, dict):
                return _err("layout must be an object", 400)
            try:
                saved = await store.save_layout(room_id, layout or {}, project_id)
            except ValueError as err:
                return _err(str(err), 400)
            return _ok({"projectId": project_id, "roomId": room_id, "layout": saved})

        return _err("Method not allowed", 405)

    async def _handle_ha(self, request, segments, ha: HaClient, store: ProjectStore) -> web.Response:
        if not segments:
            return _err("Not found", 404)
        head = segments[0]

        if head == "status" and request.method == "GET":
            return _ok(ha.status())
        if head == "entities" and request.method == "GET":
            # /api/ha/entities or /api/ha/entities/:id
            # ?slim=1 drops a few bulky attributes the 3D panel never renders,
            # shrinking the payload on weak devices (e.g. iPad mini 4).
            slim = request.query.get("slim") == "1"
            if len(segments) == 1:
                return _ok({"entities": ha.get_entities(slim=slim)})
            entity = ha.get_entity(segments[1])
            if not entity:
                return _err("Entity not found", 404)
            return _ok({"entity": entity})
        if head == "areas" and request.method == "GET":
            return _ok({"areas": ha.get_areas()})
        if head == "assist-pipelines" and request.method == "GET":
            return await self._assist_pipelines(request)
        if head == "actions" and request.method == "POST":
            body = await _json(request)
            try:
                entity = await ha.perform_action(body)
            except ValueError as err:
                return _err(str(err), 404 if "Unknown entity" in str(err) else 502)
            return _ok({"entity": entity})
        if head == "conversation" and request.method == "POST":
            return await self._conversation(request, ha)
        if head == "reconnect" and request.method == "POST":
            # No remote connection exists in integration mode; just refresh the
            # in-process snapshot and report success so the SPA can proceed.
            ha.sync_from_hass()
            return _ok({"status": ha.status()})
        if head == "config" and request.method == "POST":
            return _err("集成模式下无需配置连接：数据直接来自 Home Assistant 内部", 403)
        if head == "cameras" and len(segments) >= 3 and segments[-1] in ("stream", "snapshot", "mjpeg"):
            return await self._camera(request, segments, ha)
        if head == "camera-proxy" and request.method == "GET":
            return await self._camera_proxy(request, ha)
        return _err("Not found", 404)

    async def _assist_pipelines(self, request) -> web.Response:
        """List available Assist pipelines (backs the SPA's voice助手 picker)."""
        hass: HomeAssistant = request.app["hass"]
        pipelines: list[dict[str, Any]] = []
        try:
            from homeassistant.components.assist_pipeline import async_get_pipelines

            for pipeline in async_get_pipelines(hass):
                pipelines.append({
                    "id": pipeline.id,
                    "name": pipeline.name or pipeline.id,
                    "language": pipeline.language,
                })
        except Exception:  # noqa: BLE001 - assist_pipeline may be unavailable
            _LOGGER.debug("assist_pipeline not available", exc_info=True)
        return _ok({"pipelines": pipelines})

    async def _conversation(self, request, ha: HaClient) -> web.Response:
        from homeassistant.helpers import config_validation as cv
        import voluptuous as vol

        schema = vol.Schema({
            vol.Required("text"): str,
            vol.Optional("language"): str,
            vol.Optional("conversation_id"): str,
            vol.Optional("device_id"): str,
            vol.Optional("pipeline_id"): str,
        })
        try:
            data = schema(await _json(request))
        except vol.Invalid as err:
            return _err(str(err), 400)
        hass: HomeAssistant = request.app["hass"]
        text = data["text"]
        pipeline_id = data.get("pipeline_id")
        if pipeline_id and pipeline_id.startswith("mock-"):
            return _ok({"response": {"speech": {"plain": {"speech": f"（Mock）已收到：{text}"}}, "response_type": "action_done"}})
        service = "assist_pipeline.run" if pipeline_id else "conversation.process"
        domain, svc = service.split(".")
        svc_data: dict[str, Any] = {"text": text}
        if data.get("language"):
            svc_data["language"] = data["language"]
        if data.get("conversation_id"):
            svc_data["conversation_id"] = data["conversation_id"]
        if pipeline_id:
            svc_data["pipeline"] = pipeline_id
        try:
            result = await hass.services.async_call(domain, svc, svc_data, blocking=True, return_response=True)
        except Exception as err:  # noqa: BLE001
            return _err(str(err), 502)
        return _ok({"response": result})

    async def _camera(self, request, segments, ha: HaClient) -> web.Response:
        # Best-effort: delegate to HA camera proxy for snapshot/mjpeg.
        entity_id = segments[1]
        kind = segments[-1]
        from homeassistant.components.camera import async_get_image

        if kind == "snapshot":
            try:
                image = await async_get_image(request.app["hass"], entity_id)
            except Exception as err:  # noqa: BLE001
                return _err(str(err), 502)
            return web.Response(body=image.content, content_type=image.content_type)
        return _err("Camera stream requires the standalone/docker build", 501)

    async def _camera_proxy(self, request, ha: HaClient) -> web.Response:
        path = request.query.get("path", "")
        if not path.startswith("/") or ".." in path or path.startswith("//"):
            return _err("Invalid camera proxy path", 400)
        from homeassistant.components import camera as camera_comp

        hass: HomeAssistant = request.app["hass"]
        # Proxy via HA's own camera_proxy view where possible.
        try:
            if path.startswith("/api/camera_proxy"):
                entity_id = path.rsplit("/", 1)[-1]
                image = await camera_comp.async_get_image(hass, entity_id)
                return web.Response(body=image.content, content_type=image.content_type)
        except Exception as err:  # noqa: BLE001
            return _err(str(err), 502)
        return _err("Unsupported camera path", 400)

    async def _handle_projects(self, request, segments, store: ProjectStore) -> web.Response:
        method = request.method
        if not segments:
            if method == "GET":
                return _ok({"projects": store.list_projects()})
            if method == "POST":
                body = await _json(request)
                try:
                    project = await store.create_project(body)
                except ValueError as err:
                    return _err(str(err), 400)
                return _ok({"project": project}, 201)
            return _err("Method not allowed", 405)
        # /api/projects/current
        if segments[0] == "current" and method == "GET":
            project = store.get_project()
            if not project:
                return _err("Project not found", 404)
            return _ok({"project": project})
        # /api/projects/:id[/export|/import|/backups...|/blueprints|/reset]
        pid = segments[0]
        if len(segments) == 1:
            if method == "GET":
                project = store.get_project(pid)
                if not project:
                    return _err("Project not found", 404)
                return _ok({"project": project})
            if method == "PUT":
                body = await _json(request)
                if body.get("id") != pid:
                    return _err("Project id mismatch", 400)
                try:
                    saved = await store.save_project(body)
                except ValueError as err:
                    return _err(str(err), 400)
                _broadcast_project(request.app["hass"], saved)
                return _ok({"project": saved})
            if method == "DELETE":
                try:
                    if not await store.delete_project(pid):
                        return _err("Project not found", 404)
                except ValueError as err:
                    return _err(str(err), 409)
                return web.Response(status=204)
            return _err("Method not allowed", 405)
        sub = segments[1]
        if sub == "export" and method in ("GET", "POST"):
            project = store.get_project(pid)
            if not project:
                return _err("Project not found", 404)
            # Attach the room card configuration (removed devices + manual card
            # order) so importing this JSON restores the device lists as well.
            # It is a sibling key, not a project field: the project schema is a
            # whitelist and would drop it on import.
            payload = {
                **project,
                EXPORT_LAYOUTS_KEY: store.get_layouts(pid),
            }
            return web.Response(
                text=json.dumps(payload, ensure_ascii=False),
                content_type="application/json",
                headers={"content-disposition": f"attachment; filename=ha3d-{project['id']}.json"},
            )
        if sub == "import" and method == "POST":
            body = await _json(request)
            try:
                saved = await store.import_project(pid, body)
            except ValueError as err:
                return _err(str(err), 400)
            _broadcast_project(request.app["hass"], saved)
            return _ok({"project": saved})
        if sub == "reset" and method == "POST":
            try:
                saved = await store.reset(pid)
            except ValueError as err:
                return _err(str(err), 400)
            _broadcast_project(request.app["hass"], saved)
            return _ok({"project": saved})
        if sub == "blueprints" and method == "POST":
            body = await _json(request)
            if not isinstance(body.get("dataUrl"), str) or not body["dataUrl"].startswith("data:image/"):
                return _err("Expected image data URL", 400)
            try:
                saved = await store.apply_blueprint(pid, body)
            except ValueError as err:
                return _err(str(err), 400)
            _broadcast_project(request.app["hass"], saved)
            return _ok({"project": saved, "assetId": saved["assets"][-1]["id"]})
        if sub == "backups" and method == "GET":
            return _ok({"backups": store.list_backups(pid)})
        # 备份恢复兼容两种 URL（响应契约 _ok({"project": ...}) / _err(..., 400) 不变）：
        #   POST /projects/:id/backups/:backupId/restore -> SPA 现用（4 段，id 在路径里，无 body）
        #   POST /projects/:id/backups/restore            -> 3 段，id 放 JSON body
        # 为何：旧代码把条件里已判定为字符串 "restore" 的 segments[2] 当 backup id
        # 传给 restore_backup，必然 ValueError("Invalid backup id") -> 恒 400。
        if (
            sub == "backups"
            and method == "POST"
            and len(segments) in (3, 4)
            and segments[-1] == "restore"
        ):
            backup_id: str | None = None
            if len(segments) == 4:
                # 前端 app.js 的 restoreProjectBackup 走 /backups/:backupId/restore。
                backup_id = segments[2]
            else:
                # 3 段路径：从 body 读取 backup id，字段名兼容多种写法；
                # _json() 在解析失败时返回 {}，下面统一校验类型。
                body = await _json(request)
                for key in ("backupId", "id", "backup_id"):
                    value = body.get(key)
                    if isinstance(value, str) and value.strip():
                        backup_id = value.strip()
                        break
            if not backup_id:
                return _err("backupId is required (non-empty string)", 400)
            try:
                saved = await store.restore_backup(pid, backup_id)
            except ValueError as err:
                return _err(str(err), 400)
            return _ok({"project": saved})
        return _err("Not found", 404)

    async def _handle_assets(self, request, segments, store: ProjectStore) -> web.Response:
        method = request.method
        if not segments:
            if method == "GET":
                return _ok({"assets": store.list_assets()})
            if method == "POST":
                body = await _json(request)
                if body.get("type") not in ("image", "model", "texture") or not body.get("name") or not body.get("url"):
                    return _err("Invalid asset body", 400)
                try:
                    asset = await store.add_asset(body)
                except ValueError as err:
                    return _err(str(err), 400)
                return _ok({"asset": asset}, 201)
            return _err("Method not allowed", 405)
        asset_id = segments[0]
        if method == "GET":
            asset = store.get_asset(asset_id)
            if not asset:
                return _err("Asset not found", 404)
            return _ok({"asset": asset})
        if method == "DELETE":
            try:
                asset = await store.delete_asset(asset_id)
            except ValueError as err:
                return _err(str(err), 400)
            if not asset:
                return _err("Asset not found", 404)
            return web.Response(status=204)
        return _err("Method not allowed", 405)

    # HomeAssistantView requires get/post methods
    async def get(self, request: web.Request, path: str) -> web.Response:
        return await self._dispatch(request, path)

    async def post(self, request: web.Request, path: str) -> web.Response:
        return await self._dispatch(request, path)

    async def put(self, request: web.Request, path: str) -> web.Response:
        return await self._dispatch(request, path)

    async def delete(self, request: web.Request, path: str) -> web.Response:
        return await self._dispatch(request, path)


class ThreeDHomeStaticView(HomeAssistantView):
    """Serve the prebuilt SPA from ``www/`` (SPA-friendly fallback)."""

    name = "api:evinchan_ha_3d_home:static"
    url = f"{API_PREFIX}/{{path:.*}}"
    requires_auth = False

    async def get(self, request: web.Request, path: str) -> web.Response:
        # Never intercept API or WS traffic.
        if path.startswith("api/") or path == "ws":
            return web.Response(status=404, text="Not found")
        rel = path or "index.html"
        hass: HomeAssistant = request.app["hass"]
        # File access must not happen on the event loop: HA flags blocking calls.
        body, full, etag, last_modified = await hass.async_add_executor_job(
            _read_static_with_meta, rel
        )
        if body is None:
            return web.Response(status=404, text="Frontend not built yet.")
        # Cache policy is decided by ``full`` (the file actually served), NOT by
        # ``rel``: _read_static falls back to index.html for unknown/deep routes.
        cache = _cache_control_for(full)
        validators = _validator_headers(etag, last_modified)
        if _not_modified(request, validators):
            # 304 carries no body / no Content-Type, but MUST repeat the
            # validators and Cache-Control so caches refresh their metadata.
            return web.Response(status=304, headers={"Cache-Control": cache, **validators})
        # aiohttp rejects a ``charset`` inside ``content_type``; pass the full
        # MIME string (which may include charset) via the header instead.
        return web.Response(
            body=body,
            headers={
                "Content-Type": _guess_type(full),
                "Cache-Control": cache,
                **validators,
            },
        )


def _now_iso() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _json(request: web.Request) -> dict:
    try:
        result = await request.json()
    except Exception:  # noqa: BLE001
        return {}
    # 为何：body 可能是 [] / null / 字符串；3 段 /backups/restore 分支里
    # body.get(...) 会对非 dict 抛 AttributeError -> 500，统一收敛为 {}。
    if not isinstance(result, dict):
        return {}
    return result


async def async_setup_views(hass: HomeAssistant) -> None:
    """Register API + static views (API must be registered before static)."""
    hass.http.register_view(ThreeDHomeApiView())
    hass.http.register_view(ThreeDHomeStaticView())
