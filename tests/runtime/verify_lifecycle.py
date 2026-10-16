"""Source Delete/Export checks through the installed TUI, RPC and Project KV."""

import concurrent.futures
import hashlib
import json
import time
from types import SimpleNamespace
from urllib.parse import urlencode

from verify_viewer import Browser


def run(namespace):
    h = SimpleNamespace(**namespace)
    info = h.start()
    a, b = [h.session(p) for p in h.projects]
    h.stop()
    observer = h.ROOT / "observer"
    observer.mkdir()
    mode = h.ROOT / "fault-mode"
    waiting = h.ROOT / "delete-waiting"
    # Faults wrap native storage; inventory observes the original native KV.
    (observer / "index.ts").write_text(
        'import {existsSync,readFileSync,writeFileSync,appendFileSync,unlinkSync} from "node:fs";\n'
        + f"import actual from {json.dumps(str(h.REPO / 'index.ts'))};\n"
        + f"const file={json.dumps(str(mode))},waiting={json.dumps(str(waiting))};\n"
        + 'const mode=()=>existsSync(file)?readFileSync(file,"utf8"):"";\n'
        + "export default {...actual,async setup(ctx){const storage=new Proxy(ctx.storage,{get(target,key){\n"
        + 'if(key==="scan")return input=>target.scan({...input,limit:1});\n'
        + 'if(key!=="remove")return target[key];return async name=>{const fault=mode();\n'
        + 'if(fault==="hold"&&name.includes("/meta/")){writeFileSync(waiting,"ready");while(mode()==="hold")await new Promise(r=>setTimeout(r,25));}\n'
        + 'if(fault==="meta-before"&&name.includes("/meta/"))throw Error("private failure");\n'
        + 'if(fault==="r2-before"&&name.endsWith("/r000002"))throw Error("private failure");\n'
        + "await target.remove(name);\n"
        + f'appendFileSync({json.dumps(str(h.ROOT / "removed.jsonl"))},JSON.stringify(name)+"\\n");\n'
        + 'if(fault==="meta-ack"&&name.includes("/meta/"))throw Error("private acknowledgement");\n'
        + 'if(fault==="r1-ack"&&name.endsWith("/r000001"))throw Error("private acknowledgement");}}});\n'
        + 'const cleanup=await actual.setup(new Proxy(ctx,{get(target,key){return key==="storage"?storage:target[key]}}));\n'
        + "let busy=false;const timer=setInterval(async()=>{if(busy)return;busy=true;try{\n"
        + f'const seed={json.dumps(str(h.ROOT / "legacy-seed.json"))}; if(ctx.location.project.id==={json.dumps(a["projectID"])} && existsSync(seed)){{ const input=JSON.parse(readFileSync(seed,"utf8")); for(const entry of input) await ctx.storage.set(entry.key,entry.value); unlinkSync(seed); }}\n'
        + 'const entries=[];let after;do{const page=await ctx.storage.scan({prefix:"projects/",after,limit:100});entries.push(...page.entries);after=page.next}while(after!==undefined);\n'
        + f'writeFileSync({json.dumps(str(h.ROOT / "inventory-"))}+ctx.location.project.id+".json",JSON.stringify(entries.map(e=>e.key)));\n'
        + f'writeFileSync({json.dumps(str(h.ROOT / "snapshot-"))}+ctx.location.project.id+".json",JSON.stringify(entries));\n'
        + "}finally{busy=false}},100);return async()=>{clearInterval(timer);await cleanup?.()}}};\n"
    )
    (observer / "tui.ts").write_text(
        'import {appendFileSync,writeFileSync} from "node:fs";\n'
        + f"import actual from {json.dumps(str(h.TUI))};\n"
        + "export default {...actual,setup(ctx){\n"
        + f"const log={json.dumps(str(h.ROOT / 'alerts.jsonl'))};\n"
        + "const originals={confirm:ctx.ui.dialog.confirm,select:ctx.ui.dialog.select,prompt:ctx.ui.dialog.prompt,show:ctx.ui.toast.show};\n"
        + 'for(const k of ["confirm","select","prompt"]){ctx.ui.dialog[k]=input=>{appendFileSync(log,JSON.stringify(input)+"\\n");return originals[k](input)}}\n'
        + 'ctx.ui.toast.show=input=>{appendFileSync(log,JSON.stringify({...input,kind:"toast"})+"\\n");return originals.show(input)};\n'
        + "const cleanup=actual.setup(ctx);const timer=setInterval(()=>{const markdown=[],editor=[];const walk=n=>{\n"
        + 'if("tableOptions" in n&&typeof n.content==="string")markdown.push(n.content);\n'
        + 'if(ctx.ui.router.current().name==="sources-edit"&&"gotoBufferEnd" in n&&typeof n.plainText==="string")editor.push(n.plainText);\n'
        + "for(const c of n.getChildren?.()??[])walk(c)};walk(ctx.renderer.root);\n"
        + f'writeFileSync({json.dumps(str(h.ROOT / "viewer-"))}+process.pid+".json",JSON.stringify({{route:ctx.ui.router.current(),markdown,editor}}));\n'
        + '},100);return()=>{clearInterval(timer);cleanup?.();for(const k of ["confirm","select","prompt"])ctx.ui.dialog[k]=originals[k];ctx.ui.toast.show=originals.show}}};\n'
    )
    h.config["plugins"][0] = {"package": str(observer)}
    h.start()
    h.base = namespace["base"]
    p, q = h.projects
    errors = []

    def rpc(project, method, **input):
        if method in ("saveSource", "deleteSource") and "expectedInstance" not in input:
            try:
                input["expectedInstance"] = rpc(project, "readSource", id=input["id"])["instanceId"]
            except (RuntimeError, KeyError):
                input["expectedInstance"] = "missing-source"
        query = urlencode({"location[directory]": str(project)})
        return h.api("/api/rpc/sourcepier/" + method + "?" + query, {"input": input})["output"]

    def reject(label, code, operation):
        try:
            operation()
        except RuntimeError as error:
            payload = json.loads(str(error).split(": ", 2)[-1])
            h.check(label, payload["type"] == code and "private" not in json.dumps(payload))
            errors.append(payload)
            return
        raise AssertionError("Unexpected successful " + label)

    def inventory(project_id, id):
        prefix = "projects/" + project_id + "/"
        path = h.ROOT / ("inventory-" + project_id + ".json")
        for _ in range(100):
            try:
                keys = json.loads(path.read_text())
                return sorted(
                    k for k in keys if k == prefix + "meta/" + id or k.startswith(prefix + "body/" + id + "/")
                )
            except (FileNotFoundError, json.JSONDecodeError):
                time.sleep(0.05)
        raise AssertionError("Native KV inventory unavailable")

    def wait_empty(project_id, id):
        for _ in range(100):
            if not inventory(project_id, id):
                return
            time.sleep(0.05)
        raise AssertionError("Native KV still contains deleted Source")

    def snapshot(id):
        prefix = "projects/" + a["projectID"] + "/"
        path = h.ROOT / ("snapshot-" + a["projectID"] + ".json")
        return sorted(
            (
                entry
                for entry in json.loads(path.read_text())
                if entry["key"] == prefix + "meta/" + id or entry["key"].startswith(prefix + "body/" + id + "/")
            ),
            key=lambda entry: entry["key"],
        )

    original = "\ufeff# Draft\r\n中文 😀\r\n"
    draft_file = h.ROOT / "Draft.md"
    draft_file.write_bytes(original.encode())
    rpc(p, "importMarkdown", file=str(draft_file))
    rpc(p, "saveSource", id="draft", expectedRevision=1, content=original + "revision two\r\n")
    latest = original + "revision three 🧪\r\n"
    rpc(p, "saveSource", id="draft", expectedRevision=2, content=latest)
    canonical = h.ROOT / "Canonical.md"
    canonical.write_bytes(h.FIXTURE.read_bytes())
    rpc(p, "importMarkdown", file=str(canonical))
    for _ in range(100):
        if len(inventory(a["projectID"], "draft")) == 4:
            break
        time.sleep(0.05)
    h.check(
        "native KV contains metadata and all three immutable revisions", len(inventory(a["projectID"], "draft")) == 4
    )
    outputs = h.ROOT / "exports"
    outputs.mkdir()
    full = outputs / "full.md"
    receipt = rpc(p, "exportSource", id="canonical", path=str(full))
    h.check(
        "RPC Export preserves all canonical example UTF-8 bytes",
        full.read_bytes() == h.FIXTURE.read_bytes() and receipt["bytes"] == len(full.read_bytes()),
    )
    reject(
        "Export never overwrites existing file",
        "already_exists",
        lambda: rpc(p, "exportSource", id="canonical", path=str(full)),
    )
    link = outputs / "link.md"
    link.symlink_to(full)
    reject(
        "Export never follows an existing symlink",
        "already_exists",
        lambda: rpc(p, "exportSource", id="canonical", path=str(link)),
    )
    h.check("collision and symlink leave original output unchanged", full.read_bytes() == h.FIXTURE.read_bytes())
    for target in [str(outputs / "wrong.txt"), str(outputs / "absent" / "new.md"), "bad\x00.md"]:
        reject(
            "invalid Export destination rejected",
            "invalid_path",
            lambda: rpc(p, "exportSource", id="draft", path=target),
        )
    reject(
        "Project B cannot export A Source",
        "source_not_found",
        lambda: rpc(q, "exportSource", id="draft", path=str(outputs / "other.md")),
    )
    reject(
        "Project B cannot delete A Source",
        "source_not_found",
        lambda: rpc(q, "deleteSource", id="draft", expectedRevision=3),
    )
    reject(
        "stale Delete leaves newer canonical intact",
        "revision_conflict",
        lambda: rpc(p, "deleteSource", id="draft", expectedRevision=2),
    )
    h.check("failed Delete leaves exact current content", rpc(p, "readSource", id="draft")["content"] == latest)

    def open_source(tui, id, count):
        tui.command()
        tui.dialog(h, f"SourcePier ({count})")
        tui.pump(0.75)
        tui.send("\x1b[200~" + id + "\x1b[201~")
        tui.send("\r")
        tui.viewer(h)

    tui = Browser(h, p, 24, 80)
    editor = Browser(h, p)
    try:
        tui.pump(5)
        editor.pump(5)
        open_source(tui, "draft", 2)
        tui.send("x")
        tui.dialog(h, "Export Source Markdown")
        tui.send("\x1b")
        h.check(
            "cancel native Export creates no file or mutation", rpc(p, "readSource", id="draft")["content"] == latest
        )
        tui.send("x")
        tui.dialog(h, "Export Source Markdown")
        output = outputs / "native.md"
        tui.send("\x1b[200~" + str(output) + "\x1b[201~")
        tui.send("\r")
        for _ in range(100):
            if output.exists():
                break
            tui.pump(0.1)
        h.check("native Viewer Export writes exact BOM/CRLF current revision", output.read_bytes() == latest.encode())
        h.check(
            "Export does not change canonical metadata or revision", rpc(p, "readSource", id="draft")["revision"] == 3
        )
        rpc(q, "importMarkdown", file=str(output))
        h.check(
            "exported snapshot imports into another Project exactly at r1",
            rpc(q, "readSource", id="native")["content"] == latest
            and rpc(q, "readSource", id="native")["revision"] == 1,
        )
        open_source(editor, "draft", 2)
        editor.send("e")
        editor.viewer(h, lambda v: bool(v["editor"]))
        editor.send("\x1b[200~unsaved stale draft\x1b[201~")
        stale_draft = editor.viewer(h, lambda v: bool(v["editor"]) and "unsaved stale draft" in v["editor"][0])[
            "editor"
        ][0]
        tui.send("d")
        tui.dialog(h, "Delete Project Source?")
        tui.send("\x1b")
        h.check(
            "cancel native Delete preserves all revisions",
            rpc(p, "readSource", id="draft")["revision"] == 3 and len(inventory(a["projectID"], "draft")) == 4,
        )
        tui.send("d")
        tui.dialog(h, "Delete Project Source?")
        tui.send("\r")
        tui.dialog(h, "SourcePier (1)")
        wait_empty(a["projectID"], "draft")
        h.check(
            "confirmed native Delete removes real metadata and every historical revision",
            inventory(a["projectID"], "draft") == [],
        )
        editor.send("\x13")
        editor.toast(h, "Source not found in this Project")
        h.check(
            "open stale Editor cannot resurrect deleted Source and retains draft",
            editor.viewer(h, lambda v: v["editor"] == [stale_draft])["editor"] == [stale_draft],
        )
        _, agent, requests = h.invoke(p, "project_sources_read", {"id": "draft"})
        h.check(
            "new Agent Session cannot read deleted Source",
            agent["ok"] is False and agent["error"]["code"] == "SOURCE_NOT_FOUND",
        )
        system = json.dumps(requests[0]["messages"])
        h.check(
            "Agent catalog has no Delete or Export tool",
            "tools.project_sources_delete" not in system and "tools.project_sources_export" not in system,
        )
        h.check(
            "other Project exported copy survives A deletion", rpc(q, "readSource", id="native")["content"] == latest
        )
    finally:
        tui.close()
        editor.close()

    for name in ["Cleanup", "Ack", "Race"]:
        source = h.ROOT / (name + ".md")
        source.write_bytes(original.encode())
        rpc(p, "importMarkdown", file=str(source))
        for revision in [1, 2]:
            rpc(p, "saveSource", id=name.lower(), expectedRevision=revision, content=original + str(revision))
    mode.write_text("meta-before")
    reject(
        "metadata removal failure preserves readable Source",
        "storage_unavailable",
        lambda: rpc(p, "deleteSource", id="cleanup", expectedRevision=3),
    )
    mode.unlink()
    h.check("metadata failure retains revision 3", rpc(p, "readSource", id="cleanup")["revision"] == 3)
    mode.write_text("r2-before")
    reject(
        "paginated partial cleanup reports incomplete",
        "cleanup_incomplete",
        lambda: rpc(p, "deleteSource", id="cleanup", expectedRevision=3),
    )
    mode.unlink()
    time.sleep(0.2)
    keys = inventory(a["projectID"], "cleanup")
    h.check(
        "partial cleanup keeps real r1 and later revisions with metadata absent",
        len(keys) == 3 and all("/meta/" not in key for key in keys) and any(key.endswith("r000001") for key in keys),
    )
    reject(
        "partial cleanup prevents same-ID Import",
        "already_exists",
        lambda: rpc(p, "importMarkdown", file=str(h.ROOT / "Cleanup.md")),
    )
    rpc(p, "deleteSource", id="cleanup", expectedRevision=3)
    wait_empty(a["projectID"], "cleanup")
    h.check("retry removes every remaining immutable body", not inventory(a["projectID"], "cleanup"))
    rpc(p, "importMarkdown", file=str(h.ROOT / "Cleanup.md"))
    h.check(
        "complete cleanup permits explicit reimport at revision 1", rpc(p, "readSource", id="cleanup")["revision"] == 1
    )
    mode.write_text("meta-ack")
    reject(
        "ambiguous metadata acknowledgement is not false success",
        "storage_unavailable",
        lambda: rpc(p, "deleteSource", id="ack", expectedRevision=3),
    )
    mode.unlink()
    rpc(p, "deleteSource", id="ack", expectedRevision=3)
    wait_empty(a["projectID"], "ack")
    h.check("ambiguous metadata removal can retry to complete cleanup", not inventory(a["projectID"], "ack"))
    rpc(p, "importMarkdown", file=str(h.ROOT / "Ack.md"))
    mode.write_text("r1-ack")
    reject(
        "lost final-body acknowledgement reports incomplete",
        "cleanup_incomplete",
        lambda: rpc(p, "deleteSource", id="ack", expectedRevision=1),
    )
    mode.unlink()
    wait_empty(a["projectID"], "ack")
    reject(
        "retry after fully removed acknowledgement loss stays absent",
        "source_not_found",
        lambda: rpc(p, "deleteSource", id="ack", expectedRevision=1),
    )
    mode.write_text("hold")
    try:
        with concurrent.futures.ThreadPoolExecutor() as pool:
            pending = pool.submit(rpc, p, "deleteSource", id="race", expectedRevision=3)
            try:
                for _ in range(200):
                    if waiting.exists():
                        break
                    time.sleep(0.05)
                h.check("Delete acquires shared writer lease before mutation", waiting.exists())
                reject(
                    "concurrent Save cannot enter Delete lease",
                    "writer_busy",
                    lambda: rpc(p, "saveSource", id="race", expectedRevision=3, content="# concurrent"),
                )
                reject(
                    "concurrent Import cannot enter Delete lease",
                    "storage_unavailable",
                    lambda: rpc(p, "importMarkdown", file=str(h.ROOT / "Race.md")),
                )
            finally:
                mode.unlink(missing_ok=True)
            h.check("held Delete completes after lease release", pending.result()["deleted"] is True)
    finally:
        mode.unlink(missing_ok=True)
        waiting.unlink(missing_ok=True)
    wait_empty(a["projectID"], "race")
    # Every Import has a new instance identity. Old r1 tokens must never
    # authorize actions against a subsequent same-ID r1 Source.
    aba = h.ROOT / "ABA.md"
    aba.write_text("# First incarnation\n")
    rpc(p, "importMarkdown", file=str(aba))
    old = rpc(p, "readSource", id="aba")
    rpc(p, "deleteSource", id="aba", expectedRevision=1, expectedInstance=old["instanceId"])
    aba.write_text("# New incarnation must survive\n")
    rpc(p, "importMarkdown", file=str(aba))
    newer = rpc(p, "readSource", id="aba")
    time.sleep(0.3)
    before_aba = snapshot("aba")
    for method in ("saveSource", "deleteSource"):
        old_input = {"id": "aba", "expectedRevision": 1}
        if method == "saveSource":
            old_input["content"] = "# Old client without instance\n"
        reject(
            "RPC rejects old " + method + " input without expected instance",
            "rpc.invalid_input",
            lambda method=method, old_input=old_input: h.api(
                "/api/rpc/sourcepier/" + method + "?" + urlencode({"location[directory]": str(p)}),
                {"input": old_input},
            ),
        )
    h.check(
        "same-ID reimport creates a different instance at r1",
        newer["revision"] == 1 and old["instanceId"] != newer["instanceId"],
    )
    reject(
        "old r1 Save rejected after same-ID reimport",
        "revision_conflict",
        lambda: rpc(
            p,
            "saveSource",
            id="aba",
            expectedRevision=1,
            expectedInstance=old["instanceId"],
            content="# Stale editor overwrite\n",
        ),
    )
    h.check("stale Save leaves new import unchanged", rpc(p, "readSource", id="aba") == newer)
    reject(
        "old r1 Delete rejected after same-ID reimport",
        "revision_conflict",
        lambda: rpc(p, "deleteSource", id="aba", expectedRevision=1, expectedInstance=old["instanceId"]),
    )
    h.check(
        "stale Delete leaves new import and all its bodies intact",
        rpc(p, "readSource", id="aba") == newer and len(inventory(a["projectID"], "aba")) == 2,
    )
    time.sleep(0.3)
    h.check("rejected old incarnation requests leave raw metadata and bodies unchanged", snapshot("aba") == before_aba)

    # Test-only legacy fixture in the disposable real KV; no migration or normal DB access.
    prefix = "projects/" + a["projectID"] + "/"
    legacy_body = prefix + "body/legacy/r000001"
    created = "2020-01-02T03:04:05.000Z"
    legacy_meta = {
        "schemaVersion": 1,
        "id": "legacy",
        "projectID": a["projectID"],
        "title": "Legacy existing Source",
        "format": "markdown",
        "revision": 1,
        "bodyKey": legacy_body,
        "createdAt": created,
        "updatedAt": created,
    }
    legacy_content = "\ufeff# Existing Source\r\n中文 😀\r\n"
    seed = h.ROOT / "legacy-seed.json"
    seed.write_text(
        json.dumps(
            [
                {"key": legacy_body, "value": {"schemaVersion": 1, "content": legacy_content}},
                {"key": prefix + "meta/legacy", "value": legacy_meta},
            ]
        )
    )
    for _ in range(100):
        if not seed.exists():
            break
        time.sleep(0.05)
    time.sleep(0.2)
    raw_legacy = snapshot("legacy")
    legacy = rpc(p, "readSource", id="legacy")
    _, legacy_agent, _ = h.invoke(p, "project_sources_read", {"id": "legacy"})
    time.sleep(0.2)
    h.check(
        "legacy read derives stable identity without rewriting original metadata",
        legacy["instanceId"] == "legacy:" + created
        and snapshot("legacy") == raw_legacy
        and legacy["content"] == legacy_content
        and "instanceId" not in legacy_agent["data"],
    )
    h.check(
        "legacy metadata still has no added instanceId",
        next(e["value"] for e in raw_legacy if "/meta/" in e["key"]) == legacy_meta,
    )

    fresh = Browser(h, p)
    try:
        fresh.pump(5)
        count = len(rpc(p, "listSources")["sources"])
        open_source(fresh, "legacy", count)
        fresh.send("e")
        fresh.viewer(h, lambda v: bool(v["editor"]))
        fresh.send("\x1b[200~Native legacy edit 🧪\x1b[201~")
        fresh.send("\x13")
        fresh.dialog(h, f"SourcePier ({count})")
        saved_legacy = rpc(p, "readSource", id="legacy")
        time.sleep(0.2)
        saved_legacy_meta = next(e["value"] for e in snapshot("legacy") if "/meta/" in e["key"])
        h.check(
            "fresh native Editor saves legacy Source with unchanged incarnation",
            saved_legacy["revision"] == 2
            and saved_legacy["instanceId"] == legacy["instanceId"]
            and "instanceId" not in saved_legacy_meta
            and saved_legacy_meta["createdAt"] == created
            and "Native legacy edit 🧪" in saved_legacy["content"]
            and saved_legacy["content"].startswith("\ufeff"),
        )
        fresh.send("\x1b")
        open_source(fresh, "legacy", count)
        fresh.send("d")
        fresh.dialog(h, "Delete Project Source?")
        fresh.send("\r")
        fresh.dialog(h, f"SourcePier ({count - 1})")
        wait_empty(a["projectID"], "legacy")
        h.check("native Delete purges legacy metadata and every revision", inventory(a["projectID"], "legacy") == [])
        fresh.send("\x1b")
        open_source(fresh, "aba", count - 1)
        fresh.send("e")
        fresh.viewer(h, lambda v: bool(v["editor"]))
        fresh.send("\x1b[200~Fresh incarnation edit\x1b[201~")
        fresh.send("\x13")
        fresh.dialog(h, f"SourcePier ({count - 1})")
        saved_new = rpc(p, "readSource", id="aba")
        h.check(
            "fresh native Save uses new incarnation after reimport",
            saved_new["revision"] == 2 and saved_new["instanceId"] == newer["instanceId"],
        )
        fresh.send("\x1b")
        open_source(fresh, "aba", count - 1)
        fresh.send("d")
        fresh.dialog(h, "Delete Project Source?")
        fresh.send("\r")
        fresh.dialog(h, f"SourcePier ({count - 2})")
        wait_empty(a["projectID"], "aba")
        h.check(
            "fresh native Delete uses new incarnation and purges its revisions", inventory(a["projectID"], "aba") == []
        )
    finally:
        fresh.close()
    blockers = []
    h.stop()
    h.start()
    reject(
        "deleted Source stays absent after full restart", "source_not_found", lambda: rpc(p, "readSource", id="draft")
    )
    _, agent, _ = h.invoke(p, "project_sources_list", {})
    h.check(
        "new Session list remains free of deleted IDs after restart",
        all(item["id"] not in {"draft", "race", "ack"} for item in agent["data"]["sources"]),
    )
    for index, project in enumerate(h.projects):
        h.check(
            "repository unchanged: " + project.name,
            h.before[index] == h.status(project) and set(item.name for item in project.iterdir()) == {".git"},
        )
    h.check(
        "selected original files remain byte-identical",
        draft_file.read_bytes() == original.encode() and canonical.read_bytes() == h.FIXTURE.read_bytes(),
    )
    (h.ROOT / "results.json").write_text(
        json.dumps(
            {
                "version": info["version"],
                "passes": h.RESULTS,
                "project_a": a["projectID"],
                "project_b": b["projectID"],
                "errors": errors,
                "bytes": len(full.read_bytes()),
                "sha256": hashlib.sha256(full.read_bytes()).hexdigest(),
                "blocking": blockers,
            },
            indent=2,
        )
    )
    if blockers:
        raise SystemExit("S5 acceptance BLOCKED: same-ID revision reset revives stale writers; see results.json")
