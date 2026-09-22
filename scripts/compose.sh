#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec docker compose --project-directory . --project-name ekop-datahub \
  --env-file .local/datahub.env --profile quickstart \
  -f upstream/datahub/docker/quickstart/docker-compose.quickstart-profile.yml \
  -f deploy/compose.local.yaml -f deploy/images.lock.yaml "$@"
