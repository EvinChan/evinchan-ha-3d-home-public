"""License 持久化 + 授权状态缓存。

license key 存在 HA ``Store`` (``.storage/evinchan_ha_3d_home.settings``) 里，
因此跨重启、跨浏览器一致，且不属于可被前端篡改的 localStorage。

**防篡改要点**：授权状态由 ``license.evaluate()`` 在服务端计算（Ed25519 验签），
前端拿到的只是结果，改不了。业务接口若要限制功能，必须以
``LicenseStore.status()`` 为准做服务端判定，而不是信任前端传来的标志。
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from . import license as _license
from .const import DOMAIN, STORAGE_SETTINGS_KEY, STORAGE_SETTINGS_VERSION

_LOGGER = logging.getLogger(__name__)


class LicenseStore:
    """保存 license key，并缓存其验签结果。"""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store = Store(hass, STORAGE_SETTINGS_VERSION, STORAGE_SETTINGS_KEY)
        self._key: str = ""
        self._status: dict[str, Any] = _license.evaluate("")

    async def async_setup(self) -> None:
        """从存储加载 key 并计算一次授权状态。"""
        loaded = await self._store.async_load()
        if isinstance(loaded, dict):
            self._key = str(loaded.get("license_key") or "")
        self._recompute()
        _LOGGER.debug("License state: %s", self._status.get("tier"))

    def _recompute(self) -> None:
        self._status = _license.evaluate(self._key)
        # 只在状态变化时提示一次，避免每次请求刷日志
        if self._status.get("activated"):
            _LOGGER.info(
                "3D Home license activated (tier=%s, features=%s)",
                self._status.get("tier"),
                ",".join(self._status.get("features") or []),
            )
        elif self._key:
            _LOGGER.warning(
                "3D Home license invalid: %s", self._status.get("reason")
            )

    def status(self) -> dict[str, Any]:
        """当前授权状态（服务端权威结果）。"""
        return dict(self._status)

    def has_feature(self, feature: str) -> bool:
        """服务端功能位判定，供业务接口做硬校验。"""
        return _license.has_feature(self._status, feature)

    async def async_set_key(self, key: str) -> dict[str, Any]:
        """保存新 key 并立即重新验签；返回最新状态。"""
        self._key = (key or "").strip()
        await self._store.async_save({"license_key": self._key})
        self._recompute()
        return self.status()

    def machine_id(self) -> str:
        """本安装标识（供用户申请绑定本机的 license）。"""
        return _license._machine_id()
