"""Real OpenCode server/tool/hook regression; only the model endpoint is scripted.

Run: python3 tests/runtime/verify-runtime.py
Set SOURCES_PACKAGE_DIR to an installed package directory to test that artifact.
Uses a fresh temporary HOME, XDG directories, database and two Git projects.
Never connects to the user's shared service or an external model provider.
"""

import base64
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode


REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "tests/fixtures/example.md"
REPO = Path(os.environ.get("SOURCES_PACKAGE_DIR", REPO)).resolve()
TUI = REPO / json.loads((REPO / "package.json").read_text())["exports"]["./tui"]
assert TUI.is_file(), "Package TUI entrypoint must exist; run npm run build:tui"
RUNTIME = shutil.which("opencode")
assert RUNTIME, "opencode must be installed"
TEMP = Path(os.environ.get("TMPDIR", tempfile.gettempdir())) / "opencode"
TEMP.mkdir(exist_ok=True)
stage = next((s for s in ("s5", "s4", "s3", "s2") if "--" + s in sys.argv), "s1")
ROOT = Path(tempfile.mkdtemp(prefix="sources-" + stage + "-", dir=TEMP)).resolve()
ROOT.chmod(0o700)
REQUESTS = []
RESULTS = []


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        REQUESTS.append(body)
        messages = body["messages"]
        user = next(m for m in reversed(messages) if m["role"] == "user")
        text = user["content"]
        if isinstance(text, list):
            text = "\n".join(p.get("text", "") for p in text)
        # The test prompt specifies a call; the second request contains its result.
        marker = text[text.index("S1_CALL ") + 8 :].splitlines()[0]
        call = json.loads(marker)
        completed = messages[-1]["role"] == "tool"
        delta = (
            {"role": "assistant", "content": "Verified."}
            if completed
            else {
                "role": "assistant",
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_s1",
                        "type": "function",
                        "function": {"name": call["name"], "arguments": json.dumps(call["input"])},
                    }
                ],
            }
        )
        if not completed:
            code = "const result = JSON.parse(await tools." + call["name"] + "(" + json.dumps(call["input"]) + "));"
            if call["name"] == "project_sources_read":
                # Bound model-visible output, not the actual Source read. Collect every chunk below.
                code += (
                    "if(result.ok){const chars=Array.from(result.data.content);"
                    + "result.contentLength=chars.length;result.data.content=chars.slice("
                    + str(call.get("offset", 0))
                    + ","
                    + str(call.get("offset", 0) + 4000)
                    + ").join('');}"
                )
            delta["tool_calls"][0]["function"] = {
                "name": "execute",
                "arguments": json.dumps({"code": code + "return result;"}),
            }
        chunks = [
            {
                "id": "chatcmpl-s1",
                "object": "chat.completion.chunk",
                "model": "test",
                "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
            },
            {
                "id": "chatcmpl-s1",
                "object": "chat.completion.chunk",
                "model": "test",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop" if completed else "tool_calls"}],
            },
        ]
        output = "".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(output.encode())))
        self.end_headers()
        self.wfile.write(output.encode())


def check(label, condition):
    assert condition, label
    RESULTS.append(label)
    print("PASS", label, flush=True)


model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
threading.Thread(target=model.serve_forever, daemon=True).start()
env = {k: os.environ[k] for k in ("PATH", "TMPDIR", "LANG") if k in os.environ}
env.update(
    HOME=str(ROOT / "home"),
    XDG_CONFIG_HOME=str(ROOT / "config"),
    XDG_DATA_HOME=str(ROOT / "data"),
    XDG_CACHE_HOME=str(ROOT / "cache"),
    XDG_STATE_HOME=str(ROOT / "state"),
    OPENCODE_DB=str(ROOT / "review.db"),
    OPENCODE_PASSWORD=secrets.token_urlsafe(32),
)
config_path = ROOT / "config/opencode/opencode.json"
config_path.parent.mkdir(parents=True)
config = {
    "plugins": [{"package": str(REPO)}],
    "snapshots": False,
    "update": "disable",
    "model": "review/test",
    "providers": {
        "review": {
            "name": "Loopback test",
            "package": "@opencode/ai/providers/openai-compatible",
            "settings": {"baseURL": f"http://127.0.0.1:{model.server_port}/v1"},
            "models": {
                "test": {
                    "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
                    "limit": {"context": 200000, "output": 4096},
                }
            },
        }
    },
    "permissions": [{"action": "*", "resource": "*", "effect": "allow"}],
}
projects = [ROOT / "project-a", ROOT / "project-b"]
for project in projects:
    project.mkdir()
    subprocess.run(["git", "init", "-q", str(project)], check=True, env=env)
    subprocess.run(
        [
            "git",
            "-C",
            str(project),
            "-c",
            "user.name=S1 Review",
            "-c",
            "user.email=review@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            project.name,
        ],
        check=True,
        env=env,
    )


