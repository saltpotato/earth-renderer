#!/usr/bin/env python3
"""Local dev server for TERRA Earth Raytracer with persistent disk cache & local Real-ESRGAN GPU upscaling."""

import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.parse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
AI_CACHE_DIR = os.path.join(BASE_DIR, "textures", "ai_cache")
ESRGAN_DIR = os.path.join(BASE_DIR, "tools", "realesrgan")
ESRGAN_BIN = os.path.join(ESRGAN_DIR, "realesrgan-ncnn-vulkan")
ESRGAN_MODELS = os.path.join(ESRGAN_DIR, "models")
os.makedirs(AI_CACHE_DIR, exist_ok=True)

SAFE_NAME_RE = re.compile(r"^[a-zA-Z0-9._-]+$")
ALLOWED_MODELS = {"realesrgan-x4plus", "realesr-animevideov3-x2", "realesr-animevideov3-x4"}
GPU_LOCK = threading.Lock()


def has_esrgan():
    return os.path.isfile(ESRGAN_BIN) and os.access(ESRGAN_BIN, os.X_OK)


class TerraHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def _safe_cache_path(self, name):
        if not name or not SAFE_NAME_RE.match(name) or ".." in name:
            return None
        return os.path.join(AI_CACHE_DIR, name)

    def do_GET(self):
        if self.path == "/api/ai-cache":
            files = sorted(
                f for f in os.listdir(AI_CACHE_DIR)
                if f.endswith((".png", ".jpg", ".jpeg", ".webp"))
            )
            payload = json.dumps({
                "count": len(files),
                "files": files,
                "esrgan": has_esrgan(),
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        if self.path.startswith("/api/ai-cache/"):
            name = self.path[len("/api/ai-cache/"):].split("?", 1)[0]
            cache_path = self._safe_cache_path(name)
            if cache_path is None or not os.path.isfile(cache_path):
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

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/ai-upscale":
            self.send_error(404, "Not found")
            return

        if not has_esrgan():
            self.send_error(503, "Real-ESRGAN binary not installed")
            return

        qs = urllib.parse.parse_qs(parsed.query)
        name = (qs.get("key") or [""])[0]
        model = (qs.get("model") or ["realesrgan-x4plus"])[0]
        if model not in ALLOWED_MODELS:
            model = "realesrgan-x4plus"

        cache_path = self._safe_cache_path(name)
        if cache_path is None:
            self.send_error(400, "Invalid cache key")
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 25 * 1024 * 1024:
            self.send_error(413, "Invalid payload size")
            return

        in_bytes = self.rfile.read(length)

        # Serve immediately if already cached on disk
        if os.path.isfile(cache_path):
            with open(cache_path, "rb") as f:
                out_bytes = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(out_bytes)))
            self.end_headers()
            self.wfile.write(out_bytes)
            return

        tmp_in = None
        is_jpg = cache_path.endswith((".jpg", ".jpeg"))
        out_fmt = "jpg" if is_jpg else "png"
        out_ctype = "image/jpeg" if is_jpg else "image/png"
        tmp_out = cache_path + f".tmp.{out_fmt}"
        try:
            with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tf:
                tf.write(in_bytes)
                tmp_in = tf.name

            cmd = [
                ESRGAN_BIN,
                "-i", tmp_in,
                "-o", tmp_out,
                "-m", ESRGAN_MODELS,
                "-n", model,
                "-t", "256",
                "-f", out_fmt,
            ]
            with GPU_LOCK:
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if res.returncode != 0 or not os.path.isfile(tmp_out):
                msg = (res.stderr or res.stdout or "Real-ESRGAN failed").strip()
                self.send_error(500, msg[:200])
                return

            os.replace(tmp_out, cache_path)
            with open(cache_path, "rb") as f:
                out_bytes = f.read()

            self.send_response(200)
            self.send_header("Content-Type", out_ctype)
            self.send_header("Content-Length", str(len(out_bytes)))
            self.end_headers()
            self.wfile.write(out_bytes)
        except Exception as exc:
            self.send_error(500, str(exc))
        finally:
            if tmp_in and os.path.isfile(tmp_in):
                os.remove(tmp_in)
            if os.path.isfile(tmp_out):
                os.remove(tmp_out)

    def do_PUT(self):
        if not self.path.startswith("/api/ai-cache/"):
            self.send_error(400, "Invalid path")
            return
        name = self.path[len("/api/ai-cache/"):].split("?", 1)[0]
        cache_path = self._safe_cache_path(name)
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
        mode = "Real-ESRGAN Metal GPU READY" if has_esrgan() else "Cache only"
        print(f"TERRA server listening on http://localhost:{PORT} ({mode}, cache: {AI_CACHE_DIR})", flush=True)
        httpd.serve_forever()
