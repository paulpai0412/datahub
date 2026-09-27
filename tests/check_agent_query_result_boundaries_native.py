"""Approved owned MSSQL fixture; no existing credentials, source or service writes."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import uuid

import pytds

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "mcr.microsoft.com/mssql/server@sha256:46f719fd3457d4e7e8e5845fe00c35c20e7bae7ff1e8b9fe595f2a81029f5ba8"


def main():
    assert len(sys.argv) == 4 and sys.argv[1:3] == ["--approved-isolated", "--output-dir"]
    out = Path(sys.argv[3]).resolve()
    assert out.is_relative_to(ROOT / ".local/evidence")
    os.umask(0o077)
    out.mkdir(mode=0o700)  # New round only; never overwrite an earlier run.
    (out / "docker-home").mkdir(mode=0o700)
    owner = str(uuid.uuid4())
    name = "datahub-query-boundaries-" + owner[:8]
    env = {"PATH": os.environ["PATH"], "HOME": str(out / "docker-home"),
           "LANG": "C.UTF-8", "DOCKER_HOST": "unix:///var/run/docker.sock"}
    proof = {"complete": False, "scope": "OWNED_SYNTHETIC_MSSQL_RESULT_BOUNDARIES", "owner": owner,
             "name": name, "image": IMAGE, "phase": "initial", "existingSourceQueries": 0,
             "modelPrompts": 0, "deployedServicesChanged": False, "ownedContainerRemoved": False}
    container = admin = None

    def save():
        (out / "receipt.json").write_text(json.dumps(proof, indent=2) + "\n")

    def docker(*args, timeout=30):
        return subprocess.run(["docker", *args], env=env, capture_output=True, text=True,
                              timeout=timeout, check=True).stdout.strip()

    try:
        proof["sourceHashes"] = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in [
            "tests/check_agent_query_result_boundaries_native.py", "tests/fixtures/query-result-native.mjs",
            "extensions/datahub-agent/integration/query_runner.py", "extensions/datahub-agent/integration/metadata_query.py",
            "extensions/datahub-agent/integration/query-source.mjs", "extensions/datahub-agent/integration/metadata-query.mjs",
            "extensions/datahub-agent/integration/query-grafana.mjs"]}
        docker("image", "inspect", IMAGE, "--format", "{{.Id}}")
        password, reader_password = "A!" + secrets.token_hex(20), "R!" + secrets.token_hex(20)
        env_path = out / "container-env-private"
        env_path.write_text(f"ACCEPT_EULA=Y\nMSSQL_PID=Developer\nMSSQL_SA_PASSWORD={password}\nMSSQL_MEMORY_LIMIT_MB=1536\n")
        proof["phase"] = "create_intent"
        save()
        container = docker("run", "-d", "--pull", "never", "--name", name, "--label", f"datahub.query.boundaries={owner}",
                           "--memory", "3g", "--memory-swap", "3g", "--cpus", "1", "--security-opt", "no-new-privileges",
                           "--env-file", str(env_path), "--tmpfs", "/var/opt/mssql:rw,nosuid,nodev,size=1g,uid=10001,gid=0,mode=770",
                           "--publish", "127.0.0.1::1433", IMAGE)
        proof["containerId"] = container
        info = json.loads(docker("inspect", container))[0]
        hc = info["HostConfig"]
        assert hc["Memory"] == hc["MemorySwap"] == 3221225472 and hc["NanoCpus"] == 1000000000
        assert not hc["Binds"] and all(m["Type"] == "tmpfs" for m in info["Mounts"])
        ports = info["NetworkSettings"]["Ports"]["1433/tcp"]
        assert len(ports) == 1 and ports[0]["HostIp"] == "127.0.0.1"
        port = int(ports[0]["HostPort"])
        for _ in range(90):
            assert docker("inspect", container, "--format", "{{.State.Running}} {{.State.OOMKilled}}") == "true false"
            if "SQL Server is now ready for client connections" in docker("logs", container):
                break
            time.sleep(1)
        else:
            raise RuntimeError("fixture_start_timeout")
        proof["limits"] = {"cpus": 1, "memory": hc["Memory"], "memorySwap": hc["MemorySwap"], "loopbackOnly": True, "existingVolumes": 0}
        proof["phase"] = "fixture_setup"
        save()
        admin = pytds.connect(dsn="127.0.0.1", port=port, user="sa", password=password, database="master",
                              autocommit=True, timeout=10, login_timeout=5, disable_connect_retry=True)
        cursor = admin.cursor()
        cursor.execute("CREATE DATABASE query_boundaries")
        cursor.execute("""DECLARE @ddl nvarchar(max) = N'CREATE LOGIN boundary_reader WITH PASSWORD='
                          + QUOTENAME(%s, '''') + N', CHECK_POLICY=OFF'; EXEC(@ddl)""", (reader_password,))
        cursor.execute("""USE query_boundaries;
            CREATE TABLE dbo.result_probe(id int PRIMARY KEY, big bigint NULL, amount decimal(38,18) NULL,
              label nvarchar(max) NULL, day date NULL, enabled bit NULL, payload nvarchar(max) NULL);
            CREATE USER boundary_reader FOR LOGIN boundary_reader;
            GRANT SELECT ON dbo.result_probe TO boundary_reader;""")
        # Known decimal text is CAST by SQL Server; no Python float ever creates a golden value.
        rows = [(1, "9223372036854775807", "12345678901234567890.123456789012345678", "", "2026-09-27", False, "界" * 8192),
                (2, "-9223372036854775808", "-123.000000000000000001", "中文📦", None, True, "界" * 8192),
                (3, None, None, None, None, None, "界" * 8192)]
        rows.extend((n, "0", "0", "", None, False, "界" * 8192 if n <= 50 else "") for n in range(4, 1002))
        rows.append((1002, "0", "0", "", None, False, "界" * 8193))
        cursor.executemany("""INSERT dbo.result_probe(id,big,amount,label,day,enabled,payload)
                          VALUES(%s,CAST(%s AS bigint),CAST(%s AS decimal(38,18)),%s,%s,%s,%s)""", rows)
        cursor.close()
        admin.close()
        admin = None
        (out / "connection-private.json").write_text(json.dumps({"host": "127.0.0.1", "port": port,
            "username": "boundary_reader", "password": reader_password, "database": "query_boundaries"}))
        proof["fixtureRows"] = len(rows)
        proof["phase"] = "source_checks"
        save()
        with (out / "worker-private.log").open("w") as log:
            worker = subprocess.run(["node", str(ROOT / "tests/fixtures/query-result-native.mjs"), str(out)],
                                    cwd=ROOT, env={"PATH": os.environ["PATH"], "HOME": "/dev/null", "LANG": "C.UTF-8"},
                                    stdout=log, stderr=log, timeout=180)
        proof["workerExit"] = worker.returncode
        result = json.loads((out / "host-results-private.json").read_text())
        proof["sourceDispatches"] = result["sourceDispatches"]
        proof["cases"] = [{"name": c["name"], "passed": c["passed"]} for c in result["cases"]]
        assert worker.returncode == 0 and result["complete"] and result["sourceDispatches"] == 8
        proof["complete"] = True
        proof["phase"] = "native_boundaries_verified"
    except Exception as error:
        proof["failure"] = {"class": type(error).__name__, "phase": proof["phase"]}
    finally:
        if admin is not None:
            admin.close()
        # A failed create command is reconciled by the unique name, not blindly replayed.
        candidates = docker("ps", "-aq", "--filter", f"label=datahub.query.boundaries={owner}").split()
        assert len(candidates) <= 1
        if candidates:
            known = candidates[0]
            identity = docker("inspect", known, "--format", '{{.Id}} {{.Name}} {{index .Config.Labels "datahub.query.boundaries"}}').split()
            assert identity[1:] == ["/" + name, owner]
            if container is not None:
                assert identity[0] == container
            (out / "sqlserver-log-private.txt").write_text(docker("logs", known))
            docker("stop", "--time", "10", known)
            docker("rm", known)
        proof["ownedContainerRemoved"] = not docker("ps", "-aq", "--filter", f"label=datahub.query.boundaries={owner}")
        save()
    print(json.dumps({"complete": proof["complete"], "phase": proof["phase"], "sourceDispatches": proof.get("sourceDispatches", 0),
                      "ownedContainerRemoved": proof["ownedContainerRemoved"], "receipt": str(out / "receipt.json")}))
    return 0 if proof["complete"] and proof["ownedContainerRemoved"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
