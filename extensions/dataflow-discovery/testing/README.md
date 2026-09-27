# Isolated Discovery framework test image

This is an **operator-run image for reviewed first-party framework checks**. It is
not a pi-web candidate-admission service, an authorization grant, or a sandbox
that makes unreviewed code safe to import into a credential-bearing Host.

## What is fixed

- Python base by registry digest; Linux amd64 / CPython 3.11 only.
- Git and OS dependencies from signed Debian snapshots `20260925T000000Z`.
- All 73 versions from existing `deploy/cli.lock.txt`, including DataHub SDK
  1.7.0.9, jsonschema 4.26.0 and sqlglot 30.12.0. No separately resolved versions.
- `requirements.lock` adds SHA256 hashes of compatible, non-yanked wheels from
  the version-specific PyPI JSON records. No source-distribution/PEP 517 builds,
  floating dependencies or Host pip installation. Pinned packages remain trusted
  dependency code, not code proven safe by hashing. `pip check` must pass.
- `image.lock.json` records the actual local image ID, build-input hashes, source
  lock digest, architecture and installed OS packages. This is not a signature,
  vulnerability scan, or proof of arbitrary plugin behavior.

The SDK is deliberately not inherited from the existing MCP service image: that
image contains SDK 1.3.1.10 and lacks both Git and SQLGlot. We do not update or
retag it. Reusing the complete existing CLI lock keeps one dependency baseline
rather than maintaining a separately resolved test-toolchain dependency set.

## Build (explicit operator action)

Run at the repository root. Only the `testing/` directory is a build context;
`.dockerignore` admits only Dockerfile, requirements lock and image entrypoint.
No repository source, HOME, `.local`, credentials or deployment config is baked.
The build may download the pinned public base and packages. Test execution must
have **no network**. Never pass registry credentials, build secrets or host env.

```sh
mkdir -p .local/discovery-plugin-contract
RUN_DIR=$(mktemp -d "$PWD/.local/discovery-plugin-contract/image-check-XXXXXXXX")
mkdir "$RUN_DIR/docker-client"
docker --config "$RUN_DIR/docker-client" --host unix:///var/run/docker.sock build \
  --pull=false --platform linux/amd64 --progress plain \
  --iidfile "$RUN_DIR/image.id" \
  --tag ekop-datahub-discovery-test:contract-v1-20260926 \
  extensions/dataflow-discovery/testing > "$RUN_DIR/build.log" 2>&1
```

Building a new artifact does not approve or activate it. Compare its build inputs
and actual identity; do not silently replace the committed image lock with a new
ID or run a mutable tag without checking it.

## Inputs and execution

1. Start with a fresh receipt from the existing local checker on **reviewed**
   source. It is not permission to run an unreviewed generated plugin on Host.
2. Copy only the receipt's `sources` inventory into a new private staging
   directory, preserving the repository-relative layout. Reject symlinks or paths
   escaping the checkout, verify every byte SHA256 before copying, and recheck
   after capture. Directories within the stage need mode 0755 and files 0644 so
   UID 10001 can read them even if the operator's umask is 077; the enclosing
   evidence directory remains private. Do not mount the original checkout.
3. Store the inventory, digest and new run's exact image/container IDs outside
   the container. It must never mount source roots, HOME, `.git`, credentials,
   business inputs or the Docker socket. The 2026-09-26 run used 42 explicit files.
4. Create a new named container using the immutable image ID. Example (operator
   supplies the **new** run name, reviewed stage and verified IMAGE_ID):

```sh
docker create --name "$RUN_NAME" --pull=never \
  --network none --read-only --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 512m --memory-swap 512m --cpus 1 \
  --ipc none --ulimit nofile=256:256 --stop-timeout 2 \
  --log-driver local --log-opt max-size=1m --log-opt max-file=1 --log-opt compress=false \
  --mount "type=bind,src=$STAGE,dst=/work,readonly,bind-propagation=rprivate" \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
  "$IMAGE_ID"
```

`compress=false` is required with local logging driver's `max-file=1`.
Do not add `noexec` to this test's `/tmp`: it would mask the fsmonitor regression
by preventing the harmless test hook from running even if Host suppression were
broken. No production repository hooks are mounted or executed.

5. Inspect the created container **before** start: exact image, sole read-only
   stage mount, UID, entrypoint, no inherited credential env, network none,
   read-only root, dropped caps, no-new-privileges, CPU/memory/PID/tmpfs/log limits.
6. Start attached, capturing stdout and stderr into new private evidence files.
   The image entrypoint first checks the actual Linux runtime profile, then runs
   the existing fixed suite. It emits a JSON receipt. The fixed checker has a
   180s suite timeout, the image wrapper 190s; an operator must also bound the
   Docker attachment (230s in this run). A timeout is not permission to retry:
   inspect/stop the exact container and reconcile first. The fixed reviewed
   suite has bounded known output; a general hostile-candidate streaming/output
   admission boundary is **not implemented** by this entrypoint.
7. Inspect the exit state, OOM status and unchanged Docker profile; compare both
   stage and current source hashes with the input manifest and returned receipt.
   Check all locked versions. A container-produced PASS alone is insufficient.
8. Keep evidence, then remove only that stopped test container. Do not prune
   images/volumes, restart services or touch another run's container.

## Evidence and limits

The approved 2026-09-26 image passed all **64 existing framework tests**, ten
runtime profile checks, and a negative test that withheld the source mount and
was rejected before any suite ran. The TEST-NET address used for the egress probe
is documentation-only (`192.0.2.1`), not a business endpoint.

The embedded local checker still reports `isolationVerified=false`, correctly:
it cannot attest to its parent environment. The separate Host readback checks
Docker configuration, image, actual process exit, source freshness and evidence.
Do not change the local flag just because the caller is a container.

Actual receipts and the initial rejected logging configuration are retained under
`.local/discovery-plugin-contract/image-r1`, `image-r2`, and `image-negative-r1`.
See `docs/verification/dataflow-discovery-plugin-contract.md` for exact evidence.

Still separate: immutable/protected candidate admission and fixed expectations,
pi-web writable development workspace and Host tools, model-adherence tests,
real-source/DataHub compatibility, independent review, and approved activation.
Neither this image nor its receipts grant any of those authorities.
