#!/usr/bin/env python3
"""Check the local Compose safety contract; --live also tests login and APIs."""

import argparse
from http.cookiejar import CookieJar
import json
from pathlib import Path
import subprocess
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def check_config() -> None:
    result = subprocess.run(
        [str(ROOT / "scripts/compose.sh"), "config", "--format", "json"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    try:
        config = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise SystemExit("Compose returned invalid JSON") from None
    services = config["services"]
    assert len(services) == 7, "Unexpected service set"
    published = set()
    for name, service in services.items():
        assert "@sha256:" in service["image"], f"Unpinned image: {name}"
        if name != "system-update-quickstart":
            assert service["restart"] == "unless-stopped", name
        for port in service.get("ports", []):
            assert port["host_ip"] == "127.0.0.1", f"Public port: {name}"
            published.add((name, str(port["published"])))
        for volume in service.get("volumes", []):
            if volume["type"] == "bind":
                assert Path(volume["source"]).is_relative_to(ROOT / ".local"), name
                assert volume.get("read_only"), f"Writable host mount: {name}"
    expected_ports = {
        ("datahub-gms-quickstart", "18080"), ("frontend-quickstart", "9002"),
    }
    assert published == expected_ports, "Unexpected published ports"
    for name in ("datahub-gms-quickstart", "frontend-quickstart"):
        assert services[name]["environment"]["METADATA_SERVICE_AUTH_ENABLED"] == "true"
    assert not services["datahub-actions-quickstart"].get("volumes")
    for volume in config["volumes"].values():
        assert volume["name"].startswith("ekop-datahub-"), "Shared volume namespace"
    assert config["networks"]["default"]["name"] == "ekop-datahub-network"
    assert (ROOT / ".local").stat().st_mode & 0o777 == 0o700
    assert (ROOT / ".local/datahub.env").stat().st_mode & 0o777 == 0o600
    paths = [ROOT / ".local/datahub.env", ROOT / ".local/user.props"]
    before = [path.read_bytes() for path in paths]
    subprocess.run(["python3", "scripts/init-local.py"], cwd=ROOT, check=True)
    assert before == [path.read_bytes() for path in paths], "Credentials changed on re-init"
    print("PASS: pinned images, isolated storage, loopback ports, auth, safe mounts, stable credentials")


def request(opener, url: str, payload: dict | None = None) -> tuple[int, bytes]:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with opener.open(req, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def check_live() -> None:
    anonymous = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    frontend = "http://127.0.0.1:9002"
    gms = "http://127.0.0.1:18080"
    for url in (frontend + "/health", frontend + "/login", gms + "/health"):
        status, _ = request(anonymous, url)
        assert status == 200, f"Unhealthy endpoint: {url} ({status})"
    query = {"query": "{ me { corpUser { username } } }"}
    for url in (gms + "/api/graphql", frontend + "/api/v2/graphql"):
        status, _ = request(anonymous, url, query)
        assert status in {401, 403}, f"Anonymous API access not rejected: {url} ({status})"
    status, _ = request(anonymous, frontend + "/logIn", {
        "username": "datahub", "password": "datahub",
    })
    assert status in {400, 401, 403}, "Default credentials are still accepted"
    username, password = (ROOT / ".local/user.props").read_text().strip().split(":", 1)
    session = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(CookieJar()),
    )
    status, _ = request(session, frontend + "/logIn", {
        "username": username, "password": password,
    })
    assert status == 200, f"Local login failed ({status})"
    status, body = request(session, frontend + "/api/v2/graphql", query)
    assert status == 200, f"Authenticated GraphQL failed ({status})"
    try:
        response = json.loads(body)
    except json.JSONDecodeError:
        raise SystemExit("GraphQL returned invalid JSON") from None
    assert not response.get("errors"), "GraphQL returned errors"
    assert response["data"]["me"]["corpUser"]["username"] == username
    print("PASS: UI/GMS health, anonymous rejection, default-password rejection, login, authenticated GraphQL")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    check_config()
    if args.live:
        check_live()
