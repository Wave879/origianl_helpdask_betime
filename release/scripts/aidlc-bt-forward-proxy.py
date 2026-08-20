import os
import socket
import socketserver
from pathlib import Path
from urllib.parse import urlsplit

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("AIDLC_BT_PROXY_PORT", "3129"))
TARGET_HOSTNAMES = {"aidlc-bt.demotoday.net", "bt84-arr.demotoday.net"}
ROOT_DIR = Path(__file__).resolve().parent.parent
PORT_FILE = ROOT_DIR / ".tmp" / "betime-local-port.txt"
TOOL_PORT = 9102


def get_local_port() -> int:
    try:
        raw = PORT_FILE.read_text(encoding="utf-8").strip()
        port = int(raw)
        if 0 < port < 65536:
            return port
    except Exception:
        pass
    return 8788


def strip_web_prefix(pathname: str) -> str:
    if pathname in {"/web", "/web/"}:
        return "/"
    if pathname.startswith("/web/"):
        return pathname[len("/web") :]
    return pathname or "/"


def choose_backend(pathname: str):
    if pathname == "/tool" or pathname.startswith("/tool/"):
        return TOOL_PORT
    return get_local_port()


def rewrite_request(raw: bytes):
    head, sep, body = raw.partition(b"\r\n\r\n")
    if not sep:
        return None
    lines = head.decode("utf-8", errors="replace").split("\r\n")
    if not lines:
        return None
    method, target, version = (lines[0].split(" ", 2) + ["HTTP/1.1"])[:3]
    headers = {}
    ordered = []
    for line in lines[1:]:
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        lname = name.strip().lower()
        v = value.strip()
        headers[lname] = v
        ordered.append((lname, v))

    try:
        parsed = urlsplit(target)
        if parsed.scheme:
            hostname = parsed.hostname or ""
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            path = (parsed.path or "/") + ("?" + parsed.query if parsed.query else "")
        else:
            host = headers.get("host", "")
            parsed = urlsplit(f"http://{host}{target}")
            hostname = parsed.hostname or ""
            port = parsed.port or 80
            path = (parsed.path or "/") + ("?" + parsed.query if parsed.query else "")
    except Exception:
        return None

    if hostname in TARGET_HOSTNAMES:
        if target in {"/", "http://aidlc-bt.demotoday.net/", "http://bt84-arr.demotoday.net/"} or path == "/":
            return ("__redirect__", 302, "/web/")
        if path == "/tool":
            return ("__redirect__", 301, "/tool/")

        local_port = choose_backend(path)
        if local_port is None:
            return ("__status__", 404, "")
        hostname = "127.0.0.1"
        port = local_port
        headers["host"] = headers.get("host", f"127.0.0.1:{local_port}")
        if path == "/web" or path.startswith("/web/"):
            path = strip_web_prefix(path)

    out = [f"{method} {path} {version}"]
    seen = set()
    for name, value in ordered:
        if name in {"proxy-connection", "connection", "content-length"}:
            continue
        if name == "host":
            value = headers.get("host", value)
        out.append(f"{name.title()}: {value}")
        seen.add(name)

    if "host" not in seen:
        out.append(f"Host: {headers.get('host', '')}")

    if body:
        out.append(f"Content-Length: {len(body)}")

    payload = ("\r\n".join(out) + "\r\n\r\n").encode("utf-8") + body
    return hostname, port, payload


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(10)
        try:
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = self.request.recv(4096)
                if not chunk:
                    return
                data += chunk
                if len(data) > 1024 * 1024:
                    return

            rewritten = rewrite_request(data)
            if not rewritten:
                self.request.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                return

            if rewritten[0] == "__redirect__":
                _, status, location = rewritten
                reason = "Found" if status == 302 else "Moved Permanently"
                self.request.sendall(
                    f"HTTP/1.1 {status} {reason}\r\nLocation: {location}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".encode("utf-8")
                )
                return

            if rewritten[0] == "__status__":
                _, status, _ = rewritten
                reason = "Not Found" if status == 404 else "Bad Request"
                self.request.sendall(
                    f"HTTP/1.1 {status} {reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".encode("utf-8")
                )
                return

            hostname, port, payload = rewritten
            upstream = socket.create_connection((hostname, port), timeout=10)
            with upstream:
                upstream.settimeout(10)
                upstream.sendall(payload)
                while True:
                    chunk = upstream.recv(65536)
                    if not chunk:
                        break
                    self.request.sendall(chunk)
        except Exception:
            try:
                self.request.sendall(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            except Exception:
                pass


class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with ThreadingTCPServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler) as server:
        print(f"AIDLC BT proxy listening on http://{LISTEN_HOST}:{LISTEN_PORT}", flush=True)
        server.serve_forever()
