#!/usr/bin/env python3
import http.server, json, subprocess, sys, threading
import requests

CLI = "/mnt/Projects/furbyhaxx/pi-accordion/.pi/worktrees/taskfold-tree/extension/node_modules/.bin/pi"
result = subprocess.run([CLI, "auth", "print-api-key", "--provider", "deepseek", "--model", "deepseek-flash"], capture_output=True, text=True, timeout=30)
if result.returncode or not result.stdout.strip() or "\n" in result.stdout.strip():
    raise SystemExit("Provider credentials unavailable")
key = result.stdout.strip()
cap = 5.0
spent = 0.0
lock = threading.Lock()

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *_args):
        pass
    def do_POST(self):
        global spent
        if self.path not in ("/chat/completions", "/v1/chat/completions"):
            self.send_error(404); return
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        try:
            body = json.loads(raw)
            body["max_tokens"] = min(int(body.get("max_tokens") or 4096), 4096)
            payload = json.dumps(body, separators=(",", ":")).encode()
        except Exception:
            self.send_error(400); return
        estimate = (len(payload) + 10000) * 0.3 / 1_000_000 + body["max_tokens"] * 1.2 / 1_000_000
        with lock:
            if spent + estimate > cap:
                self.send_error(429, "Evaluation budget cap reached"); return
            spent += estimate
        usage = None
        try:
            with requests.post("https://api.deepseek.com/chat/completions", data=payload, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, stream=True, timeout=(15, 300)) as r:
                self.send_response(r.status_code)
                self.send_header("Content-Type", r.headers.get("Content-Type", "application/json"))
                self.send_header("Connection", "close")
                self.end_headers()
                for line in r.iter_lines(chunk_size=256):
                    if line.startswith(b"data: {"):
                        try:
                            u = json.loads(line[6:]).get("usage")
                            if u: usage = u
                        except Exception:
                            pass
                    self.wfile.write(line + b"\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            pass
        finally:
            if usage:
                input_tokens = int(usage.get("prompt_tokens") or 0)
                cached = int(usage.get("prompt_cache_hit_tokens") or 0)
                output_tokens = int(usage.get("completion_tokens") or 0)
                actual = max(0, input_tokens - cached) * 0.3 / 1_000_000 + cached * 0.006 / 1_000_000 + output_tokens * 1.2 / 1_000_000
                with lock:
                    spent += actual - estimate

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
