# Dependency-only test image. Build context MUST be this testing directory.
# No source checkout, HOME, credentials, service config or sockets in the image.
FROM docker.io/library/python:3.11-slim@sha256:d1053354624536b044162aaab1e418bd000ea35184fb1ae098ab3166b1072e72

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATAHUB_TELEMETRY_ENABLED=false \
    HOME=/nonexistent \
    LANG=C.UTF-8

# Immutable, signed Debian snapshots pin Git and its OS dependencies. Only the
# snapshot expiration check is disabled; repository signature checks stay on.
RUN printf '%s\n' \
    'Types: deb' \
    'URIs: https://snapshot.debian.org/archive/debian/20260925T000000Z' \
    'Suites: trixie' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    'Check-Valid-Until: no' \
    '' \
    'Types: deb' \
    'URIs: https://snapshot.debian.org/archive/debian-security/20260925T000000Z' \
    'Suites: trixie-security' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    'Check-Valid-Until: no' > /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.lock /opt/discovery-test/requirements.lock
RUN python -m pip --isolated install --disable-pip-version-check --no-cache-dir \
    --only-binary=:all: --require-hashes --no-deps --index-url https://pypi.org/simple \
    -r /opt/discovery-test/requirements.lock \
    && python -m pip --isolated check

COPY run_checks.py /opt/discovery-test/run_checks.py
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["python", "-I", "/opt/discovery-test/run_checks.py"]
