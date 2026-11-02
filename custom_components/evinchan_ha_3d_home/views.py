"""HTTP views: serve the built frontend and expose the 3D Home REST API.

All API routes are mounted under ``/api/evinchan_ha_3d_home/api/`` and mirror the
Add-on's Fastify endpoints so the unmodified prebuilt SPA (which derives its
base path from ``window.location.pathname``) works without rebuild.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import API_PREFIX, DOMAIN
from .ha_client import HaClient
from .project_store import EXPORT_LAYOUTS_KEY, ProjectStore

_LOGGER = logging.getLogger(__name__)

WWW_PATH = os.path.join(os.path.dirname(__file__), "www")

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


def _read_static(rel: str) -> tuple[bytes | None, str]:
    """Read a file from ``www/`` with SPA fallback.

    Runs in the executor (never on the event loop). Returns ``(None, path)`` when
    the frontend build is missing.
    """
    full = os.path.normpath(os.path.join(WWW_PATH, rel))
    if not full.startswith(WWW_PATH) or not os.path.isfile(full):
        full = os.path.join(WWW_PATH, "index.html")
        if not os.path.isfile(full):
            return None, full
    try:
        with open(full, "rb") as fh:
            return fh.read(), full
    except OSError:
        return None, full


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
        if head == "binding-suggestions" and request.method == "GET":
            project = store.get_project()
            if not project:
                return _err("Project not found", 404)
            return _ok({"suggestions": ha.get_room_binding_suggestions(project)})
        if head == "binding-suggestions" and request.method == "POST":
            return await self._apply_binding_suggestions(request, ha, store)
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

    async def _apply_binding_suggestions(self, request, ha: HaClient, store: ProjectStore) -> web.Response:
        import copy
        import re

        body = await _json(request)
        suggestions_in = body.get("suggestions", [])
        if not isinstance(suggestions_in, list) or not suggestions_in:
            return _err("suggestions 不能为空", 400)
        project = store.get_project()
        if not project:
            return _err("Project not found", 404)
        allowed = ha.get_room_binding_suggestions(project)
        allowed_keys = {
            f"{s['floorId']}:{s['roomId']}:{s['areaId']}:{','.join(sorted(s['entityIds']))}"
            for s in allowed
        }
        confirmed = [
            s for s in suggestions_in
            if f"{s.get('floorId')}:{s.get('roomId')}:{s.get('areaId')}:{','.join(sorted(s.get('entityIds', [])))}" in allowed_keys
        ]
        if not confirmed:
            return _err("No valid binding suggestion selected", 400)
        entities = {e["entityId"]: e for e in ha.get_entities()}
        placed = {d["entityId"] for f in project["floors"] for d in f.get("devices", [])}
        next_project = copy.deepcopy(project)
        for suggestion in confirmed:
            floor = next((f for f in next_project["floors"] if f["id"] == suggestion["floorId"]), None)
            room = next((r for r in floor.get("rooms", []) if r["id"] == suggestion["roomId"]), None) if floor else None
            if not floor or not room or any(d.get("roomId") == room["id"] for d in floor.get("devices", [])):
                continue
            poly = room.get("polygon", []) or [[0, 0], [1, 1], [1, 0], [0, 1]]
            cx = sum(p[0] for p in poly) / len(poly)
            cy = sum(p[1] for p in poly) / len(poly)
            for entity_id in suggestion["entityIds"]:
                if entity_id in placed:
                    continue
                entity = entities.get(entity_id)
                if not entity:
                    continue
                floor["devices"].append({
                    "id": f"device-{int(__import__('time').time() * 1000)}-{len(floor['devices'])}",
                    "entityId": entity_id,
                    "kind": _KIND_FROM_DOMAIN.get(entity["domain"], "custom"),
                    "floorId": floor["id"],
                    "roomId": room["id"],
                    "position": [cx, 2.3 if entity["domain"] == "light" else 1.2, cy],
                    "rotation": [0, 0, 0],
                })
                placed.add(entity_id)
        saved = await store.save_project(next_project)
        _broadcast_project(request.app["hass"], saved)
        return _ok({"project": saved})

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
        if sub == "backups" and len(segments) == 3 and segments[2] == "restore" and method == "POST":
            try:
                saved = await store.restore_backup(pid, segments[2])
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
        body, full = await hass.async_add_executor_job(_read_static, rel)
        if body is None:
            return web.Response(status=404, text="Frontend not built yet.")
        # aiohttp rejects a ``charset`` inside ``content_type``; pass the full
        # MIME string (which may include charset) via the header instead.
        # Always revalidate: stale index.html would pin an outdated asset set.
        return web.Response(
            body=body,
            headers={
                "Content-Type": _guess_type(full),
                "Cache-Control": "no-cache, must-revalidate",
            },
        )


def _now_iso() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _json(request: web.Request) -> dict:
    try:
        return await request.json()
    except Exception:  # noqa: BLE001
        return {}


async def async_setup_views(hass: HomeAssistant) -> None:
    """Register API + static views (API must be registered before static)."""
    hass.http.register_view(ThreeDHomeApiView())
    hass.http.register_view(ThreeDHomeStaticView())
