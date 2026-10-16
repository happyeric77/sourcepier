"""Native Viewer scenarios with real TUI/RPC and the isolated runtime harness."""

import fcntl
import hashlib
import json
import os
import re
import signal
import struct
import subprocess
import termios
import time
from types import SimpleNamespace
from urllib.parse import urlencode

from verify_import import Terminal


class Browser(Terminal):
    def __init__(self, h, project, rows=45, columns=160):
        super().__init__(h, project)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        self.evidence = h.ROOT / f"tui-{project.name}-{rows}x{columns}-{self.process.pid}.ansi"
        self.dialog_seen = 0

    def send(self, text):
        os.write(self.master, text.encode())
        self.pump(0.25)

    def command(self, text="/sources"):
        self.send("\x1b[200~" + text + "\x1b[201~")
        self.send("\r")
        if text == "/sources":
            self.send("\r")

    def choose(self, text):
        self.send(text)
        self.send("\r")

    def dialog(self, h, title):
        until = time.monotonic() + 10
        while time.monotonic() < until:
            try:
                records = [json.loads(line) for line in (h.ROOT / "alerts.jsonl").read_text().splitlines()]
            except (FileNotFoundError, json.JSONDecodeError):
                self.pump(0.1)
                continue
            if len(records) > self.dialog_seen and records[-1]["title"] == title:
                self.dialog_seen = len(records)
                # Receipts precede mounting the native dialog input.
                self.pump(0.75)
                return records[-1]
            self.pump(0.1)
        raise AssertionError("Native dialog not observed: " + title)

    def toast(self, h, message):
        until = time.monotonic() + 10
        while time.monotonic() < until:
            try:
                records = [json.loads(line) for line in (h.ROOT / "alerts.jsonl").read_text().splitlines()]
            except (FileNotFoundError, json.JSONDecodeError):
                self.pump(0.1)
                continue
            if any(record.get("kind") == "toast" and record.get("message") == message for record in records):
                return
            self.pump(0.1)
        raise AssertionError("Native toast not observed: " + message)

    def viewer(
        self, h, predicate=lambda value: value["route"].get("name") == "sources-preview" and bool(value.get("markdown"))
    ):
        until = time.monotonic() + 15
        while time.monotonic() < until:
            path = h.ROOT / ("viewer-" + str(self.process.pid) + ".json")
            if path.exists():
                try:
                    value = json.loads(path.read_text())
                    if predicate(value):
                        return value
                except json.JSONDecodeError:
                    pass
            self.pump(0.1)
        raise AssertionError("Native Viewer state not observed")


