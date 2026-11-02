"""Persistent project/asset storage for the 3D Home integration.

Stores everything in a single HA ``Store`` value:

    {
      "current": "<project-id>",
      "projects": { "<id>": <project>, ... },
      "backups": { "<id>": { "<backupId>.json": <project>, ... } },
      "layouts": { "<project-id>": { "<roomId>": <layout> } }
    }

``layouts`` holds the per-room device-card configuration (which devices the
user removed, and in what order the rest are shown). It lives on the server so
the same list appears on every browser / device instead of being trapped in
one browser's localStorage.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store

from .const import DOMAIN, STORAGE_PROJECTS_KEY, STORAGE_PROJECTS_VERSION
from .schema import (
    normalize_floorplan_project,
    sample_project,
    validate_floorplan_project,
)

_LOGGER = logging.getLogger(__name__)

_BACKUP_PREFIX = "backup-"


def _normalize_layout(raw: Any) -> dict[str, Any]:
    """Keep only the two fields the room panel cares about.

    ``hidden``  — entity ids the user removed from the room's card list.
    ``order``   — manual display order of the remaining entity ids.
    Both are stored as plain lists so the JSON payload stays simple and stable
    across frontend versions.
    """
    if not isinstance(raw, dict):
        return {"hidden": [], "order": []}

    def _ids(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        seen: set[str] = set()
        out: list[str] = []
        for item in value:
            if isinstance(item, str) and item and item not in seen:
                seen.add(item)
                out.append(item)
        return out

    return {"hidden": _ids(raw.get("hidden")), "order": _ids(raw.get("order"))}


# Key used inside an exported project JSON to carry the room card layouts
# alongside the floor plan. It is a sibling of the project fields, never part of
# the project itself: ``normalize_floorplan_project`` rebuilds the project from a
# whitelist and would silently drop an unknown key.
EXPORT_LAYOUTS_KEY = "roomLayouts"


def _extract_layouts(payload: dict[str, Any]) -> dict[str, dict[str, Any]] | None:
    """Pull the room layouts out of an imported project JSON.

    Returns ``None`` when the payload carries no layout section at all, which
    means "leave the existing layouts alone". An explicit empty object means
    "the export had no customised rooms", which clears them.
    """
    if not isinstance(payload, dict):
        return None
    raw = payload.get(EXPORT_LAYOUTS_KEY)
    if raw is None:
        return None
    if not isinstance(raw, dict):
        return {}
    return {
        room_id: _normalize_layout(layout)
        for room_id, layout in raw.items()
        if isinstance(room_id, str) and room_id
    }


class ProjectStore:
    """Manage floor-plan projects, assets and backups."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store = Store(hass, STORAGE_PROJECTS_VERSION, STORAGE_PROJECTS_KEY)
        self._data: dict[str, Any] = {"current": None, "projects": {}, "backups": {}}

    async def async_setup(self) -> None:
        """Load persisted data, seeding the demo project when empty."""
        loaded = await self._store.async_load()
        if isinstance(loaded, dict):
            self._data = {
                "current": loaded.get("current"),
                "projects": loaded.get("projects", {}) or {},
                "backups": loaded.get("backups", {}) or {},
                "layouts": loaded.get("layouts", {}) or {},
            }
        self._data.setdefault("layouts", {})
        if not self._data["projects"]:
            project = normalize_floorplan_project(sample_project)
            self._data["projects"][project["id"]] = project
            self._data["current"] = project["id"]
            await self._persist()

    async def _persist(self) -> None:
        await self._store.async_save(self._data)

    # ---- queries -------------------------------------------------------
    def list_projects(self) -> list[dict[str, Any]]:
        projects = list(self._data["projects"].values())
        current = self._data["current"]
        projects.sort(
            key=lambda p: (
                0 if p["id"] == current else 1,
                p.get("updatedAt", ""),
            ),
            reverse=True,
        )
        return [
            {
                "id": p["id"],
                "name": p["name"],
                "updatedAt": p.get("updatedAt"),
                "current": p["id"] == current,
            }
            for p in projects
        ]

    def get_project(self, project_id: str | None = None) -> dict[str, Any] | None:
        pid = project_id or self._data["current"]
        return self._data["projects"].get(pid)

    def get_current_project_id(self) -> str | None:
        return self._data["current"]

    def list_assets(self, project_id: str | None = None) -> list[dict[str, Any]]:
        return self.get_project(project_id).get("assets", []) if self.get_project(project_id) else []

    def get_asset(self, asset_id: str, project_id: str | None = None) -> dict[str, Any] | None:
        project = self.get_project(project_id)
        if not project:
            return None
        return next((a for a in project.get("assets", []) if a["id"] == asset_id), None)

    # ---- mutations -----------------------------------------------------
    async def create_project(self, input: dict[str, Any]) -> dict[str, Any]:
        source_id = input.get("sourceProjectId")
        source = self._data["projects"].get(source_id) if source_id else None
        import copy

        base = copy.deepcopy(source) if source else copy.deepcopy(sample_project)
        timestamp = self._iso_now()
        project = normalize_floorplan_project(
            {
                **base,
                "id": f"project-{self._uid()}",
                "name": (input.get("name") or "").strip()
                or (f"{source['name']} 副本" if source else "未命名户型"),
                "createdAt": timestamp,
                "updatedAt": timestamp,
            }
        )
        self._data["projects"][project["id"]] = project
        self._data["current"] = project["id"]
        await self._persist()
        return project

    async def save_project(self, project: dict[str, Any]) -> dict[str, Any]:
        if project.get("id") not in self._data["projects"]:
            raise ValueError("Project not found")
        validation = validate_floorplan_project(project)
        if not validation["valid"] or not validation.get("project"):
            raise ValueError("; ".join(validation.get("issues", [])) or "Invalid project")
        saved = {**validation["project"], "updatedAt": self._iso_now()}
        await self._create_backup(saved["id"])
        self._data["projects"][saved["id"]] = saved
        if saved["id"] == self._data["current"]:
            self._data["current"] = saved["id"]
        await self._persist()
        return saved

    async def delete_project(self, project_id: str) -> bool:
        if project_id not in self._data["projects"]:
            return False
        if len(self._data["projects"]) <= 1:
            raise ValueError("At least one project is required")
        del self._data["projects"][project_id]
        self._data["backups"].pop(project_id, None)
        self._data.get("layouts", {}).pop(project_id, None)
        if self._data["current"] == project_id:
            self._data["current"] = next(iter(self._data["projects"]))
        await self._persist()
        return True

    # ---- room card layouts ---------------------------------------------
    # The room panel lets the user hide devices and drag cards into a custom
    # order. Both belong to the project (they describe how *this* floor plan
    # presents its devices), and both are server-side so they follow the user
    # across browsers.
    def get_layouts(self, project_id: str | None = None) -> dict[str, Any]:
        """Return ``{roomId: {"hidden": [...], "order": [...]}}``."""
        pid = project_id or self._data["current"]
        layouts = self._data.get("layouts", {}).get(pid) or {}
        return {
            room_id: _normalize_layout(layout)
            for room_id, layout in layouts.items()
            if isinstance(room_id, str)
        }

    def get_layout(self, room_id: str, project_id: str | None = None) -> dict[str, Any]:
        return self.get_layouts(project_id).get(
            room_id, {"hidden": [], "order": []}
        )

    async def save_layout(
        self, room_id: str, layout: dict[str, Any], project_id: str | None = None
    ) -> dict[str, Any]:
        pid = project_id or self._data["current"]
        if pid not in self._data["projects"]:
            raise ValueError("Project not found")
        if not isinstance(room_id, str) or not room_id.strip():
            raise ValueError("roomId is required")
        normalized = _normalize_layout(layout)
        # A layout with nothing in it carries no information; drop it so the
        # store does not accumulate empty room entries forever.
        room_layouts = self._data.setdefault("layouts", {}).setdefault(pid, {})
        if normalized["hidden"] or normalized["order"]:
            room_layouts[room_id] = normalized
        else:
            room_layouts.pop(room_id, None)
        await self._persist()
        return normalized

    async def save_layouts(
        self, layouts: dict[str, Any], project_id: str | None = None
    ) -> dict[str, Any]:
        """Replace a project's whole layout map (used by JSON import).

        Unlike ``save_layout`` this is a full replacement: rooms that are absent
        from the payload are cleared, so importing a JSON restores the exported
        state exactly instead of merging into whatever was there before.
        """
        pid = project_id or self._data["current"]
        if pid not in self._data["projects"]:
            raise ValueError("Project not found")
        cleaned: dict[str, Any] = {}
        if isinstance(layouts, dict):
            for room_id, layout in layouts.items():
                if not isinstance(room_id, str) or not room_id.strip():
                    continue
                normalized = _normalize_layout(layout)
                # Empty rooms carry no information; do not persist them.
                if normalized["hidden"] or normalized["order"]:
                    cleaned[room_id] = normalized
        self._data.setdefault("layouts", {})[pid] = cleaned
        await self._persist()
        return self.get_layouts(pid)

    async def reset(self, project_id: str | None = None) -> dict[str, Any]:
        pid = project_id or self._data["current"]
        if pid not in self._data["projects"]:
            raise ValueError("Project not found")
        await self._create_backup(pid)
        now = self._iso_now()
        project = normalize_floorplan_project(
            {
                **sample_project,
                "id": pid,
                "createdAt": self._data["projects"][pid].get("createdAt", now),
                "updatedAt": now,
            }
        )
        self._data["projects"][pid] = project
        await self._persist()
        return project

    async def add_asset(self, input: dict[str, Any], project_id: str | None = None) -> dict[str, Any]:
        project = self.get_project(project_id)
        if not project:
            raise ValueError("Project not found")
        asset = {**input, "id": f"asset-{self._uid()}"}
        project.setdefault("assets", []).append(asset)
        await self.save_project(project)
        return asset

    async def delete_asset(self, asset_id: str, project_id: str | None = None) -> dict[str, Any] | None:
        project = self.get_project(project_id)
        if not project:
            raise ValueError("Project not found")
        asset = next((a for a in project.get("assets", []) if a["id"] == asset_id), None)
        if not asset:
            return None
        project["assets"] = [a for a in project.get("assets", []) if a["id"] != asset_id]
        await self.save_project(project)
        return asset

    async def apply_blueprint(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        project = self.get_project(project_id)
        if not project:
            raise ValueError("Project not found")
        import base64

        asset_id = f"blueprint-{self._uid()}"
        asset = {
            "id": asset_id,
            "type": "image",
            "name": payload.get("name", "floorplan"),
            "url": payload.get("dataUrl", ""),
            "metadata": {
                "kind": "floorplan-reference",
                "opacity": payload.get("opacity", 0.34),
                "scaleMeters": payload.get("scaleMeters", 1),
                "aspectRatio": payload.get("aspectRatio"),
                "scalePercent": payload.get("scalePercent", 100),
                "worldX": payload.get("worldX"),
                "worldY": payload.get("worldY"),
                "worldWidth": payload.get("worldWidth"),
                "worldHeight": payload.get("worldHeight"),
            },
        }
        project["assets"] = [
            a for a in project.get("assets", []) if a.get("metadata", {}).get("kind") != "floorplan-reference"
        ] + [asset]
        return await self.save_project(project)

    async def import_project(self, project_id: str | None, payload: dict[str, Any]) -> dict[str, Any]:
        pid = project_id or self._data["current"]
        if pid not in self._data["projects"]:
            raise ValueError("Project not found")
        current = self._data["projects"][pid]
        if not isinstance(payload, dict):
            raise ValueError("Invalid project")
        # Room card layouts travel next to the project fields in the exported
        # JSON; peel them off before the project validator sees the payload so
        # they can never leak into the stored project object.
        layouts = _extract_layouts(payload)
        project_payload = {
            key: value
            for key, value in payload.items()
            if key != EXPORT_LAYOUTS_KEY
        }
        merged = {**project_payload, "id": pid, "createdAt": current.get("createdAt")}
        saved = await self.save_project(merged)
        if layouts is not None:
            await self.save_layouts(layouts, pid)
        return saved

    # ---- backups -------------------------------------------------------
    async def _create_backup(self, project_id: str) -> None:
        project = self._data["projects"].get(project_id)
        if not project:
            return
        self._data.setdefault("backups", {}).setdefault(project_id, {})
        backup_id = f"{_BACKUP_PREFIX}{self._now_ms()}"
        self._data["backups"][project_id][backup_id] = dict(project)
        # keep at most 12 backups per project
        ids = sorted(self._data["backups"][project_id].keys())
        for old in ids[:-12]:
            self._data["backups"][project_id].pop(old, None)

    def list_backups(self, project_id: str | None = None) -> list[dict[str, Any]]:
        pid = project_id or self._data["current"]
        backups = self._data.get("backups", {}).get(pid, {})
        return [
            {"id": bid, "createdAt": self._ms_to_iso(int(bid[len(_BACKUP_PREFIX):]))}
            for bid in sorted(backups.keys(), reverse=True)
        ]

    async def restore_backup(self, project_id: str, backup_id: str) -> dict[str, Any]:
        pid = project_id or self._data["current"]
        if pid not in self._data["projects"]:
            raise ValueError("Project not found")
        backup = self._data.get("backups", {}).get(pid, {}).get(backup_id)
        if not backup:
            raise ValueError("Invalid backup id")
        await self._create_backup(pid)
        project = normalize_floorplan_project(
            {
                **backup,
                "id": pid,
                "createdAt": self._data["projects"][pid].get("createdAt"),
                "updatedAt": self._iso_now(),
            }
        )
        self._data["projects"][pid] = project
        await self._persist()
        return project

    # ---- helpers -------------------------------------------------------
    @staticmethod
    def _uid() -> str:
        import base64

        return base64.urlsafe_b64encode(str(__import__("time").time_ns()).encode()).decode().rstrip("=")

    @staticmethod
    def _iso_now() -> str:
        import datetime

        return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    @staticmethod
    def _now_ms() -> int:
        return __import__("time").time_ns() // 1_000_000

    @staticmethod
    def _ms_to_iso(ms: int) -> str:
        import datetime

        return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@callback
def async_setup_store(hass: HomeAssistant) -> ProjectStore:
    """Create and register the project store on the hass object."""
    stores = hass.data.setdefault(DOMAIN, {})
    if "project_store" not in stores:
        stores["project_store"] = ProjectStore(hass)
    return stores["project_store"]
