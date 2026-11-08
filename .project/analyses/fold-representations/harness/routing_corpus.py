#!/usr/bin/env python3
"""Build the routing-eval corpus: 41 synthetic messages against a fixed list, plus the real user
messages of a session (list snapshot reconstructed at that point; labels below by message index).
Usage: routing_corpus.py <out.json> [session.jsonl]"""
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))

LIST = {"list": "auth", "title": "Token store",
        "goals": ["All token access goes through TokenStore.", "No plaintext secrets on disk."],
        "pins": [{"id": "p1", "kind": "constraint", "text": "Never touch vendor/."}],
        "tasks": [
            {"id": "1", "title": "Design", "status": "done"},
            {"id": "1.1", "title": "Draft interface", "status": "done"},
            {"id": "1.2", "title": "Review interface", "status": "done"},
            {"id": "2", "title": "Implement", "status": "doing"},
            {"id": "2.1", "title": "get/set", "status": "done"},
            {"id": "2.2", "title": "delete", "status": "doing", "criteria": [{"id": "c1", "text": "delete of a missing key is a no-op"}],
             "attachments": [{"id": "a1", "ref": "docs/spec.md#Interface"}]},
            {"id": "2.3", "title": "Migrate callers", "status": "todo"},
            {"id": "3", "title": "Docs", "status": "todo"}]}
LAST = "Implemented delete() in src/auth/store.ts; running the store tests next."

def G(op, kind, target="any", optional=False):
    g = {"op": op, "kind": kind, "target": target}
    if optional: g["optional"] = True
    return g

SYN = [
    ("ok", []),
    ("thanks, looks good so far", []),
    ("Also make sure delete() logs the removed key at debug level.", [G("+", ["criterion", "task"], ["2.2"])]),
    ("Never log the token value itself, only key names.", [G("+", ["pin", "criterion"], ["list", "2", "2.2"])]),
    ("Skip the docs, we'll do them later in a separate project.", [G("-", "task", ["3"])]),
    ("Actually the first goal is broader: all secret access (tokens and API keys) must go through TokenStore.", [G("~", "goal", ["list"])]),
    ("Add another goal: every secret access is audited.", [G("+", "goal", ["list"])]),
    ("Use docs/security.md section 'Key handling' as the reference for 2.3.", [G("+", "attach", ["2.3"])]),
    ("The criterion for delete is wrong: deleting a missing key must raise NotFound.", [G("~", "criterion", ["2.2"])]),
    ("Drop the requirement that deleting a missing key is a no-op.", [G("-", "criterion", ["2.2"])]),
    ("What's the status?", []),
    ("Why did you choose the keychain backend?", []),
    ("Add a task to benchmark get/set after migrating callers.", [G("+", "task", ["list", "2"])]),
    ("Rename task 2.3 to 'Migrate all callers incl. CLI'.", [G("~", "task", ["2.3"])]),
    ("Before migrating callers, add a task for a deprecation shim.", [G("+", "task", ["list", "2"])]),
    ("Don't add any new dependencies.", [G("+", ["pin", "criterion"], "any")]),
    ("Remember: CI runs on Node 20, not 22.", [G("+", "pin", "any")]),
    ("We decided to keep the old env var TOKEN_PATH working until v3.", [G("+", ["pin", "criterion"], "any")]),
    ("attach src/legacy/tokens.ts, function readToken, for the migration", [G("+", "attach", ["2.3"])]),
    ("please stop, I need to think", []),
    ("yes", []),
    ("The vendor/ restriction no longer applies, you may patch vendor/keyring.", [G("-", "pin", ["list"]), G("+", "pin", "any", optional=True)]),
    ("Also cover rotate() in the store; it needs tests for expiry.", [G("+", "task", ["2", "list"]), G("+", "criterion", "any", optional=True)]),
    ("For 2.3, done means no direct fs reads of ~/.tokens remain (grep clean).", [G("+", "criterion", ["2.3"])]),
    ("Remove task 2.3, callers will be migrated by another team.", [G("-", "task", ["2.3"])]),
    ("the docs task should also include a migration guide", [G("+", ["criterion", "task"], ["3"])]),
    ("go on", []),
    ("you broke the build, fix it first", [G("+", "task", "any", optional=True)]),
    ("Use the API described in https://example.com/keychain-api for the backend.", [G("+", ["attach", "pin"], "any")]),
    ("Make 2.2 also handle batch deletes.", [G(["+", "~"], ["criterion", "task"], ["2.2"])]),
    ("The second goal (no plaintext on disk) is out of scope now.", [G("-", "goal", ["list"])]),
    ("Change the docs task to target the wiki instead of the README.", [G("~", ["task", "criterion"], ["3"])]),
    ("I attached the wrong file earlier, remove the spec attachment from 2.2.", [G("-", "attach", ["2.2"])]),
    ("Hmm interesting. Continue with 2.2.", []),
    ("User-facing error messages must be in English and German.", [G("+", ["pin", "criterion"], "any")]),
    ("Add an acceptance criterion to 2: all existing tests still pass.", [G("+", "criterion", ["2"])]),
    ("Split 2.3 into CLI callers and server callers.", [G("+", "task", ["2.3"]), G("+", "task", ["2.3"]), G("-", "task", ["2.3"], optional=True)]),
    ("Can you explain the difference between set and put?", []),
    ("Note that keychain access is slow on macOS (~200ms), keep calls minimal.", [G("+", ["pin", "criterion"], "any")]),
    ("Forget the rotate idea.", []),
    ("Before you finish 2.2, write the changelog entry too.", [G("+", ["criterion", "task"], ["2.2"])]),
]

