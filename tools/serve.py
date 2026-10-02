"""Local server for SG Walk Shortcut: serves the app and adds POST /api/directions.

    python tools/serve.py            # http://127.0.0.1:8731/
    python tools/serve.py --port 9000 --env ../lunch-uncle/.env

/api/directions takes {"facts": {...}} (the router's steps, from directionsFacts() in router.js) and asks the
OpenCode Go model to reword them as plain-English directions. The API key is read on this machine from the
OPENCODE_API_KEY environment variable, or from the .env file given by --env, and is never sent to the browser.
The browser can't call OpenCode directly anyway: the endpoint doesn't answer CORS preflights.
"""
import argparse
import functools
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_ENV = os.path.join(os.path.dirname(APP_DIR), "lunch-uncle", ".env")
LLM_BASE_URL = "https://opencode.ai/zen/go/v1"
LLM_MODEL = "glm-5.3-flash"
LLM_TIMEOUT_S = 45
MAX_BODY = 32_000

SYSTEM_PROMPT = """You write walking directions for people in Singapore. You get a route that a pedestrian router computed, as JSON: where it starts and ends, and the steps in order. Each step has the turn to make, what it walks along (a street, footpath, covered linkway, overhead bridge, crossing, or a building it cuts through such as an HDB void deck or a mall) and its length in metres.

Rewrite it as directions a helpful local would give:
- Use only the facts in the JSON. Do not add shops, exits, landmarks or street names that are not in it.
- Combine short or obvious steps, aiming for 4 to 9 steps. Keep every building cut-through and every road crossing visible.
- Use local terms: void deck, Blk, linkway, overhead bridge.
- Round distances (about 50 m, about 200 m).
- If "from" or "to" is "map pin", say "your start" or "your destination".
- If weather.rain is true, begin with one line starting "Rain:" that names the forecast, the area and the period, says what share of the walk is sheltered, and points out the longest steps where "sheltered" is false. In the steps, mention when a stretch is uncovered. Do not change or reorder the route for the rain.
- If weather is missing or weather.rain is false, do not mention the weather.

Reply with only the optional "Rain:" line, then a numbered list with one step per line, then one last line starting "Total:" with the distance and walking minutes."""


def read_key(env_path):
    if os.environ.get("OPENCODE_API_KEY"):
        return os.environ["OPENCODE_API_KEY"].strip()
    try:
        with open(env_path, encoding="utf-8") as fh:
            for line in fh:
                k, sep, v = line.strip().partition("=")
                if sep and k.strip() == "OPENCODE_API_KEY":
                    return v.strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def ask_model(key, facts):
    body = json.dumps({
        "model": LLM_MODEL,
        # glm-5.3-flash reasons at length by default (~55 s); "low" answers in a few seconds. Of the OpenCode Go
        # models tried on a 19-step route at low effort, it was also the fastest (6 s; others 12-32 s).
        "reasoning_effort": "low",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(facts, ensure_ascii=False)},
        ],
    }).encode()
    req = urllib.request.Request(f"{LLM_BASE_URL}/chat/completions", data=body, method="POST", headers={
        "content-type": "application/json",
        "authorization": f"Bearer {key}",
        "x-opencode-session": str(uuid.uuid4()),
        "user-agent": "sg-walk-shortcut/0.1",
    })
    with urllib.request.urlopen(req, timeout=LLM_TIMEOUT_S) as res:
        data = json.load(res)
    return (data["choices"][0]["message"].get("content") or "").strip()


class Handler(SimpleHTTPRequestHandler):
    key = ""

    def end_headers(self):
        # Always revalidate, so a reload picks up edited app files instead of a stale cached copy.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != "/api/directions":
            return self.send_json(404, {"error": "not found"})
        if not self.key:
            return self.send_json(503, {"error": "No OPENCODE_API_KEY found on the server. Set it, or pass --env."})
        length = int(self.headers.get("content-length") or 0)
        if not 0 < length <= MAX_BODY:
            return self.send_json(413, {"error": "Route too long to describe."})
        try:
            facts = json.loads(self.rfile.read(length))["facts"]
            if not isinstance(facts, dict) or not isinstance(facts.get("steps"), list):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return self.send_json(400, {"error": "Expected {\"facts\": {...steps...}}."})
        try:
            text = ask_model(self.key, facts)
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            self.log_message("OpenCode %s: %s", e.code, detail)
            msg = "The OpenCode key was rejected." if e.code in (401, 403) else f"OpenCode returned {e.code}."
            return self.send_json(502, {"error": msg})
        except (urllib.error.URLError, TimeoutError) as e:
            return self.send_json(504, {"error": f"Could not reach OpenCode ({getattr(e, 'reason', e)})."})
        except (KeyError, IndexError, ValueError):
            return self.send_json(502, {"error": "OpenCode sent an unexpected reply."})
        if not text:
            return self.send_json(502, {"error": "The model returned no text."})
        self.send_json(200, {"text": text, "model": LLM_MODEL})


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8731)
    ap.add_argument("--env", default=DEFAULT_ENV, help="a .env file holding OPENCODE_API_KEY")
    args = ap.parse_args()
    Handler.key = read_key(args.env)
    print(f"OpenCode key: {'found' if Handler.key else 'NOT found'} ({'env var' if os.environ.get('OPENCODE_API_KEY') else args.env})")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), functools.partial(Handler, directory=APP_DIR))
    print(f"Serving {APP_DIR} at http://127.0.0.1:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
