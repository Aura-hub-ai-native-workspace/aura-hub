"""A fake OpenCode / Kilo for the readiness gate's adversarial tests.

Shared by the Python and the TypeScript gate tests, so both languages face the
same adversary. Every part is a real local process with real sockets:

* ``serve``  — the private server. It checks the one-time password from its
  environment, answers ``GET /mcp`` and ``POST /mcp/common-context/connect``,
  records a task on ``POST /task``, and announces its real address.
* an **impostor** — a child of the server. It inherits the server's
  environment (so it knows the real password) and its stdout (so it can print
  an exact announcement), speaks the complete protocol (401 for a wrong
  password, ``connected`` for the right one) and records every byte it ever
  receives in ``impostor.log``.
* the CLI calls the gate makes: ``debug config``, ``mcp list --server <url>``
  (either argument order) and ``run ... --server|--attach <url> ...``.

Behaviour comes from ``$GATE_ADVERSARY`` (a JSON file). Nothing here contacts
anything but 127.0.0.1 / ::1, and no model or provider is involved.
"""

import base64
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request

CFG = json.load(open(os.environ["GATE_ADVERSARY"]))
D = CFG["dir"]
RUNTIME = CFG.get("runtime", "kilo")
PASSWORD_ENV = "KILO_SERVER_PASSWORD" if RUNTIME == "kilo" else "OPENCODE_PASSWORD"
ANNOUNCE = ("kilo server listening on http://127.0.0.1:%d" if RUNTIME == "kilo"
            else "server listening on http://127.0.0.1:%d")


def write(name, text, mode="w"):
    with open(os.path.join(D, name), mode) as fh:
        fh.write(text)


def auth_header(password):
    return "Basic " + base64.b64encode(f"{RUNTIME}:{password}".encode()).decode()


