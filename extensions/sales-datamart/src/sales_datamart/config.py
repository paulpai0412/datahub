"""Fixed, non-secret configuration for the AdventureWorks SalesDatamart case."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
import os
from typing import Final


SOURCE_DATABASE: Final = "AdventureWorks2019"
TARGET_DATABASE: Final = "SalesDatamart"
SOURCE_LOGIN: Final = "datahub_ingest"
TARGET_LOADER_LOGIN: Final = "sales_datamart_loader"
GRAFANA_LOGIN: Final = "sales_datamart_grafana"
DEFAULT_HOST: Final = "127.0.0.1"
DEFAULT_PORT: Final = 14334


class ConfigurationError(ValueError):
    """Raised for missing or unsafe runtime configuration."""


@dataclass(frozen=True)
class Scope:
    """The only first-version business scope exposed by the fixed ETL entrypoint."""

    scope_id: str = "adventureworks-local-usd-v1"
    start_date: date = date(2011, 5, 31)
    end_date: date = date(2014, 6, 30)
    status: int = 5
    local_currency_only: bool = True

    @property
    def end_exclusive(self) -> date:
        return self.end_date + timedelta(days=1)

    def as_dict(self) -> dict[str, object]:
        return {
            "scope_id": self.scope_id,
            "start_date": self.start_date.isoformat(),
            "end_date": self.end_date.isoformat(),
            "status": self.status,
            "currency_scope": "CurrencyRateID IS NULL" if self.local_currency_only else "unsupported",
        }

    def validate(self) -> None:
        if self.scope_id != "adventureworks-local-usd-v1":
            raise ConfigurationError("unsupported_scope")
        if self.start_date > self.end_date or self.status < 0:
            raise ConfigurationError("invalid_scope")
        if not self.local_currency_only:
            raise ConfigurationError("unsupported_currency_scope")


@dataclass(frozen=True)
class Connection:
    """Connection coordinates plus the environment variable holding its secret."""

    host: str
    port: int
    database: str
    username: str
    password_env: str

    def password(self) -> str:
        value = os.environ.get(self.password_env)
        if not value:
            raise ConfigurationError(f"missing_secret:{self.password_env}")
        return value

    def validate_fixed_target(self, *, database: str, username: str) -> None:
        if self.host not in {DEFAULT_HOST, "host.docker.internal"} or self.port != DEFAULT_PORT:
            raise ConfigurationError("unsupported_endpoint")
        if self.database != database or self.username != username:
            raise ConfigurationError("unsupported_identity")


def _port_from_env(name: str) -> int:
    raw = os.environ.get(name, str(DEFAULT_PORT))
    try:
        port = int(raw)
    except (TypeError, ValueError):
        raise ConfigurationError("invalid_port") from None
    if not 1 <= port <= 65535:
        raise ConfigurationError("invalid_port")
    return port


def source_connection() -> Connection:
    connection = Connection(
        host=os.environ.get("SALESDATAMART_SOURCE_HOST", DEFAULT_HOST),
        port=_port_from_env("SALESDATAMART_SOURCE_PORT"),
        database=SOURCE_DATABASE,
        username=SOURCE_LOGIN,
        password_env="DATAHUB_MSSQL_PASSWORD",
    )
    connection.validate_fixed_target(database=SOURCE_DATABASE, username=SOURCE_LOGIN)
    return connection


def target_connection() -> Connection:
    connection = Connection(
        host=os.environ.get("SALESDATAMART_TARGET_HOST", DEFAULT_HOST),
        port=_port_from_env("SALESDATAMART_TARGET_PORT"),
        database=TARGET_DATABASE,
        username=TARGET_LOADER_LOGIN,
        password_env="SALESDATAMART_LOADER_PASSWORD",
    )
    connection.validate_fixed_target(database=TARGET_DATABASE, username=TARGET_LOADER_LOGIN)
    return connection