def status(project):
    return subprocess.check_output(["git", "-C", str(project), "status", "--porcelain"], env=env)


before = [status(p) for p in projects]
server = None
base = ""
auth = "Basic " + base64.b64encode(("opencode:" + env["OPENCODE_PASSWORD"]).encode()).decode()


def api(path, body=None):
    request = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": auth, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{path}: {error.code}: {error.read().decode()}") from None


def stop():
    global server
    if server:
        server.terminate()
        server.wait(timeout=20)
        server = None


def start():
    global server, base
    config_path.write_text(json.dumps(config))
    # Bind an available port; OpenCode itself binds immediately after release.
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    with (ROOT / "server.log").open("ab") as log:
        server = subprocess.Popen(
            [RUNTIME, "serve", "--hostname", "127.0.0.1", "--port", str(port)],
            cwd=projects[0],
            env=env,
            stdout=log,
            stderr=log,
        )
    for _ in range(200):
        assert server.poll() is None, "runtime exited; inspect isolated server.log"
        try:
            return api("/api/info")
        except (OSError, RuntimeError):
            time.sleep(0.1)
    raise TimeoutError("runtime startup")


def session(project):
    return api(
        "/api/session",
        {
            "title": "S1 runtime review",
            "location": {"directory": str(project)},
            "model": {"providerID": "review", "id": "test"},
        },
    )["data"]


def invoke(project, name, args, offset=0):
    current = session(project)
    index = len(REQUESTS)
    api(f"/api/session/{current['id']}/prompt", {"text": "S1_CALL " + json.dumps({"name": name, "input": args, "offset": offset})})
    for _ in range(300):
        requests = REQUESTS[index:]
        outputs = [m for r in requests for m in r["messages"] if m["role"] == "tool"]
        if outputs:
            result = outputs[-1]["content"]
            if isinstance(result, list):
                result = "".join(p.get("text", "") for p in result)
            # Retain the exact model-visible tool response, not model-generated prose.
            try:
                payload = json.loads(result)
            except json.JSONDecodeError:
                raise RuntimeError(f"unexpected tool response: {str(result)[:500]}") from None
            if "ok" not in payload:
                (ROOT / "model-request.json").write_text(json.dumps(requests[0], ensure_ascii=False))
                names = [t["function"]["name"] for t in requests[0].get("tools", [])]
                raise RuntimeError(f"unexpected tool envelope: {str(payload)[:500]}; tools: {names}")
            if payload.get("ok") and "contentLength" in payload:
                length = payload.pop("contentLength")
                content = payload["data"]["content"]
                assert len(content) <= 4000 and offset + len(content) <= length, "Invalid Source chunk"
                if offset + len(content) < length:
                    assert content, "Source chunk made no progress"
                    _, remainder, later_requests = invoke(project, name, args, offset + len(content))
                    assert remainder["ok"], "Source read failed between chunks"
                    assert {k: v for k, v in payload["data"].items() if k != "content"} == {
                        k: v for k, v in remainder["data"].items() if k != "content"
                    }, "Source metadata changed between chunks"
                    payload["data"]["content"] += remainder["data"]["content"]
                    assert offset + len(payload["data"]["content"]) == length, "Incomplete Source read"
                    requests = requests + later_requests
            return current, payload, requests
        time.sleep(0.1)
    raise TimeoutError(f"tool invocation {name}; inspect {ROOT}")


