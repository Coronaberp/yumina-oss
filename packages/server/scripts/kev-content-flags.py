#!/usr/bin/env python3
"""Private offline Kev worker. Protocol is JSONL; stdout is JSON only, stderr is discarded by caller."""
import json, os, sys

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n"); sys.stdout.flush()

def main():
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ["HF_HUB_OFFLINE"] = "1"; os.environ["TRANSFORMERS_OFFLINE"] = "1"; os.environ["KEV_BACKEND"] = "torch"; os.environ["KEV_DTYPE"] = "fp32"
    import torch
    torch.set_num_threads(4)
    from kev.checkpoint import Checkpoint, LoadOptions
    from kev.api import SystemOneRequest, to_record, to_answers
    from kev.model import ContextOverflow, SERVE_MAX_STATE, SERVE_MAX_BRANCH
    model_id = os.environ.get("KEV_MODEL", "jaredpalmer/kev-0.8b")
    ck = Checkpoint(model_id)
    tok, model = ck.load("cpu", LoadOptions(dtype=torch.float32, backend="torch", cuda_graphs=False, fused=False))
    if any(p.device.type != "cpu" for p in model.parameters()):
        raise RuntimeError("model_not_cpu")
    emit({"ready": True, "model": model_id, "device": "cpu"})
    for line in sys.stdin:
        msg = {}
        try:
            msg = json.loads(line); rid = msg.get("id"); req = SystemOneRequest.model_validate(msg["payload"])
            rec, meta = to_record(req); encoded = model.encode(tok, rec, strict=True, max_state=SERVE_MAX_STATE, max_branch=SERVE_MAX_BRANCH); probs = model.probs(encoded)
            emit({"id": rid, "ok": True, "answer": {"answers": to_answers(probs, meta)}, "model": model_id, "device": "cpu"})
        except ContextOverflow:
            emit({"id": msg.get("id") if isinstance(msg, dict) else -1, "ok": False, "errorCode": "classifier_context_too_long"})
        except Exception:
            # Do not expose model paths, story text, or exception strings through the protocol.
            emit({"id": msg.get("id") if isinstance(msg, dict) else -1, "ok": False, "errorCode": "classifier_inference_failed"})

if __name__ == "__main__":
    try: main()
    except Exception: emit({"ready": False, "errorCode": "worker_start_failed"}); sys.exit(1)
