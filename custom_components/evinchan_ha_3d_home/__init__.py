"""The Evinchan HA 3D Home integration (runs inside HA Core)."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the integration from YAML (config flow only)."""
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Evinchan HA 3D Home from a config entry."""
    from .const import VERSION

    _LOGGER.info("Setting up %s version %s", DOMAIN, VERSION)

    # Lazy imports keep the package import (and therefore the config-flow import,
    # which loads this __init__ module) light and avoid blocking calls inside the
    # event loop when Home Assistant loads the config wizard.
    from .gateway import async_setup_gateway
    from .ha_client import HaClient
    from .license_store import LicenseStore
    from .panel import async_register_panel
    from .project_store import async_setup_store
    from .views import async_setup_views

    # In integration mode there is no remote HA connection to authenticate or
    # (re)connect: everything is read directly from the in-process `hass` object.
    store = async_setup_store(hass)
    await store.async_setup()

    # License state must exist before views are registered: the API and the
    # business layer both read it from hass.data.
    license_store = LicenseStore(hass)
    await license_store.async_setup()
    hass.data[DOMAIN]["license_store"] = license_store

    ha_client = HaClient(hass)
    await ha_client.async_setup()

    hass.data[DOMAIN]["ha_client"] = ha_client

    # Gateway (WS route) must be registered before the static catch-all view so
    # it is not shadowed by the path-based static route.
    await async_setup_gateway(hass, ha_client, store)
    await async_setup_views(hass)
    await async_register_panel(hass)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload Evinchan HA 3D Home config entry."""
    from .ha_client import HaClient
    from .panel import async_remove_panel

    ha_client: HaClient | None = hass.data.get(DOMAIN, {}).get("ha_client")
    if ha_client is not None:
        await ha_client.async_unload()
    await async_remove_panel(hass)
    hass.data.pop(DOMAIN, None)
    return True
