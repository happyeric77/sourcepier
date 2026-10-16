"""Real import scenarios for verify-runtime.py --s2, using installed TUI/RPC/tools."""

import fcntl
import hashlib
import json
import os
import pty
import re
import select
import struct
import subprocess
import termios
import time
from types import SimpleNamespace
from urllib.parse import urlencode


class Terminal:
    def __init__(self, h, project):
        self.evidence = h.ROOT / ("tui-" + project.name + ".ansi")
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 160, 0, 0))
        self.process = subprocess.Popen(
            [h.RUNTIME, "--server", h.base, str(project)],
            env={**h.env, "TERM": "xterm-256color", "COLORTERM": "truecolor"},
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        self.raw = bytearray()

    def pump(self, seconds=1):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            if select.select([self.master], [], [], 0.05)[0]:
                try:
                    data = os.read(self.master, 65536)
                except OSError:
                    break
                self.raw.extend(data)
                # Answer terminal capability/position queries; no emulator or mocked TUI.
                if b"\x1b[6n" in data:
                    os.write(self.master, b"\x1b[1;1R")
                if b"\x1b[c" in data or b"\x1b[0c" in data:
                    os.write(self.master, b"\x1b[?1;2c")

    def send(self, text):
        os.write(self.master, text.encode())
        self.pump()

    def wait(self, text, seconds=15, since=0):
        start = time.monotonic()
        while time.monotonic() - start < seconds:
            self.pump(0.2)
            clean = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", self.raw[since:]).decode(errors="replace")
            if text in re.sub(r"\s+", " ", clean):
                return
            assert self.process.poll() is None, "TUI exited; inspect terminal evidence"
        raise AssertionError("TUI text not observed: " + text)

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.pump(0.1)
        self.evidence.write_bytes(self.raw)
        os.close(self.master)


def run(namespace):
    h = SimpleNamespace(**namespace)
    info = h.start()
    h.base = namespace["base"]
    print("Runtime", info["version"], "S2 evidence directory", h.ROOT, flush=True)
    a = h.session(h.projects[0])
    b = h.session(h.projects[1])
    h.check("independent projects have distinct native IDs", a["projectID"] != b["projectID"])
    # Prepare an existing Source with the normal production Import RPC.
    query = urlencode({"location[directory]": str(h.projects[0])})
    receipt = h.api("/api/rpc/sourcepier/importMarkdown?" + query, {"input": {"file": str(h.FIXTURE)}})["output"]
    h.check("normal Import provisions the preexisting Source", receipt["id"] == "example" and receipt["revision"] == 1)
    _, prior, _ = h.invoke(h.projects[0], "project_sources_read", {"id": "example"})
    h.check("preexisting imported Source is readable", prior["ok"])
    fixtures = h.ROOT / "external Markdown"
    fixtures.mkdir()
    errors = []
    original = h.FIXTURE.read_bytes()
    fixture = fixtures / "TUI Canonical.md"
    fixture.write_bytes(original)

    def rpc(project, file, **extra):
        query = urlencode({"location[directory]": str(project)})
        return h.api("/api/rpc/sourcepier/importMarkdown?" + query, {"input": {"file": str(file), **extra}})

    def error(project, file, expected, **extra):
        try:
            rpc(project, file, **extra)
        except RuntimeError as failure:
            message = str(failure)
            h.check("RPC rejects " + expected, expected in message and str(fixtures) not in message)
            errors.append(json.loads(message[message.index("{") :]))
        else:
            raise AssertionError("RPC unexpectedly accepted " + expected)

    tui = Terminal(h, h.projects[0])
    try:
        tui.pump(5)
        tui.send("\x1b[200~/sources add\x1b[201~")
        tui.send("\r")
        tui.wait("Import Markdown as Project Source")
        h.check("real /sources add opens native path prompt", True)
        tui.send(str(fixture))
        tui.send("\r")
        tui.wait("Duplicate Source IDs are rejected.")
        h.check("real TUI asks confirmation", True)
        tui.send("\r")
        tui.wait("Imported tui-canonical.")
        h.check("real TUI imports Markdown through RPC", True)
        mark = len(tui.raw)
        tui.send("\x1b[200~/sources add\x1b[201~")
        tui.send("\r")
        tui.wait("Import Markdown as Project Source", since=mark)
        tui.send("\x1b")
        h.check("real TUI path prompt can be cancelled", True)
        shortcut = fixtures / "Shortcut File.md"
        shortcut.write_text("# Shortcut\n")
        mark = len(tui.raw)
        tui.send('\x1b[200~/sources add "' + str(shortcut) + '"\x1b[201~')
        tui.send("\r")
        tui.wait("Duplicate Source IDs", since=mark)
        tui.send("\r")
        tui.wait("Imported shortcut-file.", since=mark)
        h.check("real /sources add accepts quoted paths with spaces", True)
        mark = len(tui.raw)
        tui.send("\x10")
        tui.send("Import Project Source")
        tui.send("\r")
        tui.wait("~/Documents/architecture.md", since=mark)
        tui.send(str(fixtures / "cancelled.md"))
        mark = len(tui.raw)
        tui.send("\r")
        tui.wait("Duplicate Source IDs", since=mark)
        tui.send("\x1b")
        h.check("command palette opens import and confirmation cancels", True)
    finally:
        tui.close()

    reader_a, read, requests = h.invoke(h.projects[0], "project_sources_read", {"id": "tui-canonical"})
    h.check(
        "independent Session immediately reads full TUI import",
        read["ok"] and read["data"]["content"].encode() == original,
    )
    system = json.dumps([m for m in requests[0]["messages"] if m["role"] == "system"])
    h.check(
        "import discovery uses index only and Agent exposes no write tool",
        "tui-canonical" in system
        and "tools.project_sources_read" in system
        and "tools.project_sources_import" not in system
        and original.decode()[:500] not in system,
    )
    h.check("TUI import leaves original Markdown unchanged", fixture.read_bytes() == original)
    # Explicit RPC B routing while server's default Location remains A.
    routed = fixtures / "Only B.md"
    routed.write_text("\ufeff# Project B\n\n你好 😊\n")
    response = rpc(h.projects[1], routed)
    h.check("RPC routes to B rather than server default A", response["output"]["id"] == "only-b")
    _, read_b, _ = h.invoke(h.projects[1], "project_sources_read", {"id": "only-b"})
    h.check(
        "B reads exact BOM and Unicode snapshot",
        read_b["ok"] and read_b["data"]["content"].encode() == routed.read_bytes(),
    )
    unicode_file = fixtures / "文件.md"
    unicode_file.write_text("# Unicode filename\n")
    unicode_id = "source-" + hashlib.sha256("文件".encode()).hexdigest()[:12]
    h.check(
        "Unicode filename has deterministic safe ID", rpc(h.projects[1], unicode_file)["output"]["id"] == unicode_id
    )
    error(h.projects[1], unicode_file, "already_exists")
    tui_b_file = fixtures / "TUI B.md"
    tui_b_file.write_text("# TUI in Project B\n")
    tui = Terminal(h, h.projects[1])
    try:
        tui.pump(5)
        tui.send('\x1b[200~/sources add "' + str(tui_b_file) + '"\x1b[201~')
        tui.send("\r")
        tui.wait("Duplicate Source IDs")
        tui.send("\r")
        tui.wait("Imported tui-b.")
    finally:
        tui.close()
    _, tui_b, _ = h.invoke(h.projects[1], "project_sources_read", {"id": "tui-b"})
    _, not_a, _ = h.invoke(h.projects[0], "project_sources_read", {"id": "tui-b"})
    h.check("real TUI in B imports into B, not default A", tui_b["ok"] and not_a["error"]["code"] == "SOURCE_NOT_FOUND")
    for project, source in [(h.projects[0], "only-b"), (h.projects[1], "tui-canonical")]:
        _, absent, _ = h.invoke(project, "project_sources_read", {"id": source})
        h.check("cross-project read denied: " + source, absent["error"]["code"] == "SOURCE_NOT_FOUND")
    error(h.projects[0], fixture, "already_exists")
    error(h.projects[0], h.FIXTURE, "already_exists")
    _, preserved, _ = h.invoke(h.projects[0], "project_sources_read", {"id": "example"})
    h.check("S2 preserves preexisting existing example and rejects same-ID import", preserved == prior)
    fixture.write_text("# Changed original; must never overwrite KV\n")
    error(h.projects[0], fixture, "already_exists")
    _, same, _ = h.invoke(h.projects[0], "project_sources_read", {"id": "tui-canonical"})
    h.check("duplicate cannot change content or revision", same == read)
    for name, content, expected in [
        ("wrong.txt", b"# Wrong", "invalid_path"),
        ("empty.md", b" \n", "invalid_markdown"),
        ("invalid.md", b"\xc3\x28", "invalid_markdown"),
        ("large.md", b"x" * (256 * 1024 + 1), "invalid_markdown"),
        ("a" * 201 + ".md", b"# Long title", "invalid_path"),
    ]:
        path = fixtures / name
        path.write_bytes(content)
        error(h.projects[0], path, expected)
    error(h.projects[0], fixtures / "missing.md", "invalid_path")
    spoof = fixtures / "Spoof.md"
    spoof.write_text("# Location wins\n")
    rpc(h.projects[0], spoof, projectID=b["projectID"])
    _, scoped, _ = h.invoke(h.projects[0], "project_sources_read", {"id": "spoof"})
    _, not_b, _ = h.invoke(h.projects[1], "project_sources_read", {"id": "spoof"})
    h.check(
        "caller projectID cannot override RPC Location", scoped["ok"] and not_b["error"]["code"] == "SOURCE_NOT_FOUND"
    )
    _, listed, _ = h.invoke(h.projects[0], "project_sources_list", {})
    h.check(
        "failed and cancelled imports publish no metadata",
        [s["id"] for s in listed["data"]["sources"]] == ["example", "shortcut-file", "spoof", "tui-canonical"],
    )
    _, listed_b, _ = h.invoke(h.projects[1], "project_sources_list", {})
    h.check(
        "Project B lists only its own imports",
        {s["id"] for s in listed_b["data"]["sources"]} == {"only-b", unicode_id, "tui-b"},
    )
    fixture.rename(fixtures / "renamed.md")
    h.stop()
    h.start()
    reader_c, after, _ = h.invoke(h.projects[0], "project_sources_read", {"id": "tui-canonical"})
    h.check("full server restart and renamed original retain snapshot", after == read)
    h.check("both target repositories unchanged", h.before == [h.status(p) for p in h.projects])
    h.check(
        "no source copies or config written into projects", all(list(p.iterdir()) == [p / ".git"] for p in h.projects)
    )
    (h.ROOT / "results.json").write_text(
        json.dumps(
            {
                "version": info["version"],
                "project_a": a["projectID"],
                "project_b": b["projectID"],
                "passes": h.RESULTS,
                "sha256": hashlib.sha256(original).hexdigest(),
                "bytes": len(original),
                "sessions": [a["id"], reader_a["id"], reader_c["id"]],
                "rpc_b": response,
                "rpc_errors": errors,
                "list_a": listed,
                "list_b": listed_b,
            },
            indent=2,
        )
    )