try:
    if "--s5" in sys.argv:
        sys.dont_write_bytecode = True
        from verify_lifecycle import run

        run(globals())
        raise SystemExit(0)
    if "--s4" in sys.argv:
        sys.dont_write_bytecode = True
        from verify_editor import run

        run(globals())
        raise SystemExit(0)
    if "--s3" in sys.argv:
        sys.dont_write_bytecode = True
        from verify_viewer import run

        run(globals())
        raise SystemExit(0)
    if "--s2" in sys.argv:
        sys.dont_write_bytecode = True
        from verify_import import run

        run(globals())
        raise SystemExit(0)
    info = start()
    print("Runtime", info["version"], "evidence directory", ROOT, flush=True)
    location = api("/api/location")
    project_id = location["project"]["id"]
    session(projects[0])
    for _ in range(100):
        loaded = api("/api/plugin")["data"]
        if any(p["id"] == "sourcepier" and p["state"]["status"] == "active" for p in loaded):
            break
        time.sleep(0.1)
    check(
        "plugin active through directory configuration",
        any(p["id"] == "sourcepier" and p["state"]["status"] == "active" for p in loaded),
    )
    imported = api(
        "/api/rpc/sourcepier/importMarkdown?" + urlencode({"location[directory]": str(projects[0])}),
        {"input": {"file": str(FIXTURE)}},
    )["output"]
    check("real Import RPC provisions the test Source", imported["id"] == "example" and imported["revision"] == 1)
    a, listed, requests = invoke(projects[0], "project_sources_list", {})
    check(
        "discovery lists only Example revision 1",
        listed["ok"]
        and listed["data"]["sources"]
        == [
            {
                "id": "example",
                "title": "example",
                "description": "Imported Markdown document",
                "format": "markdown",
                "revision": 1,
            }
        ],
    )
    systems = [m for m in requests[0]["messages"] if m["role"] == "system"]
    system_text = json.dumps(systems, ensure_ascii=False)
    check(
        "both Agent tools registered in Code Mode catalog",
        all("tools." + n in system_text for n in ["project_sources_list", "project_sources_read"]),
    )
    original = FIXTURE.read_bytes()
    check(
        "real context hook injects index, not example body",
        "SourcePier (developer-designated" in system_text
        and "example" in system_text
        and original.decode()[:500] not in system_text,
    )
    a, read_a, _ = invoke(projects[0], "project_sources_read", {"id": "example"})
    check("complete UTF-8 ADR equality", read_a["ok"] and read_a["data"]["content"].encode() == original)
    b, read_b, _ = invoke(projects[0], "project_sources_read", {"id": "example"})
    check(
        "independent Sessions share ID, revision and complete body",
        a["id"] != b["id"] and a["projectID"] == b["projectID"] == project_id and read_a == read_b,
    )
    stop()
    start()
    c, read_c, _ = invoke(projects[0], "project_sources_read", {"id": "example"})
    check("full restart without seed retains complete ADR", c["id"] not in [a["id"], b["id"]] and read_c == read_a)
    d, isolated_list, _ = invoke(projects[1], "project_sources_list", {})
    check(
        "different Project cannot list A's sources",
        d["projectID"] != project_id and isolated_list["data"]["sources"] == [],
    )
    _, isolated_read, _ = invoke(projects[1], "project_sources_read", {"id": "example"})
    check("different Project cannot read A's ADR", isolated_read["error"]["code"] == "SOURCE_NOT_FOUND")
    for source_id, expected in [("missing", "SOURCE_NOT_FOUND"), ("../example", "INVALID_SOURCE_ID")]:
        _, result, _ = invoke(projects[0], "project_sources_read", {"id": source_id})
        check(expected, result == {"ok": False, "error": {"code": expected, "message": expected}})
    # A test-only loader writes corrupt records through the real plugin-scoped KV.
    # It imports the unchanged production plugin, then registers its real tools.
    stop()
    fixture_directory = ROOT / "fault-fixtures"
    fixture_directory.mkdir()
    fixture_plugin = fixture_directory / "index.ts"
    fixture_plugin.write_text(
        "import plugin from "
        + json.dumps(str(REPO / "index.ts"))
        + "\n"
        + """
export default { ...plugin, async setup(ctx) {
  const dispose = await plugin.setup(ctx)
  const projectID = ctx.location.project.id
  for (const [id, fault] of [['missing-body', 'body'], ['bad-schema', 'schema'], ['bad-pointer', 'pointer']]) {
    await ctx.storage.set(`projects/${projectID}/meta/${id}`, {
      schemaVersion: fault === 'schema' ? 2 : 1, id, projectID, title: id,
      format: 'markdown', revision: 1,
      bodyKey: `projects/${fault === 'pointer' ? 'another-project' : projectID}/body/${id}/r000001`,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    })
  }
  return dispose
} }
"""
    )
    config["plugins"][0]["package"] = str(fixture_directory)
    start()
    for source_id, expected in [
        ("missing-body", "DATA_INTEGRITY_ERROR"),
        ("bad-schema", "UNSUPPORTED_SCHEMA"),
        ("bad-pointer", "DATA_INTEGRITY_ERROR"),
    ]:
        _, result, _ = invoke(projects[0], "project_sources_read", {"id": source_id})
        check(
            "runtime " + source_id + " fails closed",
            result == {"ok": False, "error": {"code": expected, "message": expected}},
        )
    check("target repository status unchanged", before == [status(p) for p in projects])
    check(
        "no target working-tree files created",
        all(not [f for f in p.rglob("*") if f.is_file() and ".git" not in f.relative_to(p).parts] for p in projects),
    )
    print("ADR bytes", len(original), "SHA-256", hashlib.sha256(original).hexdigest(), flush=True)
    (ROOT / "results.json").write_text(
        json.dumps(
            {
                "version": info["version"],
                "project_a": project_id,
                "project_b": d["projectID"],
                "passes": RESULTS,
                "sha256": hashlib.sha256(original).hexdigest(),
                "bytes": len(original),
                "sessions": [a["id"], b["id"], c["id"], d["id"]],
            },
            indent=2,
        )
    )
finally:
    stop()
    model.shutdown()
    print("Retained isolated evidence:", ROOT, flush=True)
