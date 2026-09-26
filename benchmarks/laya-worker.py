"""JSON-lines bridge for the local Laya compaction benchmark.

Run with a Python environment containing laya: python benchmarks/laya-worker.py
multilingual mps. The first output line reports model load time; subsequent
lines answer requests from stdin. No transcript is sent to a remote service
after the checkpoint has been downloaded.
"""

import json
import os
import resource
import sys
import time

import laya


checkpoint = sys.argv[1] if len(sys.argv) > 1 else "multilingual"
device = sys.argv[2] if len(sys.argv) > 2 else "mps"
question_type = os.environ.get("LAYA_QUESTION_TYPE", "noul")
if question_type not in ("noul", "choice"):
    raise ValueError(f"Unknown question type: {question_type}")
models = {
    "english": "convaiinnovations/laya",
    "multilingual": "convaiinnovations/laya-multilingual",
    "typed-decisions": "convaiinnovations/laya-typed-decisions",
}
if checkpoint not in models:
    raise ValueError(f"Unknown checkpoint: {checkpoint}")

started = time.perf_counter()
agent = laya.load(models[checkpoint], device=device)
print(json.dumps({"ready": True, "loadMs": round((time.perf_counter() - started) * 1000)}), flush=True)

for line in sys.stdin:
    try:
        request = json.loads(line)
        questions = {}
        for key, question in request["questions"].items():
            if question_type == "choice":
                criteria = question["criteria"]
                questions[key] = {
                    "type": "choice",
                    "instructions": question["instructions"],
                    "criteria": {"A": criteria["true"], "B": criteria["false"]},
                }
            else:
                questions[key] = {**question, "type": "noul"}
        started = time.perf_counter()
        result = agent.predict(
            request["state"],
            questions,
            max_len=8192 if checkpoint == "multilingual" else None,
        )
        answers = {
            key: {"type": "boolean", "probability": (
                value["probabilities"]["A"] if question_type == "choice" else value["noul"]
            )}
            for key, value in result["answers"].items()
        }
        print(json.dumps({
            "id": request["id"],
            "answers": answers,
            "inferMs": round((time.perf_counter() - started) * 1000),
            "usage": result.get("usage"),
            "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (
                1024 if sys.platform.startswith("linux") else 1
            ),
        }), flush=True)
    except Exception as error:
        print(json.dumps({"id": request.get("id"), "error": str(error)}), flush=True)
