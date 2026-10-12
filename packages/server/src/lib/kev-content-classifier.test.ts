import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKevContentClassifier, resolveKevWorkerScript } from "./kev-content-classifier.js";
type R = {
    id: number;
    ok: true;
    answer: unknown;
    model: string;
    device: "cpu";
} | {
    id: number;
    ok: false;
    errorCode: string;
};
test("worker path resolves from source and the bundled server layout", () => {
    const expected = new URL("../../scripts/kev-content-flags.py", import.meta.url).pathname;
    assert.equal(resolveKevWorkerScript(import.meta.url), expected);
    const compiledUrl = new URL("../../dist/index.js", import.meta.url).href;
    assert.equal(resolveKevWorkerScript(compiledUrl), expected);
});
const body = (n: number) => ({ answers: { content: { choice: n >= .5 ? "NSFW" : "SFW", probabilities: { NSFW: n, SFW: 1 - n } } } });
test("complete audit uses inclusive boundary and choices", async () => { const t = { request: async (p: unknown): Promise<R> => { assert.match(JSON.stringify(p), /Offered choices/); return { id: 1, ok: true, answer: body(.4), model: "test", device: "cpu" }; }, close() { } }; const r = await createKevContentClassifier(t).classify("user", "hello", ["choice"]); assert.equal(r.status, "complete"); assert.equal(r.label, "nsfw"); assert.equal(r.routingSafe, false); });
test("worker failure is an error and fail closed", async () => { const t = { request: async (): Promise<R> => ({ id: 1, ok: false, errorCode: "classifier_inference_failed" }), close() { } }; const r = await createKevContentClassifier(t).classify("assistant", "x"); assert.equal(r.status, "error"); assert.equal(r.label, "nsfw"); assert.equal(r.routingSafe, false); });
test("one complete multi-paragraph response and its choices reach the worker intact", async () => {
    const content = await readFile(new URL("./fixtures/alchemy-response.txt", import.meta.url), "utf8");
    const payloads: any[] = [];
    const classifier = createKevContentClassifier({ request: async (payload): Promise<R> => {
        payloads.push(payload);
        return { id: 1, ok: true, answer: body(.1), model: "test", device: "cpu" };
    }, close() {} });
    const flag = await classifier.classify("assistant", content, ["Hold the vial steady", "Ask Ryu about the wards"]);
    assert.equal(flag.status, "complete");
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].state, content + "\n\nOffered choices:\n1. Hold the vial steady\n2. Ask Ryu about the wards");
});
test("serialized checks preserve an entire long response including newlines in one decision", async () => {
    let active = 0, peak = 0;
    const content = "A complete line of a harmless story.\n".repeat(180);
    const payloads: any[] = [];
    const classifier = createKevContentClassifier({ request: async (payload): Promise<R> => {
        payloads.push(payload); active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 2)); active--;
        return { id: 1, ok: true, answer: body(.1), model: "test", device: "cpu" };
    }, close() {} });
    const flags = await Promise.all([classifier.classify("assistant", content), classifier.classify("user", "Hello")]);
    assert.equal(peak, 1);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].state, content);
    assert.ok(content.length > 5000);
    assert.ok(flags.every(flag => flag.status === "complete" && flag.label === "sfw"));
});
test("context overflow stays an explicit error instead of a completed NSFW finding", async () => {
    const classifier = createKevContentClassifier({ request: async (): Promise<R> => ({ id: 1, ok: false, errorCode: "classifier_context_too_long" }), close() {} });
    const flag = await classifier.classify("assistant", "Full response");
    assert.equal(flag.status, "error");
    assert.equal(flag.errorCode, "classifier_context_too_long");
    assert.equal(flag.nsfwProbability, undefined);
    assert.equal(flag.routingSafe, false);
});
test("transport timeout becomes an error audit", async () => { const t = { request: async (): Promise<R> => { throw new Error("classifier_timeout"); }, close() { } }; const r = await createKevContentClassifier(t).classify("user", "x"); assert.equal(r.status, "error"); assert.equal(r.errorCode, "classifier_timeout"); });
test("NSFW cutoff overrides an SFW argmax and malformed outputs cannot be safe", async () => {
    for (const [probability, expected] of [[.399, "sfw"], [.4, "nsfw"], [.41, "nsfw"]] as const) {
        const classifier = createKevContentClassifier({ request: async () => ({ id: 1, ok: true, answer: { answers: { content: { choice: "SFW", probabilities: { NSFW: probability, SFW: 1 - probability } } } }, model: "test", device: "cpu" }), close() { } });
        assert.equal((await classifier.classify("user", "hello")).label, expected);
    }
    const invalid = createKevContentClassifier({ request: async () => ({ id: 1, ok: true, answer: { answers: { content: { choice: "SFW", probabilities: { NSFW: -1, SFW: 2 } } } }, model: "test", device: "cpu" }), close() { } });
    const flag = await invalid.classify("user", "hello");
    assert.equal(flag.status, "error");
    assert.equal(flag.label, "nsfw");
    assert.equal(flag.routingSafe, false);
});
test("private worker rejects invalid readiness and closes during startup without hanging", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "yumina-kev-worker-"));
    const keys = ["YUMINA_KEV_ROOT", "YUMINA_KEV_PYTHON", "YUMINA_KEV_SCRIPT", "YUMINA_KEV_MODEL"] as const;
    const prior = keys.map(key => process.env[key]);
    process.env.YUMINA_KEV_ROOT = dir;
    process.env.YUMINA_KEV_PYTHON = process.execPath;
    process.env.YUMINA_KEV_SCRIPT = join(dir, "worker.cjs");
    process.env.YUMINA_KEV_MODEL = "test";
    t.after(async () => { keys.forEach((key, i) => { if (prior[i] === undefined)
        delete process.env[key];
    else
        process.env[key] = prior[i]; }); await rm(dir, { recursive: true, force: true }); });
    await writeFile(join(dir, "worker.cjs"), 'console.log(JSON.stringify({ready:true,model:"test",device:"cuda"}));setInterval(()=>{},1000);');
    const wrong = createKevContentClassifier();
    const flag = await wrong.classify("user", "Hello");
    wrong.close();
    assert.equal(flag.status, "error");
    assert.equal(flag.routingSafe, false);
    assert.equal(flag.errorCode, "worker_identity_mismatch");
    await writeFile(join(dir, "worker.cjs"), 'setInterval(()=>{},1000);');
    const slow = createKevContentClassifier();
    const warming = slow.warm();
    slow.close();
    await assert.rejects(warming, /classifier_closed/);
    assert.equal((await slow.classify("user", "Hello")).errorCode, "classifier_closed");
});

