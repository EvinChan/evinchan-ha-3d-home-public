"""Constants for the Evinchan HA 3D Home integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "evinchan_ha_3d_home"
# Must match manifest.json's "version" (R2.6). It is what the startup log prints,
# so a mismatch makes it impossible to tell which build is actually running.
VERSION: Final = "1.9.30"

# Sidebar panel
PANEL_TITLE: Final = "3D Home"
PANEL_ICON: Final = "mdi:floor-plan"
PANEL_URL: Final = "evinchan-3d-home"

# Route prefixes (the prebuilt SPA derives its API/WS base from the page path,
# so serving it under this prefix makes it call our endpoints automatically).
API_PREFIX: Final = "/api/evinchan_ha_3d_home"
WS_PATH: Final = f"{API_PREFIX}/ws"
STATIC_URL: Final = f"{API_PREFIX}/{{path:.*}}"

# Storage
STORAGE_KEY: Final = DOMAIN
STORAGE_VERSION: Final = 1
STORAGE_PROJECTS_KEY: Final = f"{DOMAIN}.projects"
STORAGE_PROJECTS_VERSION: Final = 1
STORAGE_SETTINGS_KEY: Final = f"{DOMAIN}.settings"
STORAGE_SETTINGS_VERSION: Final = 1

# Config flow
CONF_LOG_LEVEL: Final = "log_level"
DEFAULT_LOG_LEVEL: Final = "info"
