"""Native Editor/RPC checks built on the existing isolated runtime harness."""

import concurrent.futures
import fcntl
import hashlib
import json
import os
import signal
import socket
import struct
import subprocess
import termios
import time
import urllib.error
import urllib.request
from types import SimpleNamespace
from urllib.parse import urlencode

from verify_viewer import Browser


def run(namespace):
    h = SimpleNamespace(**namespace)
    receipts = []
    info = h.start()
    a, b = [h.session(p) for p in h.projects]
    h.stop()
    observer = h.ROOT / "observer"
    observer.mkdir()
    mode = h.ROOT / "fault-mode"
    waiting = h.ROOT / "writer-waiting"
    (observer / "index.ts").write_text(
        'import { existsSync, readFileSync, writeFileSync } from "node:fs"\n'
        + f"import actual from {json.dumps(str(h.REPO / 'index.ts'))}\n"
        + f"const file={json.dumps(str(mode))}, waiting={json.dumps(str(waiting))};\n"
        + 'const mode=()=>existsSync(file)?readFileSync(file,"utf8"):"";\n'
        + "export default {...actual, setup(ctx) { const storage=new Proxy(ctx.storage,{get(target,key){\n"
        + 'if(key!=="set") return target[key]; return async(name,value)=>{ const fault=mode();\n'
        + 'if(fault==="hold" && name.includes("/body/")){writeFileSync(waiting,"ready"); while(mode()==="hold") await new Promise(r=>setTimeout(r,25));}\n'
        + 'if(fault==="body" && name.includes("/body/")) throw Error("private body failure");\n'
        + 'if(fault==="meta" && name.includes("/meta/")) throw Error("private metadata failure");\n'
        + "await target.set(name,value);\n"
        + 'if(fault==="meta-ack" && name.includes("/meta/")) throw Error("private acknowledgement failure");\n'
        + 'if(fault==="body-ack" && name.includes("/body/")) throw Error("private acknowledgement failure");\n'
        + '}}}); return actual.setup(new Proxy(ctx,{get(target,key){return key==="storage"?storage:target[key]}}));}}\n'
    )
    tui_path = observer / "tui.ts"
    tui_path.write_text(
        'import {appendFileSync,writeFileSync,existsSync,readFileSync,unlinkSync} from "node:fs";\n'
        + f"import actual from {json.dumps(str(h.TUI))};\n"
        + "export default {...actual,setup(ctx){const generation=Date.now();\n"
        + f"const log={json.dumps(str(h.ROOT / 'alerts.jsonl'))};\n"
        + "const originals={confirm:ctx.ui.dialog.confirm,select:ctx.ui.dialog.select,prompt:ctx.ui.dialog.prompt,show:ctx.ui.toast.show};\n"
        + 'for(const k of ["confirm","select","prompt"]){const method=originals[k];ctx.ui.dialog[k]=input=>{appendFileSync(log,JSON.stringify(input)+"\\n");return method(input)}}\n'
        + 'ctx.ui.toast.show=input=>{appendFileSync(log,JSON.stringify({...input,kind:"toast"})+"\\n");return originals.show(input)};\n'
        + "const cleanup=actual.setup(ctx);\n"
        + "const timer=setInterval(()=>{const editor=[],markdown=[];const walk=n=>{\n"
        + 'if(ctx.ui.router.current().name==="sources-edit" && "gotoBufferEnd" in n && typeof n.plainText==="string")editor.push(n.plainText);\n'
        + 'if("tableOptions" in n && typeof n.content==="string")markdown.push(n.content);\n'
        + "for(const c of n.getChildren?.()??[])walk(c)};walk(ctx.renderer.root);\n"
        + f'const command={json.dumps(str(h.ROOT / "control-"))}+process.pid+".json";\n'
        + 'if(existsSync(command)){const c=JSON.parse(readFileSync(command,"utf8"));unlinkSync(command);if(c.route)ctx.ui.router.navigate(c.route);}\n'
        + f'writeFileSync({json.dumps(str(h.ROOT / "viewer-"))}+process.pid+".json",JSON.stringify({{generation,route:ctx.ui.router.current(),editor,markdown,width:ctx.renderer.width,height:ctx.renderer.height}}));\n'
        + '},100);return()=>{clearInterval(timer);cleanup?.();for(const k of ["confirm","select","prompt"])ctx.ui.dialog[k]=originals[k];ctx.ui.toast.show=originals.show}}}\n'
    )
    h.config["plugins"][0] = {"package": str(observer), "options": {}}
    h.start()
    h.base = namespace["base"]

    def rpc(project, method, base=None, **input):
        if method in ("saveSource", "deleteSource") and "expectedInstance" not in input:
            try:
                input["expectedInstance"] = rpc(project, "readSource", base=base, id=input["id"])["instanceId"]
            except (RuntimeError, KeyError):
                input["expectedInstance"] = "missing-source"
        query = urlencode({"location[directory]": str(project)})
        path = "/api/rpc/sourcepier/" + method + "?" + query
        if base is None:
            return h.api(path, {"input": input})["output"]
        request = urllib.request.Request(
            base + path,
            data=json.dumps({"input": input}).encode(),
            headers={"Authorization": h.auth, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)["output"]
        except urllib.error.HTTPError as error:
            raise RuntimeError("RPC: " + str(error.code) + ": " + error.read().decode()) from None

    def reject(label, code, operation):
        try:
            operation()
        except RuntimeError as error:
            payload = json.loads(str(error).split(": ", 2)[-1])
            h.check(label, payload["type"] == code and "private" not in json.dumps(payload))
            receipts.append(payload)
            return
        raise AssertionError("Unexpected successful " + label)

    p = h.projects[0]
    original = "\ufeff# Draft\r\n中文 😀\r\n"
    for name in ("Draft", "Race", "Fault", "Ack", "Hold"):
        file = h.ROOT / (name + ".md")
        file.write_bytes(original.encode())
        rpc(p, "importMarkdown", file=str(file))
    request = urllib.request.Request(
        h.base + "/api/rpc/sourcepier/saveSource?" + urlencode({"location[directory]": str(p)}),
        data=json.dumps({"input": {"id": "draft", "expectedRevision": 1, "content": "# unauthenticated"}}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(request, timeout=10).close()
        raise AssertionError("Unauthenticated Save accepted")
    except urllib.error.HTTPError as error:
        h.check("server transport rejects unauthenticated Save", error.code == 401)
    noop = rpc(p, "saveSource", id="draft", expectedRevision=1, content=original)
    h.check(
        "RPC no-op preserves BOM/CRLF and revision",
        noop["changed"] is False and noop["revision"] == 1 and rpc(p, "readSource", id="draft")["content"] == original,
    )
    result = rpc(p, "saveSource", id="draft", expectedRevision=1, content=original + "外部\r\n")
    h.check("authenticated RPC client uses the same OpenCode Save access as TUI", result["revision"] == 2)
    reject(
        "stale RPC cannot overwrite",
        "revision_conflict",
        lambda: rpc(p, "saveSource", id="draft", expectedRevision=1, content="# stale"),
    )
    reject(
        "Project B cannot save Project A Source",
        "source_not_found",
        lambda: rpc(h.projects[1], "saveSource", id="draft", expectedRevision=2, content="# other"),
    )
    reject(
        "malformed Unicode rejected",
        "invalid_content",
        lambda: rpc(p, "saveSource", id="draft", expectedRevision=2, content="\ud800"),
    )
    reject(
        "oversized UTF-8 content rejected",
        "invalid_content",
        lambda: rpc(p, "saveSource", id="draft", expectedRevision=2, content="中" * 90000),
    )

    def editor(tui, id="draft", count=5, expect_draft=False):
        tui.command()
        listed = tui.dialog(h, f"SourcePier ({count})")
        if expect_draft:
            h.check(
                "native list labels the recoverable draft",
                any(option.get("value") == id and "Unsaved draft" in option["title"] for option in listed["options"]),
            )
        # Receipt precedes the native dialog's input mount; wait for its frame.
        tui.pump(0.75)
        tui.send("\x1b[200~" + id + "\x1b[201~")
        tui.pump(0.25)
        tui.send("\r")
        tui.viewer(h)
        tui.send("e")
        return tui.viewer(h, lambda v: v["route"].get("name") == "sources-edit" and bool(v["editor"]))

    def paste(tui, text):
        tui.send("\x1b[200~" + text + "\x1b[201~")

    first = Browser(h, p, 24, 80)
    second = Browser(h, p)
    try:
        first.pump(5)
        second.pump(3)
        state = editor(first, "ack")
        undo_baseline = state["editor"]
        paste(first, "x")
        mode.write_text("hold")
        first.send("\x13")
        until = time.monotonic() + 10
        while not waiting.exists() and time.monotonic() < until:
            first.pump(0.1)
        assert waiting.exists(), "Undo test Save never entered body write"
        first.send("\x7f")
        first.viewer(h, lambda v: v["editor"] == undo_baseline)
        mode.unlink()
        first.toast(h, "Saved r2; later edits remain in this draft. Reopen to resolve revisions.")
        generation = first.viewer(h, lambda v: bool(v["editor"]))["generation"]
        tui_path.write_text(tui_path.read_text() + "\n// undo-during-save hot reload\n")
        first.viewer(h, lambda v: v["generation"] != generation and v["route"]["type"] == "home")
        state = editor(first, "ack")
        h.check("undo during pending Save survives hot reload exactly", state["editor"] == undo_baseline)
        start = len((h.ROOT / "alerts.jsonl").read_text().splitlines())
        first.send("\x13")
        until = time.monotonic() + 10
        while time.monotonic() < until:
            records = [json.loads(line) for line in (h.ROOT / "alerts.jsonl").read_text().splitlines()[start:]]
            if any(record.get("title") == "SourcePier: not saved" for record in records):
                break
            first.pump(0.1)
        else:
            raise AssertionError("Recovered undo must conflict, not silently close as a no-op")
        h.check(
            "recovered undo retains stale-revision conflict and draft",
            first.viewer(h, lambda v: bool(v["editor"]))["editor"] == undo_baseline,
        )
        (h.ROOT / ("control-" + str(first.process.pid) + ".json")).write_text(json.dumps({"route": {"type": "home"}}))
        first.viewer(h, lambda v: v["route"]["type"] == "home" and not v["editor"])
        h.check(
            "conflicted undo remains recoverable after another navigation",
            editor(first, "ack")["editor"] == undo_baseline,
        )
        first.send("\x1b")
        first.dialog(h, "Discard changes?")
        first.send("\x1b")
        h.check(
            "Escape does not silently discard a baseline-valued recovered undo",
            first.viewer(h, lambda v: bool(v["editor"]))["editor"] == undo_baseline,
        )
        first.send("\x1b")
        first.dialog(h, "Discard changes?")
        first.send("\r")
        first.dialog(h, "SourcePier (5)")
        first.send("\x1b")
        waiting.unlink(missing_ok=True)
        state = editor(first)
        h.check(
            "native Editor loads normalized full draft",
            state["editor"] == [original.replace("\ufeff", "").replace("\r\n", "\n") + "外部\n"],
        )
        first.send("\x13")
        first.dialog(h, "SourcePier (5)")
        h.check("untouched Editor Save is byte-preserving no-op", rpc(p, "readSource", id="draft")["revision"] == 2)
        first.send("\x1b")
        editor(first)
        editor(second)
        paste(first, "甲 🧪\n")
        before = first.viewer(h, lambda v: bool(v["editor"]) and "甲" in v["editor"][0])["editor"]
        fcntl.ioctl(first.master, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 160, 0, 0))
        os.kill(first.process.pid, signal.SIGWINCH)
        first.viewer(h, lambda v: v["width"] == 160 and v["editor"] == before)
        h.check("Editor resize retains exact local draft", True)
        first.send("\x13")
        first.dialog(h, "SourcePier (5)")
        saved = rpc(p, "readSource", id="draft")
        h.check(
            "native Save publishes revision with BOM and homogeneous CRLF",
            saved["revision"] == 3
            and saved["content"].startswith("\ufeff")
            and "甲" in saved["content"]
            and "\n" not in saved["content"].replace("\r\n", ""),
        )
        paste(second, "乙 stale\n")
        second.send("\x13")
        second.viewer(h, lambda v: v["route"].get("name") == "sources-edit" and "乙 stale" in "".join(v["editor"]))
        second.wait("Conflict: latest Source changed")
        h.check("two native Editors conflict and retain stale draft", rpc(p, "readSource", id="draft") == saved)
        second.send("\x1b")
        second.dialog(h, "Discard changes?")
        second.send("\x1b")
        second.viewer(h, lambda v: bool(v["editor"]) and "乙 stale" in v["editor"][0])
        h.check("Escape Keep editing retains conflict draft", True)
        second.send("\x1b")
        second.dialog(h, "Discard changes?")
        second.send("\r")
        second.dialog(h, "SourcePier (5)")
        h.check("confirmed Discard leaves canonical revision unchanged", rpc(p, "readSource", id="draft") == saved)
        second.send("\x1b")
        first.send("\x1b")
        editor(first)
        paste(first, "unsaved external navigation\n")
        recovered = first.viewer(h, lambda v: bool(v["editor"]) and "unsaved external navigation" in v["editor"][0])[
            "editor"
        ]
        (h.ROOT / ("control-" + str(first.process.pid) + ".json")).write_text(json.dumps({"route": {"type": "home"}}))
        first.viewer(h, lambda v: v["route"]["type"] == "home" and not v["editor"])
        h.check("external dirty unmount leaves canonical Source unchanged", rpc(p, "readSource", id="draft") == saved)
        state = editor(first, expect_draft=True)
        h.check(
            "external navigation restores unsaved draft on reopening the same Source",
            state["editor"] == recovered,
        )
        generation = state["generation"]
        paste(first, "unsaved hot reload\n")
        recovered = first.viewer(h, lambda v: bool(v["editor"]) and "unsaved hot reload" in v["editor"][0])["editor"]
        with tui_path.open("a") as file:
            file.write("\n// actual local plugin hot reload\n")
        first.viewer(h, lambda v: v["generation"] != generation and v["route"]["type"] == "home" and not v["editor"])
        h.check(
            "actual hot reload cleans Editor route and keymaps without saving draft",
            rpc(p, "readSource", id="draft") == saved,
        )
        state = editor(first)
        h.check(
            "plugin hot reload restores exact unsaved draft",
            state["editor"] == recovered,
        )
        rpc(p, "saveSource", id="draft", expectedRevision=3, content=saved["content"] + "newer canonical\r\n")
        first.send("\x13")
        first.wait("Conflict: latest Source changed")
        first.viewer(h, lambda v: v["editor"] == recovered)
        h.check(
            "recovered draft retains original expected revision after canonical advances",
            rpc(p, "readSource", id="draft")["revision"] == 4,
        )
        first.send("\x1b")
        first.dialog(h, "Discard changes?")
        first.send("\r")
        first.dialog(h, "SourcePier (5)")
        first.send("\x1b")
        state = editor(first)
        h.check(
            "Discard clears recovered draft and opens latest canonical",
            state["editor"] == [rpc(p, "readSource", id="draft")["content"].lstrip("\ufeff").replace("\r\n", "\n")],
        )
        first.send("\x1b")
        first.dialog(h, "SourcePier (5)")
        first.send("\x1b")
        editor(first, "hold")
        paste(first, "native storage failure\n")
        retained = first.viewer(h, lambda v: bool(v["editor"]) and "native storage failure" in v["editor"][0])["editor"]
        mode.write_text("body")
        try:
            first.send("\x13")
            first.toast(h, "SourcePier storage is unavailable")
            first.viewer(h, lambda v: v["editor"] == retained)
            h.check(
                "native storage failure retains exact draft and old revision",
                rpc(p, "readSource", id="hold")["revision"] == 1,
            )
        finally:
            mode.unlink(missing_ok=True)
        first.send("\x13")
        first.dialog(h, "SourcePier (5)")
        h.check(
            "native failed Save retries successfully without losing draft",
            "native storage failure" in rpc(p, "readSource", id="hold")["content"],
        )
        first.send("\x1b")
        editor(first, "hold")
        paste(first, "in-flight navigation\n")
        dialogs_before_exit = (h.ROOT / "alerts.jsonl").read_text().splitlines()
        mode.write_text("hold")
        try:
            first.send("\x13")
            for _ in range(100):
                if waiting.exists():
                    break
                first.pump(0.05)
            else:
                raise AssertionError("Native Save did not enter storage")
            (h.ROOT / ("control-" + str(first.process.pid) + ".json")).write_text(
                json.dumps({"route": {"type": "home"}})
            )
            first.viewer(h, lambda v: v["route"]["type"] == "home" and not v["editor"])
        finally:
            mode.unlink(missing_ok=True)
        for _ in range(100):
            if rpc(p, "readSource", id="hold")["revision"] == 3:
                break
            first.pump(0.05)
        else:
            raise AssertionError("Unmounted Save did not publish")
        first.pump(0.5)
        first.viewer(h, lambda v: v["route"]["type"] == "home" and not v["editor"])
        h.check(
            "in-flight Save completes without reopening unmounted Editor",
            "in-flight navigation" in rpc(p, "readSource", id="hold")["content"]
            and not any(
                json.loads(line).get("title") in ("SourcePier (5)", "SourcePier: not saved")
                for line in (h.ROOT / "alerts.jsonl").read_text().splitlines()[len(dialogs_before_exit) :]
            ),
        )
        waiting.unlink(missing_ok=True)
        state = editor(first, "hold")
        h.check(
            "completed unmounted Save clears only its matching draft",
            state["editor"] == [rpc(p, "readSource", id="hold")["content"].lstrip("\ufeff").replace("\r\n", "\n")],
        )
        paste(first, "submitted before wait\n")
        mode.write_text("hold")
        try:
            first.send("\x13")
            for _ in range(100):
                if waiting.exists():
                    break
                first.pump(0.05)
            else:
                raise AssertionError("Save did not enter held write")
            paste(first, "later edits must survive\n")
            later = first.viewer(h, lambda v: bool(v["editor"]) and "later edits must survive" in v["editor"][0])[
                "editor"
            ]
        finally:
            mode.unlink(missing_ok=True)
        first.toast(h, "Saved r4; later edits remain in this draft. Reopen to resolve revisions.")
        first.viewer(h, lambda v: v["editor"] == later)
        h.check(
            "typing during Save retains exact unpublished text",
            "later edits must survive" not in rpc(p, "readSource", id="hold")["content"],
        )
        generation = first.viewer(h, lambda v: bool(v["editor"]))["generation"]
        with tui_path.open("a") as file:
            file.write("\n// reload later edits after Save\n")
        first.viewer(h, lambda v: v["generation"] != generation and v["route"]["type"] == "home")
        state = editor(first, "hold")
        h.check("hot reload retains later edits with their original revision", state["editor"] == later)
        first.send("\x13")
        first.wait("Conflict: latest Source changed")
        first.viewer(h, lambda v: v["editor"] == later)
        h.check(
            "later-edit recovery cannot silently overwrite saved revision",
            rpc(p, "readSource", id="hold")["revision"] == 4,
        )
        first.send("\x1b")
        first.dialog(h, "Discard changes?")
        first.send("\r")
        first.dialog(h, "SourcePier (5)")
        first.send("\x1b")
        state = editor(first, "fault")
        h.check(
            "other Source never inherits recovered draft",
            state["editor"] == [original.lstrip("\ufeff").replace("\r\n", "\n")],
        )
        paste(first, "memory only until TUI exit\n")
        first.viewer(h, lambda v: bool(v["editor"]) and "memory only" in v["editor"][0])
    finally:
        first.close()
        second.close()

    fresh = Browser(h, p)
    other = None
    try:
        fresh.pump(5)
        state = editor(fresh, "fault")
        h.check(
            "full TUI exit intentionally discards memory-only drafts",
            state["editor"] == [original.lstrip("\ufeff").replace("\r\n", "\n")],
        )
        paste(fresh, "recover then Save\n")
        draft = fresh.viewer(h, lambda v: bool(v["editor"]) and "recover then Save" in v["editor"][0])["editor"]
        (h.ROOT / ("control-" + str(fresh.process.pid) + ".json")).write_text(json.dumps({"route": {"type": "home"}}))
        fresh.viewer(h, lambda v: v["route"]["type"] == "home")
        h.check("repeated external navigation recovers exact draft", editor(fresh, "fault")["editor"] == draft)
        fresh.send("\x13")
        fresh.dialog(h, "SourcePier (5)")
        fresh.send("\x1b")
        state = editor(fresh, "fault")
        h.check(
            "Save clears recovered draft and reopens published revision",
            state["editor"] == [rpc(p, "readSource", id="fault")["content"].lstrip("\ufeff").replace("\r\n", "\n")]
            and rpc(p, "readSource", id="fault")["revision"] == 2,
        )
        rpc(h.projects[1], "importMarkdown", file=str(h.ROOT / "Fault.md"))
        other = Browser(h, h.projects[1])
        other.pump(5)
        state = editor(other, "fault", 1)
        h.check(
            "same Source ID in another Project has independent canonical draft",
            state["editor"] == [original.lstrip("\ufeff").replace("\r\n", "\n")],
        )
    finally:
        fresh.close()
        if other:
            other.close()

    for fault in ("body", "body-ack", "meta", "meta-ack"):
        id = "ack" if fault == "meta-ack" else "fault"
        current = rpc(p, "readSource", id=id)
        content = current["content"] + fault + "\r\n"
        mode.write_text(fault)
        try:
            if fault == "meta-ack":
                result = rpc(p, "saveSource", id=id, expectedRevision=current["revision"], content=content)
                h.check(
                    "metadata commit with lost acknowledgement verified by readback",
                    result["revision"] == current["revision"] + 1,
                )
            else:
                reject(
                    "safe " + fault + " write failure",
                    "storage_unavailable",
                    lambda: rpc(p, "saveSource", id=id, expectedRevision=current["revision"], content=content),
                )
                h.check(
                    "failed publication retains old readable revision: " + fault, rpc(p, "readSource", id=id) == current
                )
        finally:
            mode.unlink(missing_ok=True)
        if fault in ("body-ack", "meta"):
            reject(
                "immutable orphan blocks changed retry: " + fault,
                "publication_blocked",
                lambda: rpc(
                    p, "saveSource", id=id, expectedRevision=current["revision"], content=content + "different"
                ),
            )
        if fault != "meta-ack":
            result = rpc(p, "saveSource", id=id, expectedRevision=current["revision"], content=content)
            h.check(
                "identical retry recovers " + fault,
                result["revision"] == current["revision"] + 1 and rpc(p, "readSource", id=id)["content"] == content,
            )

    # A second actual server shares the exact database, environment and lock root.
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    peer_base = f"http://127.0.0.1:{port}"
    with (h.ROOT / "peer.log").open("ab") as log:
        peer = subprocess.Popen(
            [h.RUNTIME, "serve", "--hostname", "127.0.0.1", "--port", str(port)],
            cwd=p,
            env=h.env,
            stdout=log,
            stderr=log,
        )
    try:
        for _ in range(100):
            try:
                rpc(p, "readSource", base=peer_base, id="race")
                break
            except (OSError, RuntimeError):
                time.sleep(0.1)
        else:
            raise AssertionError("Peer server not ready")
        mode.write_text("hold")
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(rpc, p, "saveSource", id="race", expectedRevision=1, content="# winner")
            try:
                for _ in range(200):
                    if waiting.exists():
                        break
                    time.sleep(0.025)
                else:
                    raise AssertionError("First writer did not enter storage")
                reject(
                    "independent server cannot enter held writer lease",
                    "writer_busy",
                    lambda: rpc(p, "saveSource", base=peer_base, id="race", expectedRevision=1, content="# loser"),
                )
            finally:
                mode.unlink(missing_ok=True)
            h.check("first independent writer publishes exactly revision 2", future.result()["revision"] == 2)
        reject(
            "peer stale revision rejected after lease release",
            "revision_conflict",
            lambda: rpc(p, "saveSource", base=peer_base, id="race", expectedRevision=1, content="# loser"),
        )
        h.check(
            "peer sees same committed winner content",
            rpc(p, "readSource", base=peer_base, id="race")["content"] == "# winner",
        )
    finally:
        mode.unlink(missing_ok=True)
        peer.terminate()
        peer.wait(timeout=20)
    lock = subprocess.check_output(
        [
            "npm",
            "exec",
            "--yes",
            "--package=bun",
            "--",
            "bun",
            "-e",
            'import {writerLockPath} from "./src/writer.ts"; console.log(writerLockPath())',
        ],
        cwd=h.REPO,
        env=h.env,
        text=True,
    ).strip()
    from pathlib import Path

    stale = Path(lock)
    stale.mkdir()
    try:
        reject(
            "retained stale lease fails closed",
            "writer_busy",
            lambda: rpc(p, "saveSource", id="hold", expectedRevision=1, content="# no"),
        )
    finally:
        stale.rmdir()  # Only this test-created lease, never a user's lock.
    before_restart = rpc(p, "readSource", id="draft")
    _, agent, requests = h.invoke(p, "project_sources_read", {"id": "draft"})
    h.check(
        "new Agent Session reads latest saved content and revision",
        agent["data"] == {k: v for k, v in before_restart.items() if k != "instanceId"},
    )
    h.check("Agent catalog has no Save tool", "tools.project_sources_save" not in json.dumps(requests[0]["messages"]))
    h.stop()
    h.start()
    h.check("saved revision survives full restart", rpc(p, "readSource", id="draft") == before_restart)
    for index, project in enumerate(h.projects):
        h.check(
            "repository unchanged: " + project.name,
            h.status(project) == h.before[index] and all(f.name == ".git" for f in project.iterdir()),
        )
    h.check(
        "selected original files remain byte-identical",
        all(
            (h.ROOT / (name + ".md")).read_bytes() == original.encode()
            for name in ("Draft", "Race", "Fault", "Ack", "Hold")
        ),
    )
    (h.ROOT / "results.json").write_text(
        json.dumps(
            {
                "version": info["version"],
                "passes": h.RESULTS,
                "blocking": [],
                "errors": receipts,
                "project_a": a["projectID"],
                "project_b": b["projectID"],
                "saved": {k: v for k, v in before_restart.items() if k != "content"},
                "saved_bytes": len(before_restart["content"].encode()),
                "saved_sha256": hashlib.sha256(before_restart["content"].encode()).hexdigest(),
            },
            indent=2,
        )
    )
    print("Completed S4 runtime checks:", len(h.RESULTS), flush=True)
