"""WebSocket gateway mirroring the Add-on's ``ClientGateway``.

The prebuilt SPA opens ``<base>/ws`` and speaks a small JSON protocol:
``project.subscribe``, ``project.patch``, ``ha.action`` (client → server) and
``server.ready``, ``command.ack``, ``command.error``, ``project.updated``,
``ha.entity_updated``, ``ha.status`` (server → client).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from aiohttp import WSMsgType, web
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, WS_PATH
from .ha_client import HaClient
from .project_store import ProjectStore

_LOGGER = logging.getLogger(__name__)


class Gateway:
    """Manage connected SPA websocket clients and relay HA events to them."""

    def __init__(self, hass: HomeAssistant, ha: HaClient, store: ProjectStore) -> None:
        self.hass = hass
        self.ha = ha
        self.store = store
        self.clients: set[web.WebSocketResponse] = set()
        # Entities changed during the current event-loop turn, coalesced into one
        # frame instead of one websocket message per entity.
        self._pending_entities: dict[str, dict[str, Any]] = {}
        self._flush_scheduled = False

    def broadcast(self, event: dict[str, Any]) -> None:
        """Send an event to every connected client."""
        if not self.clients:
            _LOGGER.debug("3D Home broadcast dropped: no WS clients connected")
            return
        if event.get("type") == "ha.entity_updated":
            entity = event.get("payload")
            if isinstance(entity, dict) and entity.get("entityId"):
                # Coalesce: a scene turning on 20 lights yields a single frame.
                self._pending_entities[entity["entityId"]] = entity
                self._schedule_flush()
                return
        self._dispatch(json.dumps(event))

    def _schedule_flush(self) -> None:
        if self._flush_scheduled:
            return
        self._flush_scheduled = True
        # call_soon runs after the current turn finishes (i.e. after HA has
        # processed the whole batch of state changes), so latency stays at one
        # loop iteration while burst updates are merged.
        self.hass.loop.call_soon(self._flush)

    @callback
    def _flush(self) -> None:
        self._flush_scheduled = False
        if not self._pending_entities:
            return
        entities = list(self._pending_entities.values())
        self._pending_entities.clear()
        # The SPA's handler accepts either a single entity or an array under the
        # `ha.entity_updated` type, so batch frames stay backward compatible.
        payload: Any = entities[0] if len(entities) == 1 else entities
        self._dispatch(json.dumps({"type": "ha.entity_updated", "payload": payload}))

    def _dispatch(self, payload: str) -> None:
        if not self.clients:
            return
        for client in list(self.clients):
            if client.closed:
                self.clients.discard(client)
                continue
            self.hass.async_create_task(self._send_raw(client, payload))

    async def _send_raw(self, client: web.WebSocketResponse, payload: str) -> None:
        try:
            await client.send_str(payload)
        except Exception:  # noqa: BLE001 - client went away mid-send
            _LOGGER.debug("ws send failed, dropping client", exc_info=True)
            self.clients.discard(client)

    async def handle(self, request: web.Request) -> web.WebSocketResponse:
        # In integration mode the SPA talks to us in-process through this WS, no
        # token/connection handshake is involved.
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        self.clients.add(ws)
        _LOGGER.debug("WS client connected (%d active)", len(self.clients))
        await ws.send_str(json.dumps({
            "type": "server.ready",
            "payload": {"connectedAt": _now_iso()},
        }))
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                await self._handle_message(ws, msg.data)
        except Exception:  # noqa: BLE001
            _LOGGER.debug("ws client disconnected", exc_info=True)
        finally:
            self.clients.discard(ws)
        return ws

    async def _handle_message(self, ws: web.WebSocketResponse, raw: str) -> None:
        import json

        try:
            command = json.loads(raw)
        except Exception:  # noqa: BLE001
            await self._send(ws, {"type": "command.error", "payload": {"message": "Invalid WebSocket command"}})
            return
        request_id = command.get("requestId")
        try:
            ctype = command.get("type")
            if ctype == "project.subscribe":
                project = self.store.get_project()
                await self._send(ws, {"type": "project.updated", "payload": project})
                await self._ack(ws, request_id)
            elif ctype == "project.patch":
                payload = command.get("payload") or {}
                project = payload.get("project") if isinstance(payload, dict) and "project" in payload else payload
                if not project:
                    raise ValueError("Project payload is required")
                saved = await self.store.save_project(project)
                self.broadcast({"type": "project.updated", "payload": saved})
                await self._ack(ws, request_id, saved)
            elif ctype == "ha.action":
                entity = await self.ha.perform_action(command.get("payload", {}))
                self.broadcast({"type": "ha.entity_updated", "payload": entity})
                await self._ack(ws, request_id, entity)
            else:
                await self._send(ws, {"type": "command.error", "payload": {"requestId": request_id, "message": f"Unknown command {ctype}"}})
        except Exception as err:  # noqa: BLE001
            await self._send(ws, {"type": "command.error", "payload": {"requestId": request_id, "message": str(err)}})

    async def _send(self, ws: web.WebSocketResponse, event: dict[str, Any]) -> None:
        if not ws.closed:
            await ws.send_str(json.dumps(event))

    async def _ack(self, ws: web.WebSocketResponse, request_id: Any, result: Any = None) -> None:
        if request_id is not None:
            await self._send(ws, {"type": "command.ack", "payload": {"requestId": request_id, "result": result}})


def _now_iso() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def async_setup_gateway(hass: HomeAssistant, ha: HaClient, store: ProjectStore) -> Gateway:
    """Create the gateway, register the WS route and forward HA broadcasts."""
    gateway = Gateway(hass, ha, store)
    hass.data.setdefault(DOMAIN, {})["gateway"] = gateway

    # Must be a plain function: HaClient._broadcast calls listeners synchronously
    # and does not await them, so an ``async def`` here would silently create a
    # never-awaited coroutine and drop every event.
    def forward(event: dict[str, Any]) -> None:
        gateway.broadcast(event)

    ha.on_broadcast(forward)
    hass.http.app.router.add_route("GET", WS_PATH, gateway.handle)
    return gateway
