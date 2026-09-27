"""Controller for an OWNED ephemeral SQL Server, never a production connection.

Input is private JSON over stdin. This helper alone owns synthetic DDL and the
blocking transaction. Product SELECTs run separately through query_runner.py.
"""
import json
import os
import sys

import pytds


def connect(config, database="master", autocommit=True):
    assert config["host"] == "127.0.0.1"
    return pytds.connect(dsn=config["host"], port=config["port"], user="sa",
                         password=config["password"], database=database,
                         autocommit=autocommit, timeout=5, login_timeout=5,
                         disable_connect_retry=True, appname="lifecycle-fixture-controller")


def main():
    admin = locker = None
    statements = 0
    config = None
    try:
        for line in sys.stdin:
            req = json.loads(line)
            action = req["action"]
            try:
                if action == "init":
                    assert admin is None
                    config = req["connection"]
                    admin = connect(config)
                    cur = admin.cursor()
                    # CREATE LOGIN requires a literal password. Bind its value and
                    # let SQL Server quote the literal; never interpolate secrets in Python.
                    password = req["readerPassword"]
                    assert 24 <= len(password) <= 128
                    statements += 1
                    cur.execute("CREATE DATABASE query_lifecycle")
                    statements += 1
                    cur.execute("""DECLARE @ddl nvarchar(max) =
                        N'CREATE LOGIN lifecycle_reader WITH PASSWORD=' + QUOTENAME(%s, '''')
                        + N', CHECK_POLICY=OFF'; EXEC(@ddl)""", (password,))
                    statements += 1
                    cur.execute("""USE query_lifecycle;
                        CREATE TABLE dbo.lock_probe(id int PRIMARY KEY, value int NOT NULL);
                        INSERT dbo.lock_probe VALUES(1, 7);
                        CREATE USER lifecycle_reader FOR LOGIN lifecycle_reader;
                        GRANT SELECT ON dbo.lock_probe TO lifecycle_reader;""")
                    cur.execute("SELECT is_read_committed_snapshot_on FROM sys.databases WHERE name='query_lifecycle'")
                    assert cur.fetchone()[0] == 0
                    connection = dict(host="127.0.0.1", port=config["port"], username="lifecycle_reader",
                                      password=password, database="query_lifecycle")
                    fd = os.open(req["connectionPath"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "w") as stream:
                        json.dump(connection, stream)
                    result = {"initialized": True, "fixtureStatements": statements}
                elif action == "lock":
                    assert admin is not None and locker is None
                    locker = connect(config, "query_lifecycle", autocommit=False)
                    cur = locker.cursor()
                    cur.execute("UPDATE dbo.lock_probe SET value=value+1 WHERE id=1")
                    cur.execute("SELECT @@SPID")
                    result = {"lockerSessionId": cur.fetchone()[0]}
                elif action == "observe":
                    assert admin is not None
                    cur = admin.cursor()
                    cur.execute("""SELECT s.session_id, s.host_process_id, s.open_transaction_count,
                                   r.status, r.wait_type, r.blocking_session_id
                                   FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r
                                   ON r.session_id=s.session_id WHERE s.login_name='lifecycle_reader'""")
                    keys = ("sessionId", "pid", "transactions", "status", "waitType", "blockedBy")
                    result = {"sessions": [dict(zip(keys, row)) for row in cur.fetchall()]}
                elif action == "unlock":
                    assert locker is not None
                    locker.rollback()
                    locker.close()
                    locker = None
                    result = {"rolledBack": True}
                elif action == "stop":
                    result = {"stopped": True}
                    print(json.dumps({"id": req["id"], "result": result}), flush=True)
                    break
                else:
                    raise ValueError("unsupported_action")
                print(json.dumps({"id": req["id"], "result": result}), flush=True)
            except Exception as error:
                # Driver messages can contain credentials/SQL. Never log them.
                print(json.dumps({"id": req["id"], "error": "fixture_control_failed",
                                  "errorClass": type(error).__name__, "action": action,
                                  "fixtureStatements": statements}), flush=True)
                break
    finally:
        if locker is not None:
            try:
                locker.rollback()
            finally:
                locker.close()
        if admin is not None:
            admin.close()


if __name__ == "__main__":
    main()
