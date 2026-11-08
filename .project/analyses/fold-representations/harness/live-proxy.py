#!/usr/bin/env python3
"""Logging, budget-capped proxy to deepseek-flash. argv: <log-dir> <usd-cap>. Prints its port; the key never leaves this process."""
import http.server, json, os, subprocess, sys, threading
import requests

LOG, CAP = sys.argv[1], float(sys.argv[2])
os.makedirs(LOG, exist_ok=True)
auth = json.load(open(os.path.expanduser("~/.pig/agent/auth.json")))["deepseek"]
key = auth["key"]
spent, n, lock = 0.0, 0, threading.Lock()

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *a): pass
    def do_POST(self):
        global spent, n
        if self.path not in ("/chat/completions", "/v1/chat/completions"): return self.send_error(404)
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        body = json.loads(raw)
        body["max_tokens"] = min(int(body.get("max_tokens") or 4096), 4096)
        payload = json.dumps(body, separators=(",", ":")).encode()
        est = (len(payload) / 3.5) * 0.3 / 1e6
        with lock:
            if spent + est > CAP: return self.send_error(429, "budget cap")
            spent += est; n += 1; idx = n
        open(f"{LOG}/req-{idx:04d}.json", "wb").write(payload)
        usage = None
        try:
            with requests.post("https://api.deepseek.com/chat/completions", data=payload, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, stream=True, timeout=(15, 300)) as r:
                self.send_response(r.status_code); self.send_header("Content-Type", r.headers.get("Content-Type", "application/json")); self.send_header("Connection", "close"); self.end_headers()
                for line in r.iter_lines(chunk_size=256):
                    if line.startswith(b"data: {"):
                        try:
                            u = json.loads(line[6:]).get("usage")
                            if u: usage = u
                        except Exception: pass
                    self.wfile.write(line + b"\n"); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError): pass
        finally:
            if usage:
                open(f"{LOG}/usage-{idx:04d}.json", "w").write(json.dumps(usage))
                hit = int(usage.get("prompt_cache_hit_tokens") or 0); miss = int(usage.get("prompt_cache_miss_tokens") or 0)
                with lock: spent += miss * 0.3 / 1e6 + hit * 0.006 / 1e6 + int(usage.get("completion_tokens") or 0) * 1.2 / 1e6 - est

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