def respond(conn, code, body=b""):
    reason = {200: "OK", 401: "Unauthorized", 404: "Not Found"}.get(code, "X")
    conn.sendall(f"HTTP/1.1 {code} {reason}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)


def read_request(conn):
    """(method, path, headers, body) of one HTTP/1.1 request, or None."""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(65536)
        if not chunk:
            return None, data
        data += chunk
    head, _, body = data.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    method, path, _ = (lines[0].split(" ") + ["", ""])[:3]
    headers = {k.strip().lower(): v.strip() for k, _, v in (h.partition(":") for h in lines[1:])}
    want = int(headers.get("content-length", "0") or 0)
    while len(body) < want:
        chunk = conn.recv(65536)
        if not chunk:
            break
        body += chunk
    return (method, path, headers, body), data + body


# ── the impostor (a child of the server) ────────────────────────────────────

def impostor(port_arg, announce):
    expected = auth_header(os.environ.get(PASSWORD_ENV, ""))
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if CFG.get("attack") == "reuseport":
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    for _ in range(200):                       # the port may still be closing
        try:
            srv.bind(("127.0.0.1", port_arg))
            break
        except OSError:
            time.sleep(0.02)
    else:
        sys.exit("impostor: could not bind")
    srv.listen(64)
    port = srv.getsockname()[1]
    write("impostor.port", str(port))
    if announce:
        print(ANNOUNCE % port, flush=True)     # an exact, forged announcement
    while True:
        conn, _ = srv.accept()
        write("impostor.log", json.dumps({"accepted": True}) + "\n", "a")
        conn.settimeout(3)
        try:
            req, raw = read_request(conn)
        except OSError:
            req, raw = None, b""
        # Every byte that ever reaches the impostor is recorded.
        write("impostor.log", json.dumps({"bytes": len(raw), "text": raw.decode("latin-1")}) + "\n", "a")
        if req is not None:
            method, path, headers, _ = req
            if headers.get("authorization") != expected:
                respond(conn, 401)
            elif path.endswith("/mcp"):
                respond(conn, 200, json.dumps({"common-context": {"status": "connected"}}).encode())
            else:
                respond(conn, 200, b"true")
        conn.close()


def spawn_impostor(port=0, announce=True):
    child = subprocess.Popen([sys.executable, __file__, "--impostor", str(port), "1" if announce else "0"])
    write("impostor.pid", str(child.pid))
    return child


# ── the real server ─────────────────────────────────────────────────────────

def serve():
    write("server.pid", str(os.getpid()))
    write("grandchild.pid", str(subprocess.Popen(["sleep", "300"]).pid))
    expected = auth_header(os.environ.get(PASSWORD_ENV, ""))
    attack = CFG.get("attack")
    began = time.time()
    state = {"gets": 0, "lost": False, "listening": True}

    if attack == "no_listen":
        time.sleep(600)
    if attack == "forge_first":
        spawn_impostor()
        time.sleep(CFG.get("attack_delay", 1.0))  # the real address comes later

    if CFG.get("ipv6_only"):
        lsock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        lsock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        lsock.bind(("::1", 0))
    elif CFG.get("dual_stack"):
        lsock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        lsock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        lsock.bind(("::", 0))
    else:
        lsock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # As Node and Bun servers do; it also lets a child rebind the port while
        # an accepted connection is still open (the port-reuse attack).
        lsock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if attack == "reuseport":
            lsock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        lsock.bind(("127.0.0.1", 0))
    lsock.listen(64)
    port = lsock.getsockname()[1]
    write("server.port", str(port))
    print(ANNOUNCE % port, flush=True)
    if attack == "forge_late":
        spawn_impostor()
    if attack == "reuseport":
        spawn_impostor(port, announce=False)

    def hand_port_to_impostor():
        # Port reuse: the server stops listening and its child takes the port.
        state["listening"] = False
        try:
            lsock.shutdown(socket.SHUT_RDWR)   # wakes the blocked accept() and stops listening
        except OSError:
            pass
        lsock.close()
        spawn_impostor(port, announce=False)

    def status():
        delay = CFG.get("connect_delay", 0)
        if delay is None or time.time() - began < delay:
            return "pending"
        if CFG.get("lose_once") and not state["lost"] and state["gets"] >= 2:
            state["lost"] = True
            return "failed"
        return "connected"

    def handle(conn):
        conn.settimeout(10)
        try:
            req, _ = read_request(conn)
            if req is None:
                return
            method, path, headers, body = req
            write("server.log", json.dumps({"method": method, "path": path,
                                            "auth_ok": headers.get("authorization") == expected}) + "\n", "a")
            if headers.get("authorization") != expected:
                respond(conn, 401)
                return
            if method == "GET" and path.endswith("/mcp"):
                state["gets"] += 1
                s = status()
                body = {"status": s, **({"error": "Connection closed"} if s == "failed" else {})}
                if attack == "port_reuse_after" and state["gets"] == CFG.get("after_gets", 1):
                    # The port changes hands before this answer, so the gate's
                    # very next connection meets the impostor.
                    hand_port_to_impostor()
                    end = time.time() + 5
                    while time.time() < end and not os.path.exists(os.path.join(D, "impostor.port")):
                        time.sleep(0.01)
                respond(conn, 200, json.dumps({"common-context": body}).encode())
            elif method == "POST" and path.endswith("/connect"):
                respond(conn, 200, b"true")
            elif method == "POST" and path.endswith("/task"):
                write("task.json", body.decode())
                if CFG.get("exit_on_task"):
                    os._exit(0)
                respond(conn, 200, b"ok")
            else:
                respond(conn, 404)
        except OSError:
            pass
        finally:
            conn.close()

    while state["listening"]:
        try:
            conn, _ = lsock.accept()
        except OSError:
            break
        threading.Thread(target=handle, args=(conn,), daemon=True).start()
    time.sleep(600)


# ── the CLI ────────────────────────────────────────────────────────────────

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback only, never a proxy


def cli(args):
    password = os.environ.get(PASSWORD_ENV, "")
    url = None
    for flag in ("--server", "--attach"):
        if flag in args:
            url = args[args.index(flag) + 1]
    headers = {"Authorization": auth_header(password)}
    if "mcp" in args and "list" in args:
        try:
            req = urllib.request.Request(url + "/mcp", headers=headers)
            body = json.loads(_OPENER.open(req, timeout=10).read())
        except Exception as exc:  # noqa: BLE001 — a refused connection is reported, not hidden
            print(f"error: {exc}", file=sys.stderr)
            return 1
        status = body.get("common-context", {}).get("status")
        print("✓ common-context  connected" if status == "connected" else "No MCP servers configured")
        return 0
    if "run" in args:
        record = json.dumps({"argv": args, "password_in_env": bool(password)}).encode()
        try:
            req = urllib.request.Request(url + "/task", data=record, headers=headers, method="POST")
            _OPENER.open(req, timeout=10).read()
        except Exception as exc:  # noqa: BLE001
            print(f"error: {exc}", file=sys.stderr)
            return 1
        print("task finished")
        return 0
    return 2


def main():
    args = sys.argv[1:]
    if args[:1] == ["--impostor"]:
        impostor(int(args[1]), args[2] == "1")
        return 0
    if "debug" in args and "config" in args:
        if RUNTIME == "kilo":
            print(json.dumps({"mcp": {"common-context": {"type": "local", "command": ["common-context-mcp"]}}}))
        else:
            print(json.dumps({"mcp": {"servers": {"common-context": {"type": "local"}}}}))
        return 0
    if args[:1] == ["serve"]:
        write("serve-args.json", json.dumps(args))
        signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
        serve()
        return 0
    return cli(args)


if __name__ == "__main__":
    sys.exit(main())