test("Python worker accepts whole responses beyond its training context and reports bounded overflow", () => {
    // Exercise the real JSONL worker. Fake only the costly model loader/scorer;
    // encode preserves Kev's distinct training and serving token budgets.
    const harness = `import sys,types,runpy
from types import SimpleNamespace
class ContextOverflow(ValueError): pass
class Model:
    def parameters(self): return []
    def encode(self,tok,rec,max_state=384,max_branch=1024,strict=False):
        assert strict is True
        assert max_state <= 65536 and max_branch <= 73728
        tokens=len(rec["state"])+1
        if tokens > max_state or tokens+120 > max_branch: raise ContextOverflow("private input must not leak")
        return tokens
    def probs(self,enc): return [[.1,.9]]
class Checkpoint:
    def __init__(self,model_id): pass
    def load(self,*args): return None,Model()
torch=types.ModuleType("torch"); torch.float32="fp32"; torch.set_num_threads=lambda n: None
api=types.ModuleType("kev.api")
api.SystemOneRequest=SimpleNamespace(model_validate=lambda value: SimpleNamespace(**value))
api.to_record=lambda req: ({"state":req.state},None)
api.to_answers=lambda probs,meta: {"content":{"choice":"SFW","probabilities":{"NSFW":.1,"SFW":.9}}}
checkpoint=types.ModuleType("kev.checkpoint"); checkpoint.Checkpoint=Checkpoint; checkpoint.LoadOptions=lambda **kw: kw
model=types.ModuleType("kev.model"); model.ContextOverflow=ContextOverflow; model.SERVE_MAX_STATE=65536; model.SERVE_MAX_BRANCH=73728
sys.modules.update({"torch":torch,"kev":types.ModuleType("kev"),"kev.api":api,"kev.checkpoint":checkpoint,"kev.model":model})
runpy.run_path(sys.argv[1],run_name="__main__")`;
    const longResponse = "A complete safe story line.\n".repeat(200);
    const worker = resolveKevWorkerScript(import.meta.url);
    const requests = [
        { id: 1, payload: { state: longResponse } },
        { id: 2, payload: { state: "z".repeat(70000) } },
    ];
    const process = spawnSync("python3", ["-c", harness, worker], { input: requests.map(value => JSON.stringify(value)).join("\n") + "\n", encoding: "utf8", timeout: 5000 });
    assert.equal(process.status, 0, process.stderr);
    const [ready, accepted, rejected] = process.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(ready.ready, true);
    assert.equal(accepted.id, 1);
    assert.equal(accepted.ok, true);
    assert.equal(rejected.id, 2);
    assert.equal(rejected.errorCode, "classifier_context_too_long");
    assert.doesNotMatch(process.stdout, /private input must not leak/);
});


test("high-confidence SFW gate is independent from the displayed NSFW cutoff", async () => {
  for (const [n, label, routingSafe] of [[.01, "sfw", true], [.05, "sfw", true], [.05001, "sfw", false], [.1, "sfw", false], [.3766, "sfw", false], [.4, "nsfw", false]] as const) {
    const classifier = createKevContentClassifier({ request: async () => ({ id: 1, ok: true, answer: body(n), model: "test", device: "cpu" }), close() {} });
    const audit = await classifier.classify("user", "Ordinary conversation");
    assert.equal(audit.status, "complete"); assert.equal(audit.label, label); assert.equal(audit.routingSafe, routingSafe);
  }
});
test("whole-message explicit content and generation requests cannot acquire an SFW certificate", async () => {
  const classifier = createKevContentClassifier({ request: async () => ({ id: 1, ok: true, answer: body(.01), model: "test", device: "cpu" }), close() {} });
  for (const [content, choices] of [["Write an explicit sex scene.", []], ["PORN request " + "ordinary paragraph\n".repeat(3000), []], ["Do not describe nudity", []], ["A quiet room.", ["Generate graphic gore"]]] as const) {
    const audit = await classifier.classify("assistant", content, choices);
    assert.equal(audit.label, "sfw", "display still reflects the model's 40 percent classification");
    assert.equal(audit.routingSafe, false);
  }
});