def run(namespace):
    h = SimpleNamespace(**namespace)
    receipts = []
    info = h.start()
    h.base = namespace["base"]
    a, b = [h.session(p) for p in h.projects]
    original = h.FIXTURE.read_bytes()
    h.stop()
    # Observe native dialog inputs, then delegate to the installed real dialog.
    # No fake UI/RPC/read implementation; receipts stay in the private temp root.
    observer = h.ROOT / "observer"
    observer.mkdir()
    fault = h.ROOT / "fault-mode"
    (observer / "index.ts").write_text(
        'import { existsSync, readFileSync } from "node:fs"\n'
        + f"import actual from {json.dumps(str(h.REPO / 'index.ts'))}\n"
        + f"const path = {json.dumps(str(fault))}\n"
        + 'const mode = () => existsSync(path) ? readFileSync(path,"utf8") : ""\n'
        + "export default { ...actual, setup(context) { const storage = new Proxy(context.storage, { get(target, key) {\n"
        + 'if(key === "get") return async (name) => {\n'
        + 'if(mode() === "storage") throw Error("private storage detail")\n'
        + 'if(mode() === "corrupt" && name.endsWith("/meta/external-refresh")) return { schemaVersion: 99 }\n'
        + 'if(mode() === "body" && name.includes("/body/external-refresh/")) return undefined\n'
        + "return target.get(name) }\n"
        + 'if(key === "scan") return async (input) => { if(mode() === "storage") throw Error("private storage detail");\n'
        + 'const result = await target.scan(input); return mode() === "corrupt" ? { ...result, entries: result.entries.map(entry =>\n'
        + 'entry.key.endsWith("/meta/external-refresh") ? { ...entry, value: { schemaVersion: 99 } } : entry) } : result }\n'
        + "return target[key] } })\n"
        + 'return actual.setup(new Proxy(context, { get(target,key) { return key === "storage" ? storage : target[key] } })) } }\n'
    )
    (observer / "tui.ts").write_text(
        'import { appendFileSync } from "node:fs"\n'
        + 'import { writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs"; import { createHash } from "node:crypto"\n'
        + f"import actual from {json.dumps(str(h.TUI))}\n"
        + "export default { ...actual, setup(context) { const generation = Date.now();\n"
        + "const dialog = new Proxy(context.ui.dialog, { get(target, key) {\n"
        + 'if (!["confirm", "select", "prompt"].includes(key)) return target[key]\n'
        + "return async (input) => {\n"
        + f'appendFileSync({json.dumps(str(h.ROOT / "alerts.jsonl"))}, JSON.stringify(input) + "\\n")\n'
        + "return target[key](input) } } })\n"
        + "const toast = new Proxy(context.ui.toast, { get(target,key) { if(key !== 'show') return target[key];\n"
        + "return (input) => {\n"
        + f'appendFileSync({json.dumps(str(h.ROOT / "alerts.jsonl"))}, JSON.stringify({{ ...input, kind: "toast" }}) + "\\n")\n'
        + "return target.show(input) } } })\n"
        + 'const cleanup = actual.setup(new Proxy(context, { get(target, key) { return key === "ui" ? '
        + "{ ...target.ui, dialog, toast } : target[key] } }));\n"
        + "const timer = setInterval(() => { const markdown=[], scroll=[]; const walk = node => {\n"
        + 'if("tableOptions" in node && typeof node.content === "string") markdown.push({ bytes: Buffer.byteLength(node.content), hash: createHash("sha256").update(node.content).digest("hex") });\n'
        + 'if("scrollTop" in node && "viewport" in node) scroll.push({top:node.scrollTop,height:node.scrollHeight,viewport:node.viewport.height});\n'
        + "for(const child of node.getChildren?.() ?? []) walk(child) }; walk(context.renderer.root);\n"
        + f'const commandFile = {json.dumps(str(h.ROOT / "control-"))} + process.pid + ".json"; '
        + 'if(existsSync(commandFile)) { const command=JSON.parse(readFileSync(commandFile,"utf8")); unlinkSync(commandFile); '
        + "if(command.route) context.ui.router.navigate(command.route); }\n"
        + f'writeFileSync({json.dumps(str(h.ROOT / "viewer-"))} + process.pid + ".json", JSON.stringify({{ generation, route:context.ui.router.current(), markdown, scroll, width:context.renderer.width,height:context.renderer.height }}))\n'
        + "}, 100); return () => { clearInterval(timer); cleanup?.() } } }\n"
    )
    h.config["plugins"][0] = {"package": str(observer)}
    h.start()
    query = urlencode({"location[directory]": str(h.projects[0])})
    receipt = h.api("/api/rpc/sourcepier/importMarkdown?" + query, {"input": {"file": str(h.FIXTURE)}})["output"]
    h.check("Viewer fixture imported through real RPC", receipt["id"] == "example")
    _, seeded, _ = h.invoke(h.projects[0], "project_sources_read", {"id": "example"})
    h.check("preexisting imported fixture is byte exact", seeded["data"]["content"].encode() == original)
    h.stop()
    h.start()
    h.base = namespace["base"]

    def rpc(project, method, **input):
        query = urlencode({"location[directory]": str(project)})
        return h.api("/api/rpc/sourcepier/" + method + "?" + query, {"input": input})["output"]

    listed = rpc(h.projects[0], "listSources")
    read = rpc(h.projects[0], "readSource", id="example")
    h.check(
        "caller projectID cannot override read RPC Location",
        rpc(h.projects[0], "readSource", id="example", projectID=b["projectID"]) == read,
    )
    try:
        rpc(h.projects[0], "listSources", projectID=b["projectID"])
        raise AssertionError("unexpected list override")
    except RuntimeError as error:
        h.check("empty list schema rejects caller Project override", "rpc.invalid_input" in str(error))
    reader, agent, requests = h.invoke(h.projects[0], "project_sources_read", {"id": "example"})
    h.check(
        "RPC and independent Agent read same full content and revision",
        {k: v for k, v in read.items() if k != "instanceId"} == agent["data"] == seeded["data"],
    )
    _, agent_list, _ = h.invoke(h.projects[0], "project_sources_list", {})
    h.check("RPC and Agent list match", listed == agent_list["data"])
    system = json.dumps(requests[0]["messages"])
    h.check(
        "Agent Source catalog remains read-only and context omits body",
        set(re.findall(r"tools\.project_sources_[a-z_]+", system))
        == {"tools.project_sources_list", "tools.project_sources_read"}
        and original.decode()[:500] not in system,
    )
    tui = Browser(h, h.projects[0], 24, 80)
    try:
        tui.pump(5)
        tui.command()
        tui.wait("SourcePier (1)")
        h.check("bare sources opens list, not import prompt", True)
        tui.wait("example · markdown · r1")
        h.check("native list displays Source ID, format and revision", True)
        tui.choose("example")
        state = tui.viewer(h)
        h.check(
            "native Markdown receives entire exact example body",
            state["markdown"] == [{"bytes": len(original), "hash": hashlib.sha256(original).hexdigest()}],
        )
        tui.wait("SourcePier /")
        tui.wait("Sample Project Notes")
        h.check(
            "native Markdown renders opening heading and Chinese",
            "中文" in re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", tui.raw).decode(errors="replace"),
        )
        for key, direction, label in [
            ("\x1b[B", 1, "Down"),
            ("j", 1, "j"),
            ("\x1b[A", -1, "Up"),
            ("k", -1, "k"),
            ("\x1b[6~", 1, "PageDown"),
            ("\x1b[5~", -1, "PageUp"),
        ]:
            before = tui.viewer(h)["scroll"][0]["top"]
            tui.send(key)
            tui.viewer(h, lambda value: bool(value["scroll"]) and (value["scroll"][0]["top"] - before) * direction > 0)
            h.check("Viewer scrolling " + label, True)
        for _ in range(100):
            current = tui.viewer(h)["scroll"][0]
            if current["top"] >= current["height"] / 2:
                break
            middle_start = len(tui.raw)
            tui.send("\x1b[6~")
            tui.viewer(h, lambda value: value["scroll"] and value["scroll"][0]["top"] > current["top"])
        else:
            raise AssertionError("Viewer did not reach example middle")
        visible_middle = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", tui.raw[middle_start:]).decode(errors="replace")
        h.check(
            "PageDown reaches visible example middle paragraphs",
            sum("\u4e00" <= char <= "\u9fff" for char in visible_middle) > 10,
        )
        painted = len(tui.raw)
        tui.send("\x1b[F")
        tui.viewer(
            h,
            lambda value: (
                value["scroll"]
                and value["scroll"][0]["top"] >= value["scroll"][0]["height"] - value["scroll"][0]["viewport"] - 1
            ),
        )
        tui.wait("Markdown fixture", since=painted)
        h.check("End reaches complete example final section", True)
        tui.send("\x1b[H")
        tui.viewer(h, lambda value: value["scroll"] and value["scroll"][0]["top"] == 0)
        h.check("Home returns to document start", True)
        before = tui.viewer(h)["scroll"][0]["top"]
        tui.send("\x1b[<65;40;12M")
        tui.viewer(h, lambda value: value["scroll"] and value["scroll"][0]["top"] > before)
        h.check("Viewer responds to mouse wheel", True)
        fcntl.ioctl(tui.master, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 160, 0, 0))
        os.kill(tui.process.pid, signal.SIGWINCH)
        tui.viewer(h, lambda value: value["width"] == 160 and value["height"] == 45 and bool(value["markdown"]))
        h.check("Viewer survives terminal resize 80x24 to 160x45", True)
        fcntl.ioctl(tui.master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        os.kill(tui.process.pid, signal.SIGWINCH)
        tui.viewer(h, lambda value: value["width"] == 80 and value["height"] == 24 and bool(value["markdown"]))
        h.check("Viewer survives shrinking back to 80x24", True)
        tui.send("\x1b")
        tui.dialog(h, "SourcePier (1)")
        tui.viewer(h, lambda value: value["route"]["type"] == "home" and not value["markdown"])
        h.check("Escape from preview returns directly to Sources", True)
        tui.choose("example")
        tui.viewer(h)
        (h.ROOT / ("control-" + str(tui.process.pid) + ".json")).write_text(json.dumps({"route": {"type": "home"}}))
        tui.viewer(h, lambda value: value["route"]["type"] == "home" and not value["markdown"])
        tui.pump(0.5)
        records = [json.loads(line) for line in (h.ROOT / "alerts.jsonl").read_text().splitlines()]
        h.check(
            "external route navigation unmounts Viewer without reopening browse",
            records[-1]["title"] == "SourcePier (1)",
        )
        tui.command("/sources")
        tui.dialog(h, "SourcePier (1)")
        tui.send("\x1b")
        (h.ROOT / ("control-" + str(tui.process.pid) + ".json")).write_text(
            json.dumps({"route": {"type": "session", "sessionID": reader["id"]}})
        )
        tui.viewer(h, lambda value: value["route"].get("sessionID") == reader["id"])
        tui.command("/sources")
        tui.dialog(h, "SourcePier (1)")
        tui.choose("example")
        tui.viewer(h)
        tui.send("\x1b")
        tui.dialog(h, "SourcePier (1)")
        tui.viewer(h, lambda value: value["route"].get("sessionID") == reader["id"])
        h.check("Escape restores original Session route and context", True)
        tui.choose("Import")
        tui.dialog(h, "Import Markdown as Project Source")
        fresh = h.ROOT / "Fresh Copy.md"
        fresh.write_text(
            "# Fresh copy\n\n中文表格\n\n| 名稱 | Value |\n| --- | --- |\n| 範例 | 42 |\n\n```js\nconst answer = 42\n```\n"
        )
        fresh_content = fresh.read_text()
        tui.send("\x1b[200~" + str(fresh) + "\x1b[201~")
        tui.send("\r")
        tui.wait("Duplicate Source IDs are rejected.")
        tui.send("\r")
        tui.dialog(h, "SourcePier (2)")
        h.check(
            "Add from browse imports and refreshes list",
            rpc(h.projects[0], "readSource", id="fresh-copy")["content"] == fresh.read_text(),
        )
        outside = h.ROOT / "External Refresh.md"
        outside.write_text("# External\n")
        rpc(h.projects[0], "importMarkdown", file=str(outside))
        tui.choose("Refresh")
        tui.dialog(h, "SourcePier (3)")
        h.check("Refresh observes external import without closing Sources", True)
        tui.choose("external-refresh")
        tui.viewer(h)
        tui.send("\x1b")
        tui.dialog(h, "SourcePier (3)")
        h.check("single-page preview returns to Sources", True)
        tui.send("\x1b")
        tui.send("\x10")
        tui.choose("Browse Sources")
        tui.dialog(h, "SourcePier (3)")
        h.check("command palette opens Browse Sources", True)
    finally:
        tui.close()
    other = Browser(h, h.projects[1])
    try:
        other.pump(5)
        other.command()
        other.wait("SourcePier (0)")
        h.check(
            "Project B empty state offers Add and Refresh",
            "Import Markdown" in re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", other.raw).decode(errors="replace"),
        )
        other.choose("Import")
        other.dialog(h, "Import Markdown as Project Source")
        only_b = h.ROOT / "Only B.md"
        only_b.write_text("# Project B only\n")
        other.send("\x1b[200~" + str(only_b) + "\x1b[201~")
        other.send("\r")
        other.wait("Duplicate Source IDs are rejected.")
        other.send("\r")
        other.dialog(h, "SourcePier (1)")
        other.choose("only-b")
        other.wait("Project B only")
        other.send("\x1b")
        other.dialog(h, "SourcePier (1)")
        h.check(
            "B native preview routes to B while default server is A",
            rpc(h.projects[1], "readSource", id="only-b")["content"] == only_b.read_text(),
        )
    finally:
        other.close()
    h.check(
        "Project lists remain isolated",
        len(rpc(h.projects[0], "listSources")["sources"]) == 3
        and len(rpc(h.projects[1], "listSources")["sources"]) == 1,
    )
    for project, id in [
        (h.projects[0], "only-b"),
        (h.projects[1], "example"),
        (h.projects[0], "missing"),
        (h.projects[0], "../example"),
    ]:
        try:
            rpc(project, "readSource", id=id)
            raise AssertionError("unexpected successful read")
        except RuntimeError as error:
            payload = json.loads(str(error).split(": ", 2)[-1])
            expected = "invalid_source_id" if id.startswith("..") else "source_not_found"
            h.check("RPC rejects " + id + " in " + project.name, payload["type"] == expected)
            receipts.append({"project": project.name, "id": id, "error": payload})
    fresh.rename(h.ROOT / "renamed-original.md")
    h.stop()
    h.start()
    h.check(
        "restart preserves same RPC content, metadata and revision",
        rpc(h.projects[0], "readSource", id="example") == read,
    )
    h.base = namespace["base"]
    errors = Browser(h, h.projects[0])
    try:
        errors.pump(5)
        errors.command()
        errors.wait("SourcePier (3)")
        errors.choose("fresh-copy")
        recorded = errors.viewer(h)
        h.check(
            "native preview survives renamed original and full restart",
            recorded["markdown"]
            == [{"bytes": len(fresh_content.encode()), "hash": hashlib.sha256(fresh_content.encode()).hexdigest()}],
        )
        errors.wait("範例")
        errors.wait("const answer")
        rendered = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", errors.raw).decode(errors="replace")
        h.check(
            "native Markdown renders table grid and code block",
            bool(re.search("[┌┬┐├┼┤└┴┘│─]", rendered)) and "```js" not in rendered,
        )
        errors.send("\x1b")
        errors.dialog(h, "SourcePier (3)")
        fault.write_text("body")
        errors.choose("external-refresh")
        errors.toast(h, "This Project Source is unreadable")
        errors.dialog(h, "SourcePier (3)")
        h.check("native preview shows safe unreadable Source error", True)
        fault.write_text("corrupt")
        errors.choose("Refresh")
        errors.toast(h, "A Project Source is unreadable")
        h.check("native Refresh shows safe corrupt metadata error", True)
        fault.unlink()
        errors.command()
        errors.dialog(h, "SourcePier (3)")
        fault.write_text("storage")
        errors.choose("Refresh")
        errors.toast(h, "SourcePier list failed")
        h.check("native Refresh surfaces storage outage without empty-success list", True)
        for mode, method, input in [
            ("body", "readSource", {"id": "external-refresh"}),
            ("corrupt", "readSource", {"id": "external-refresh"}),
            ("storage", "listSources", {}),
        ]:
            fault.write_text(mode)
            try:
                rpc(h.projects[0], method, **input)
                raise AssertionError("unexpected successful faulty read")
            except RuntimeError as error:
                payload = json.loads(str(error).split(": ", 2)[-1])
                expected = "storage_unavailable" if mode == "storage" else "source_unavailable"
                h.check(
                    "fault-injected RPC returns safe " + mode + " error",
                    payload["type"] == expected and "private" not in json.dumps(payload),
                )
                receipts.append({"fault": mode, "error": payload})
    finally:
        fault.unlink(missing_ok=True)
        errors.close()
    h.check(
        "faults do not rewrite original metadata or content",
        rpc(h.projects[0], "readSource", id="external-refresh")["content"] == outside.read_text(),
    )
    for number in range(100):
        bulk = h.ROOT / ("Bulk" + str(number).zfill(3) + ".md")
        bulk.write_text("# Bulk " + str(number) + "\n")
        rpc(h.projects[0], "importMarkdown", file=str(bulk))
    bounded = rpc(h.projects[0], "listSources")
    h.check(
        "many-document RPC index bounded at 100 with truncated flag",
        len(bounded["sources"]) == 100 and bounded["truncated"],
    )
    many = Browser(h, h.projects[0])
    try:
        many.pump(5)
        many.command()
        many.wait("SourcePier (100+)")
        many.send("More Sources")
        many.wait("showing first 100")
        many.send("\x1b")
        h.check("native many-document list exposes truncated notice", True)
    finally:
        many.close()
    lifecycle = Browser(h, h.projects[0])
    try:
        lifecycle.pump(5)
        lifecycle.command()
        lifecycle.dialog(h, "SourcePier (100+)")
        lifecycle.choose("bulk000")
        previous = lifecycle.viewer(h)
        with (observer / "tui.ts").open("a") as file:
            file.write("\n// Runtime hot-reload checkpoint\n")
        lifecycle.viewer(
            h,
            lambda value: (
                value["generation"] != previous["generation"]
                and value["route"]["type"] == "home"
                and not value["markdown"]
            ),
        )
        h.check("actual local hot reload unmounts Viewer and restores prior route", True)
        lifecycle.command()
        lifecycle.dialog(h, "SourcePier (100+)")
        lifecycle.choose("bulk000")
        lifecycle.viewer(h)
        lifecycle.send("\x1b")
        lifecycle.dialog(h, "SourcePier (100+)")
        h.check("reloaded Viewer reopens and returns without stale registrations", True)
    finally:
        lifecycle.close()
    for project in h.projects:
        h.check(
            "repository remains unchanged: " + project.name,
            not subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=all"], cwd=project)
            and [p.name for p in project.iterdir()] == [".git"],
        )
    (h.ROOT / "results.json").write_text(
        json.dumps(
            {
                "version": info["version"],
                "passes": h.RESULTS,
                "project_a": a["projectID"],
                "project_b": b["projectID"],
                "session": reader["id"],
                "interface": "full-screen Markdown Viewer",
                "terminal_sizes": ["80x24", "160x45"],
                "rpc_list": listed,
                "rpc_read_metadata": {key: value for key, value in read.items() if key != "content"},
                "errors": receipts,
                "bytes": len(original),
                "sha256": hashlib.sha256(original).hexdigest(),
            },
            indent=2,
        )
    )
