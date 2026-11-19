#!/usr/bin/env python3
"""Local dev server for TERRA Earth Raytracer with persistent disk cache for AI-enriched textures."""

import http.server
import json
import os
import re
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
AI_CACHE_DIR = os.path.join(BASE_DIR, "textures", "ai_cache")
os.makedirs(AI_CACHE_DIR, exist_ok=True)

SAFE_NAME_RE = re.compile(r"^[a-zA-Z0-9._-]+$")


class TerraHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def _safe_cache_path(self):
        prefix = "/api/ai-cache/"
        if not self.path.startswith(prefix):
            return None
        name = self.path[len(prefix):].split("?", 1)[0]
        if not name or not SAFE_NAME_RE.match(name) or ".." in name:
            return None
        return os.path.join(AI_CACHE_DIR, name)

    def do_GET(self):
        if self.path == "/api/ai-cache":
            files = sorted(
                f for f in os.listdir(AI_CACHE_DIR)
                if f.endswith((".png", ".jpg", ".jpeg", ".webp"))
            )
            payload = json.dumps({"count": len(files), "files": files}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        cache_path = self._safe_cache_path()
        if cache_path is not None:
            if not os.path.isfile(cache_path):
                self.send_error(404, "Not cached")
                return
            with open(cache_path, "rb") as f:
                data = f.read()
            ctype = "image/jpeg" if cache_path.endswith((".jpg", ".jpeg")) else "image/png"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return

        super().do_GET()

    def do_PUT(self):
        cache_path = self._safe_cache_path()
        if cache_path is None:
            self.send_error(400, "Invalid cache key")
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 25 * 1024 * 1024:
            self.send_error(413, "Payload too large or empty")
            return
        data = self.rfile.read(length)
        with open(cache_path, "wb") as f:
            f.write(data)
        self.send_response(204)
        self.end_headers()

    def do_DELETE(self):
        if self.path == "/api/ai-cache":
            removed = 0
            for f in os.listdir(AI_CACHE_DIR):
                if f.endswith((".png", ".jpg", ".jpeg", ".webp")):
                    os.remove(os.path.join(AI_CACHE_DIR, f))
                    removed += 1
            payload = json.dumps({"removed": removed}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_error(404, "Not found")


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    with ReusableTCPServer(("", PORT), TerraHandler) as httpd:
        print(f"TERRA server listening on http://localhost:{PORT} (AI disk cache: {AI_CACHE_DIR})", flush=True)
        httpd.serve_forever()