# real session labels by line index; target "any" because the snapshot omits unstarted tasks
REAL = {
    1132: [],
    1331: [G("+", ["pin", "criterion", "task"]), G("+", ["pin", "criterion", "task"], optional=True), G("~", ["task", "criterion"], optional=True)],
    1587: [G("+", ["task", "criterion", "pin"]), G("+", ["pin", "criterion"], optional=True)],
    1939: [G("+", ["pin", "criterion"]), G("~", "task", optional=True), G("+", "task", optional=True), G("+", "task", optional=True), G("+", "pin", optional=True)],
    2116: [G("+", ["pin", "criterion"]), G("~", "task", optional=True), G("+", "task", optional=True), G("+", "task", optional=True), G("+", "pin", optional=True)],
    2255: [], 2261: [], 2485: [],
    2436: [G("+", ["task", "criterion"])],
}

def real_items(path):
    from eval import load, tasks_of
    lines = [json.loads(l) for l in open(path)]
    out = []
    for idx, gold in REAL.items():
        e = lines[idx]; m = e["message"]
        text = m["content"] if isinstance(m["content"], str) else " ".join(p.get("text", "") for p in m["content"] if p.get("type") == "text")
        # list snapshot from the session up to this entry
        tmp = "/tmp/routing-prefix.jsonl"
        with open(tmp, "w") as f:
            for l in lines[:idx]: f.write(json.dumps(l) + "\n")
        msgs = load(tmp); T = tasks_of(msgs); os.remove(tmp)
        goal, name = None, None
        for mm in msgs:
            for c in mm.get("calls", []):
                if c["name"] == "tasks" and c["arguments"].get("action") == "create":
                    name = c["arguments"].get("list"); goal = c["arguments"].get("goal")
        last = next((mm["content"] for mm in reversed(msgs) if mm["role"] == "assistant" and mm["content"].strip()), "")
        if not goal:  # created before goals existed; the goal was set later via update
            for mm in msgs:
                for c in mm.get("calls", []):
                    if c["name"] == "tasks" and c["arguments"].get("goal"): goal = c["arguments"]["goal"]; name = name or c["arguments"].get("list")
        lst = {"list": name or "tui-full-integration", "goals": [goal] if goal else [],
               "tasks": [{"id": t["id"], "title": t["title"], "status": t["status"]} for t in sorted(T.values(), key=lambda t: [int(x) for x in t["id"].split(".")])]}
        out.append({"id": f"real{idx}", "list": lst, "last": last[-800:], "msg": text, "gold": gold,
                    "request": "Complete the implementation of the plan."})
    return out

def main():
    items = [{"id": f"syn{i:02d}", "list": LIST, "last": LAST, "msg": msg, "gold": gold} for i, (msg, gold) in enumerate(SYN)]
    if len(sys.argv) > 2: items += real_items(sys.argv[2])
    json.dump(items, open(sys.argv[1], "w"), ensure_ascii=False)
    print(f"{len(items)} items ({sum(1 for i in items if not [g for g in i['gold'] if not g.get('optional')])} no-op)")

if __name__ == "__main__": main()
