"""
Applink configuration — the ONLY module that reads the environment.

Two credentials, plus one URL per service you provisioned. Nothing else is
configuration: timeouts and encodings are constants in the client, because they
are properties of the protocol rather than of your deployment.

An endpoint that is not set means that API is not enabled on your application.
The client refuses to call it, so you get a clear local error instead of E1309
from the platform.

Validation runs at import time, so a misconfigured deployment fails at boot
rather than under load. If your framework defers imports (Django app loading,
Celery workers), call `describe_config()` from your startup hook as well so the
failure surfaces on deploy rather than on first traffic.

SERVER-SIDE ONLY. Nothing here may be exposed through an API response, a
template context, or a settings endpoint the browser can read.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

# In development, load .env before this module is imported:
#     from dotenv import load_dotenv; load_dotenv()
# In production do not ship a .env at all — use the host's secret manager.


def _require_env(name: str) -> str:
    value = (os.environ.get(name) or "").strip()
    if not value:
        raise RuntimeError(
            f"[applink] Missing required environment variable {name}.\n"
            f"Copy .env.example to .env and fill in your Applink credentials.\n"
            f"In production, set it in your host's secret manager."
        )
    return value


def _endpoint(name: str) -> Optional[str]:
    """An endpoint is optional: absent means that API is not provisioned."""
    value = (os.environ.get(name) or "").strip()
    return value.rstrip("/") if value else None


#: Environment variable per service. The names are identical in every language
#: template, so a polyglot estate has one deployment story.
_ENDPOINT_VARS: Dict[str, str] = {
    "sms_send": "APPLINK_SMS_SEND_URL",
    "ussd_send": "APPLINK_USSD_SEND_URL",
    "subscription_send": "APPLINK_SUBSCRIPTION_SEND_URL",
    "subscription_query_base": "APPLINK_SUBSCRIPTION_QUERY_BASE_URL",
    "subscription_charging_info": "APPLINK_SUBSCRIPTION_CHARGING_INFO_URL",
    "otp_request": "APPLINK_OTP_REQUEST_URL",
    "otp_verify": "APPLINK_OTP_VERIFY_URL",
    # CaaS step 1 - sends the subscriber an OTP. Charges nothing on its own.
    "caas_otp_generation": "APPLINK_CAAS_DEBIT_URL",
    # CaaS step 2 - this is the call that moves money.
    "caas_otp_verify": "APPLINK_CAAS_OTP_VERIFY_URL",
    "caas_balance": "APPLINK_CAAS_BALANCE_URL",
}


@dataclass(frozen=True)
class ApplinkConfig:
    #: Never log these. Never send them to a client.
    application_id: str
    password: str
    #: Only the services enabled on your application. Point any of these at a
    #: local mock during development — that is the whole environment switch.
    endpoints: Dict[str, Optional[str]] = field(default_factory=dict)

    def require_endpoint(self, service: str) -> str:
        """
        Resolve an endpoint, or fail with a message that names the missing
        variable. This is the guard that keeps you from calling an API your
        application was never provisioned for.
        """
        if service not in _ENDPOINT_VARS:
            raise KeyError(f"[applink] Unknown service '{service}'")
        url = self.endpoints.get(service)
        if not url:
            raise RuntimeError(
                f"[applink] {service} is not configured. Either the API is not enabled "
                f"on your application in the Applink developer portal, or {_ENDPOINT_VARS[service]} is missing "
                f"from the environment. See .env.example."
            )
        return url

    def enabled_services(self) -> List[str]:
        """Which services this deployment can actually call. Useful at startup."""
        return sorted(name for name, url in self.endpoints.items() if url)


def _assert_charging_configured(cfg: "ApplinkConfig") -> None:
    """
    Charging needs BOTH steps configured. A deployment with only the generation
    URL can start charges it can never complete, leaving subscribers holding an
    OTP and your ledger holding pending rows.
    """
    has_generation = bool(cfg.endpoints.get("caas_otp_generation"))
    has_verify = bool(cfg.endpoints.get("caas_otp_verify"))
    if has_generation != has_verify:
        raise RuntimeError(
            "[applink] Charging is a two-step flow: set BOTH APPLINK_CAAS_DEBIT_URL "
            "and APPLINK_CAAS_OTP_VERIFY_URL, or neither. With only one, a started "
            "charge can never be completed."
        )


def load_config() -> ApplinkConfig:
    return ApplinkConfig(
        application_id=_require_env("APPLINK_APP_ID"),
        password=_require_env("APPLINK_PASSWORD"),
        endpoints={name: _endpoint(var) for name, var in _ENDPOINT_VARS.items()},
    )


#: Import-time validation: a missing credential stops the process starting.
config = load_config()
_assert_charging_configured(config)


def describe_config() -> Dict[str, object]:
    """Redacted view, safe to log at startup to confirm what the process loaded."""
    return {
        "applicationId": config.application_id,
        "password": "***redacted***",
        "enabledServices": config.enabled_services(),
    }
