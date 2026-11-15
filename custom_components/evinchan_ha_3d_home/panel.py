"""Sidebar panel registration for Evinchan HA 3D Home."""

from __future__ import annotations

import logging

from homeassistant.components.frontend import (
    async_register_built_in_panel,
    # 为何：本地函数必须叫 async_remove_panel（__init__.py:65,70 依赖该名字），
    # 若同名导入，函数体内会递归调用自己；用别名区分 HA 的实现。
    async_remove_panel as ha_remove_panel,
)
from homeassistant.core import HomeAssistant

from .const import PANEL_ICON, PANEL_TITLE, PANEL_URL

_LOGGER = logging.getLogger(__name__)

# Base URL served by our HTTP view where the built React SPA lives. The SPA is
# path-aware and derives its API/WS endpoints from the page path, so embedding
# it via an iframe at this URL makes it talk to our integration automatically.
PANEL_IFRAME_URL = "/api/evinchan_ha_3d_home/"


async def async_register_panel(hass: HomeAssistant) -> None:
    """Register the 3D Home sidebar panel (iframe).

    ``async_register_built_in_panel`` is a synchronous ``@callback`` helper (not a
    coroutine) in HA 2025.1+, so it is called without ``await``.
    """
    async_register_built_in_panel(
        hass,
        "iframe",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        frontend_url_path=PANEL_URL,
        config={"url": PANEL_IFRAME_URL},
        require_admin=False,
    )
    _LOGGER.debug("Registered 3D Home sidebar panel")


async def async_remove_panel(hass: HomeAssistant) -> None:
    """Remove the 3D Home sidebar panel.

    HA's ``async_remove_panel`` is a synchronous ``@callback`` helper (not a
    coroutine), so it must be called without ``await``. Keep the local name
    ``async_remove_panel`` because ``__init__.py`` imports exactly that symbol.
    """
    # 为何：旧代码在此递归调用同名本地函数且多传了 PANEL_URL，卸载/重载必抛
    # TypeError；改用别名调用 HA 的同步 @callback，不要 await。
    ha_remove_panel(hass, PANEL_URL)
