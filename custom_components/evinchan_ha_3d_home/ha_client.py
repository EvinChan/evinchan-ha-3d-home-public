"""In-process replacement for the Add-on's ``HomeAssistantClient``.

Runs inside HA Core and reads/writes entity state directly via ``hass``. There
is no remote connection, URL, or token to configure: every LAN/HA entity the
instance knows about is already available in-process.
"""

from __future__ import annotations

import enum
import logging
import time
from typing import Any, Callable

from homeassistant.const import ATTR_FRIENDLY_NAME, EVENT_STATE_CHANGED
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry, device_registry, entity_registry

_LOGGER = logging.getLogger(__name__)

SUPPORTED_DOMAINS = {
    "light", "switch", "cover", "climate", "sensor", "binary_sensor",
    "camera", "fan", "media_player", "alarm_control_panel",
}

# Attributes the 3D panel never renders (icons come from name->icon maps, and
# friendly_name is already promoted to the top-level ``name``). Dropping them
# shrinks every ``ha/entities`` payload with zero UX impact.
_SAFE_DROP_ATTRS: tuple[str, ...] = ("attribution", "friendly_name")
# Extra bulky attributes removed only in ``?slim=1`` mode (weak devices).
_SLIM_DROP_ATTRS: tuple[str, ...] = ("entity_picture",)


def _json_safe(value: Any) -> Any:
    """Recursively convert HA values into JSON-serialisable primitives.

    Entity attributes can contain ``datetime``/``date``/``time``/``Decimal``/
    ``set``/``bytes`` objects depending on the integration that produced them.
    ``web.json_response`` would raise on those, breaking the entire endpoint, so
    everything is coerced into str/int/float/bool/None/list/dict.
    """
    # Enums must be handled before the int/str shortcuts: HA uses IntFlag for
    # things like CoverEntityFeature, and StrEnum values are still str subclasses
    # that must not leak their ``str()`` representation.
    if isinstance(value, enum.Enum):
        # IntFlag/IntEnum keep their numeric value (used by the SPA for bitmasks);
        # other enums expose their plain value when serialisable.
        if isinstance(value, enum.IntFlag):
            return int(value)
        raw = value.value
        if isinstance(raw, (bool, int, float, str)):
            return raw
        return value.name
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(v) for v in value]
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")
    # datetime/date/time/Decimal/timedelta/Enum/anything else
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return isoformat()
        except Exception:  # noqa: BLE001
            pass
    return str(value)


