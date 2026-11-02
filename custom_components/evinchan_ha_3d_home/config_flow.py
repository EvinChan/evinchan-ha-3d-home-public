"""Config flow for Evinchan HA 3D Home."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigFlow
from homeassistant.data_entry_flow import FlowResult
import voluptuous as vol

from .const import CONF_LOG_LEVEL, DEFAULT_LOG_LEVEL, DOMAIN

_LOGGER = logging.getLogger(__name__)


class ThreeDHomeConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the config flow for 3D Home."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict | None = None
    ) -> FlowResult:
        """Handle the initial step."""
        if user_input is not None:
            return self.async_create_entry(title="3D Home", data=user_input)

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Optional(
                        CONF_LOG_LEVEL, default=DEFAULT_LOG_LEVEL
                    ): vol.In(
                        ["trace", "debug", "info", "warning", "error"]
                    ),
                }
            ),
        )
