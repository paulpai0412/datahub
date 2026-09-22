#!/usr/bin/env python3
"""Create installation-local credentials once; never replace an existing set."""

import os
from pathlib import Path
import secrets

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"


def main() -> None:
    os.umask(0o077)
    LOCAL.mkdir(mode=0o700, exist_ok=True)
    # Public plugin artifacts are bind-mounted into containers running another UID.
    # mkdir(mode=...) alone is reduced to 0700 by the credential-safe umask above.
    plugins = LOCAL / "plugins"
    plugins.mkdir(mode=0o755, exist_ok=True)
    plugins.chmod(0o755)
    paths = [LOCAL / "datahub.env", LOCAL / "user.props"]
    if any(path.exists() for path in paths):
        if not all(path.is_file() for path in paths):
            raise SystemExit("Incomplete credentials: restore missing files; do not regenerate.")
        print("Existing credentials preserved.")
        return

    values = {
        "DATAHUB_VERSION": "v1.7.0.1",
        "UI_INGESTION_DEFAULT_CLI_VERSION": "1.7.0.9",
    }
    for key in (
        "MYSQL_ROOT_PASSWORD", "MYSQL_PASSWORD", "DATAHUB_SECRET",
        "DATAHUB_SYSTEM_CLIENT_SECRET", "DATAHUB_TOKEN_SERVICE_SIGNING_KEY",
        "DATAHUB_TOKEN_SERVICE_SALT",
    ):
        values[key] = secrets.token_hex(32)
    with paths[0].open("x") as output:
        output.write("".join(f"{key}={value}\n" for key, value in values.items()))
    with paths[1].open("x") as output:
        output.write(f"datahub:{secrets.token_hex(24)}\n")
    # The container can read this bind-mounted file; its host parent remains 0700.
    paths[1].chmod(0o644)
    for name in ("search", "evidence"):
        (LOCAL / name).mkdir(mode=0o755, exist_ok=True)
    print("Created local credentials. Login: datahub; password is in .local/user.props.")


if __name__ == "__main__":
    main()