class HaClient:
    """Bridge between the 3D Home backend and Home Assistant state."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.entities: dict[str, dict[str, Any]] = {}
        self.areas: dict[str, dict[str, Any]] = {}
        self.registry_by_entity: dict[str, dict[str, str | None]] = {}
        self._listeners: list[Callable[[dict[str, Any]], None]] = []
        self._unsub: Callable[[], None] | None = None
        self._weather_dirty: bool = False
        self._weather_timer: Any | None = None
        # Short-TTL cache for the (expensive) full entity list. Live changes still
        # arrive via WebSocket, so a brief cache only avoids re-serialising the
        # entire state machine on every reconnect / panel re-open.
        self._entities_cache: list[dict[str, Any]] | None = None
        self._entities_cache_ts: float = 0.0

    # ---- lifecycle -----------------------------------------------------
    async def async_setup(self) -> None:
        self.sync_from_hass()
        # Listen on the EVENT_STATE_CHANGED bus so *every* entity is covered.
        # async_track_state_change_event(hass, [], cb) would register an
        # empty listener and silently never fire.
        self._unsub = self.hass.bus.async_listen(
            EVENT_STATE_CHANGED, self._on_state_change
        )
        _LOGGER.debug("State listener registered on %s", EVENT_STATE_CHANGED)
        # Populate weather forecasts once on startup (frontend reads entity
        # attributes.forecast to render weather widgets).
        self.hass.async_create_task(self.refresh_weather_forecasts())

    async def async_unload(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None

    def on_broadcast(self, listener: Callable[[dict[str, Any]], None]) -> None:
        self._listeners.append(listener)

    def _broadcast(self, event: dict[str, Any]) -> None:
        for listener in self._listeners:
            try:
                listener(event)
            except Exception:  # pragma: no cover - defensive
                _LOGGER.exception("ha broadcast listener failed")

    # ---- sync ----------------------------------------------------------
    def sync_from_hass(self) -> None:
        area_reg = area_registry.async_get(self.hass)
        dev_reg = device_registry.async_get(self.hass)
        ent_reg = entity_registry.async_get(self.hass)

        self.areas = {
            area.id: {"id": area.id, "name": area.name}
            for area in area_reg.areas.values()
        }
        device_area = {dev.id: dev.area_id for dev in dev_reg.devices.values()}
        self.registry_by_entity = {}
        for entry in ent_reg.entities.values():
            self.registry_by_entity[entry.entity_id] = {
                "deviceId": entry.device_id,
                "areaId": entry.area_id
                or (device_area.get(entry.device_id) if entry.device_id else None),
            }
        for state in self.hass.states.async_all():
            try:
                self.entities[state.entity_id] = self._to_entity(state)
            except Exception:  # noqa: BLE001 - never let one entity abort the sync
                _LOGGER.debug("Skipping entity %s", state.entity_id, exc_info=True)

    @callback
    def _on_state_change(self, event) -> None:
        new_state = event.data.get("new_state")
        if not new_state:
            # Entity removed from the state machine.
            old_state = event.data.get("old_state")
            if old_state is not None:
                self.entities.pop(old_state.entity_id, None)
            return

        entity_id = new_state.entity_id
        prev = self.entities.get(entity_id)
        # Fast path: identical state/attributes means nothing to convert or push.
        # ``new_state.attributes`` holds raw HA values (enums, datetimes...), so it
        # must be normalised before comparing with our cached JSON-safe copy --
        # otherwise the comparison is always False for entities with enum
        # attributes (e.g. supported_features). Even when it matches, compare the
        # state too: HA may reuse a timestamp while the state itself changed.
        if (
            prev is not None
            and prev.get("state") == str(new_state.state)
            and prev.get("attributes") == _json_safe(new_state.attributes)
        ):
            return

        try:
            entity = self._to_entity(new_state)
        except Exception as err:  # noqa: BLE001 - never break the event bus
            _LOGGER.debug("Failed to convert %s: %r", entity_id, err)
            return
        self.entities[entity_id] = entity
        self._broadcast({"type": "ha.entity_updated", "payload": entity})
        self._sync_cover_position(entity)
        if entity["domain"] == "weather":
            self._schedule_weather_refresh()

    def _sync_cover_position(self, entity: dict[str, Any]) -> None:
        """Mirror a companion position sensor onto its cover entity.

        Some curtain integrations (e.g. the ADP curtain robot) expose the live
        opening percentage only through a companion ``sensor`` such as
        ``sensor.<device>_current_position`` while the ``cover`` entity itself is
        updated rarely. The SPA renders the curtain purely from the cover's
        ``attributes.current_position``, so we propagate the sensor value and the
        derived state to the cover of the same device.
        """
        domain = entity["domain"]
        if domain not in ("sensor", "event"):
            return
        entity_id = entity["entityId"]
        device_id = entity.get("deviceId")
        if not device_id:
            return

        position: int | None = None
        if "position" in entity_id.lower():
            try:
                position = int(float(entity["state"]))
            except (TypeError, ValueError):
                return
        elif domain == "event":
            # "窗帘已打开" / "窗帘已关闭" completion events.
            event_type = str(entity.get("attributes", {}).get("event_type", ""))
            if "已打开" in event_type or "opened" in event_type.lower():
                position = 100
            elif "已关闭" in event_type or "closed" in event_type.lower():
                position = 0
            else:
                return
        else:
            # Working-status sensor: Opening/Closing/Stanby.
            state = str(entity["state"]).lower()
            if state == "opening":
                position = 100
            elif state == "closing":
                position = 0
            else:
                return

        position = max(0, min(100, position))

        for other_id, cover in list(self.entities.items()):
            if (
                cover.get("domain") != "cover"
                or cover.get("deviceId") != device_id
                or cover.get("attributes", {}).get("current_position") == position
            ):
                continue
            state = "open" if position > 0 else "closed"
            updated = {
                **cover,
                "state": state,
                "attributes": {**cover["attributes"], "current_position": position},
            }
            self.entities[other_id] = updated
            _LOGGER.debug(
                "Mirrored position %s%% from %s to %s", position, entity_id, other_id
            )
            self._broadcast({"type": "ha.entity_updated", "payload": updated})

    # ---- reads ---------------------------------------------------------
    def status(self) -> dict[str, Any]:
        """Report status for the SPA.

        In integration mode there is no separate HA connection to establish: the
        integration runs inside HA Core and reads state from the in-process
        ``hass`` object. The connection fields are therefore always reported as
        already satisfied and no re-authentication/reconnect is ever required.
        """
        return {
            "mode": "integration",
            "configured": True,
            "connected": True,
            "mock": False,
            "reconnecting": False,
            "entityCount": len(self.entities),
            "areaCount": len(self.areas),
            "canConfigure": False,
            "requiresAuth": False,
            "error": None,
        }

    def get_entities(self, slim: bool = False) -> list[dict[str, Any]]:
        """Return every entity currently known to HA.

        The cache built during ``async_setup`` only sees entities that existed at
        that moment (plus those that later changed state). Integrations that were
        still loading during startup would be missing forever, so we reconcile
        against the live state machine on every read. The reconciled list is cached
        for a short TTL so reconnect / re-open storms don't re-serialise the whole
        state machine repeatedly; live changes still arrive via WebSocket.

        ``slim=True`` drops a few bulky attributes the 3D panel never renders to
        shrink the payload on weak devices (e.g. iPad mini 4).
        """
        now = time.monotonic()
        if self._entities_cache is not None and (now - self._entities_cache_ts) < 2.0:
            entities = self._entities_cache
        else:
            entities = self._reconcile_entities()
            self._entities_cache = entities
            self._entities_cache_ts = now

        out: list[dict[str, Any]] = []
        for e in entities:
            e = self._strip_entity_attrs(e, _SAFE_DROP_ATTRS)
            if slim:
                e = self._strip_entity_attrs(e, _SLIM_DROP_ATTRS)
            out.append(e)
        return out

    def _reconcile_entities(self) -> list[dict[str, Any]]:
        """Reconcile the entity cache against the live HA state machine."""
        live: set[str] = set()
        for state in self.hass.states.async_all():
            entity_id = state.entity_id
            live.add(entity_id)
            cached = self.entities.get(entity_id)
            if cached is None or cached.get("lastUpdated") != (
                state.last_updated.isoformat() if state.last_updated else None
            ):
                try:
                    self.entities[entity_id] = self._to_entity(state)
                except Exception:  # noqa: BLE001
                    _LOGGER.debug("Skipping entity %s", entity_id, exc_info=True)
        # Drop entities that no longer exist in HA.
        for stale in set(self.entities) - live:
            self.entities.pop(stale, None)
        return list(self.entities.values())

    @staticmethod
    def _strip_entity_attrs(
        entity: dict[str, Any], drop: tuple[str, ...]
    ) -> dict[str, Any]:
        attrs = entity.get("attributes")
        if not isinstance(attrs, dict) or not any(k in attrs for k in drop):
            return entity
        return {
            **entity,
            "attributes": {k: v for k, v in attrs.items() if k not in drop},
        }

    def get_areas(self) -> list[dict[str, Any]]:
        return sorted(self.areas.values(), key=lambda a: a["name"])

    def get_entity(self, entity_id: str) -> dict[str, Any] | None:
        cached = self.entities.get(entity_id)
        if cached is not None:
            return cached
        state = self.hass.states.get(entity_id)
        if state is None:
            return None
        entity = self._to_entity(state)
        self.entities[entity_id] = entity
        return entity

    # ---- weather forecasts --------------------------------------------
    def _schedule_weather_refresh(self) -> None:
        """Debounced weather forecast refresh (called on weather state change)."""
        self._weather_dirty = True
        if self._weather_timer is not None:
            self._weather_timer.cancel()
        self._weather_timer = self.hass.loop.call_later(
            2.0, lambda: self.hass.async_create_task(self._do_weather_refresh())
        )

    async def _do_weather_refresh(self) -> None:
        if not self._weather_dirty:
            return
        self._weather_dirty = False
        await self.refresh_weather_forecasts()

    async def refresh_weather_forecasts(self) -> bool:
        """Fetch and cache weather forecasts into entity attributes.

        Returns True when at least one entity was updated.
        """
        weather_ids = [
            eid for eid, e in self.entities.items() if e["domain"] == "weather"
        ]
        if not weather_ids:
            return False
        result: dict[str, Any] | None = None
        for forecast_type in ("daily", "hourly"):
            try:
                result = await self.hass.services.async_call(
                    "weather",
                    "get_forecasts",
                    {"type": forecast_type, "target": {"entity_id": weather_ids}},
                    blocking=True,
                    return_response=True,
                )
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("weather.get_forecasts (%s) failed: %s", forecast_type, err)
                continue
            if result:
                break
        if not isinstance(result, dict):
            return False
        response = result.get("response", result)
        changed = False
        for entity_id in weather_ids:
            entry = response.get(entity_id) if isinstance(response, dict) else None
            forecast = entry.get("forecast") if isinstance(entry, dict) else None
            if not isinstance(forecast, list) or not forecast:
                continue
            entity = self.entities.get(entity_id)
            if not entity:
                continue
            updated = {**entity, "attributes": {**entity["attributes"], "forecast": forecast}}
            self.entities[entity_id] = updated
            self._broadcast({"type": "ha.entity_updated", "payload": updated})
            changed = True
        return changed

    def _registry_info(self, entity_id: str) -> tuple[str | None, str | None]:
        """Resolve (device_id, area_id) live from the registries.

        A snapshot taken at setup time misses entities registered later by
        integrations that were still starting up, which left them without an
        area and therefore invisible in the SPA's per-area device list.
        """
        cached = self.registry_by_entity.get(entity_id)
        if cached is not None:
            return cached.get("deviceId"), cached.get("areaId")
        ent_reg = entity_registry.async_get(self.hass)
        entry = ent_reg.async_get(entity_id)
        if entry is None:
            return None, None
        area_id = entry.area_id
        if area_id is None and entry.device_id:
            dev_reg = device_registry.async_get(self.hass)
            device = dev_reg.async_get(entry.device_id)
            area_id = device.area_id if device else None
        info = {"deviceId": entry.device_id, "areaId": area_id}
        self.registry_by_entity[entity_id] = info
        return entry.device_id, area_id

    def _to_entity(self, state) -> dict[str, Any]:
        entity_id = str(state.entity_id)
        domain = entity_id.split(".", 1)[0]
        device_id, area_id = self._registry_info(entity_id)
        prev = self.entities.get(entity_id)
        return {
            "entityId": entity_id,
            "domain": domain,
            "name": str(state.attributes.get(ATTR_FRIENDLY_NAME, prev["name"] if prev else entity_id)),
            "state": str(state.state),
            # HA attribute values are not guaranteed to be JSON-serialisable
            # (datetime, set, Decimal, bytes, ...). Sanitise them here so a single
            # exotic entity cannot break the whole entity list response.
            "attributes": _json_safe(state.attributes),
            "areaId": area_id,
            "deviceId": device_id,
            "lastChanged": state.last_changed.isoformat() if state.last_changed else None,
            "lastUpdated": state.last_updated.isoformat() if state.last_updated else None,
        }

    # ---- actions -------------------------------------------------------
    async def perform_action(self, action: dict[str, Any]) -> dict[str, Any]:
        entity_id = action["entityId"]
        if self.hass.states.get(entity_id) is None:
            raise ValueError(f"Unknown entity {entity_id}")
        domain = entity_id.split(".", 1)[0]
        service = self._resolve_service(action, domain)
        data: dict[str, Any] = {"entity_id": entity_id}
        if action["type"] == "set_brightness":
            data["brightness"] = action["brightness"]
        elif action["type"] == "set_color_temperature":
            data["color_temp_kelvin"] = action["color_temp_kelvin"]
        elif action["type"] == "set_rgb_color":
            data["rgb_color"] = action["rgbColor"]
        elif action["type"] == "set_cover_position":
            data["position"] = action["position"]
        elif action["type"] == "set_temperature":
            data["temperature"] = action["temperature"]
        elif action["type"] == "set_hvac_mode":
            data["hvac_mode"] = action["mode"]
        elif action["type"] == "set_fan_percentage":
            data["percentage"] = action["percentage"]

        await self.hass.services.async_call(
            domain, service, data, blocking=True, context=None
        )
        state = self.hass.states.get(entity_id)
        entity = self._to_entity(state) if state else self.entities[entity_id]
        self.entities[entity["entityId"]] = entity
        self._broadcast({"type": "ha.entity_updated", "payload": entity})
        return entity

    @staticmethod
    def _resolve_service(action: dict[str, Any], domain: str) -> str:
        t = action["type"]
        if t == "turn_on":
            return "open_cover" if domain == "cover" else "turn_on"
        if t == "turn_off":
            return "close_cover" if domain == "cover" else "turn_off"
        if t == "toggle":
            return "toggle"
        return {
            "set_cover_position": "set_cover_position",
            "set_temperature": "set_temperature",
            "set_hvac_mode": "set_hvac_mode",
            "set_fan_percentage": "set_percentage",
        }.get(t, "turn_on")

    # ---- binding suggestions ------------------------------------------
    def get_room_binding_suggestions(self, project: dict[str, Any]) -> list[dict[str, Any]]:
        def norm(value: str) -> str:
            return value.strip().lower()

        placed = {
            d["entityId"] for f in project["floors"] for d in f.get("devices", [])
        }
        suggestions: list[dict[str, Any]] = []
        for floor in project["floors"]:
            for room in floor.get("rooms", []):
                if any(d.get("roomId") == room["id"] for d in floor.get("devices", [])):
                    continue
                room_name = norm(room["name"])
                area = next(
                    (
                        c
                        for c in self.areas.values()
                        if (an := norm(c["name"])) == room_name
                        or an in room_name
                        or room_name in an
                    ),
                    None,
                )
                if not area:
                    continue
                entity_ids = [
                    e["entityId"]
                    for e in self.get_entities()
                    if e.get("areaId") == area["id"]
                    and e["domain"] in SUPPORTED_DOMAINS
                    and e["entityId"] not in placed
                ]
                if entity_ids:
                    suggestions.append(
                        {
                            "floorId": floor["id"],
                            "roomId": room["id"],
                            "roomName": room["name"],
                            "areaId": area["id"],
                            "areaName": area["name"],
                            "entityIds": entity_ids,
                        }
                    )
        return suggestions
