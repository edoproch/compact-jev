# Sonnet compaction benchmark

On 2026-09-25, Claude Code 2.1.282 ran four read-only turns with `--model sonnet` (the run reported `claude-sonnet-5`). Its available tools were `Read`, `Glob`, `Grep`, and `Bash`; the only Bash command was `wc -l` on the fixture files. The scratch files were synthetic TypeScript code, tests, and notes. Their deliberately long, repeated lines make the size reduction larger than a typical coding conversation might show.

The session produced 14 tool calls. [sonnet-session.json](sonnet-session.json) contains its user and assistant text, tool inputs, and tool outputs in the `Message` format consumed by the plugin's compaction core. Absolute temporary paths and random tool IDs were normalized. Thinking blocks, system prompts, and CLI metadata were excluded. The fixture records the four exact user prompts.

The [runner](run.ts) sends this same fixture to the real Jev model through Vercel AI Gateway, three times with no `goal` option and three times with `goal: "Fix the cart discount rounding failure in src/cart.ts using tests/cart.test.ts."` The no-goal path infers the last three user requests. It uses the plugin's default compaction options, including protection of the six newest messages. Each run makes two Jev evaluation requests. Results are saved in [results.json](results.json); no API key or private session content is stored there.

Run it again with `AI_GATEWAY_API_KEY` set:

```sh
npm install
npm run benchmark > benchmarks/results.json
```

## Results

All three repeats per condition made the same decisions. The numbers below are the median, which is also the value in each repeat.

| Measure | Inferred goal | Explicit cart goal |
| --- | ---: | ---: |
| Transcript characters | 60,171 → 11,023 (−81.7%) | 60,171 → 8,384 (−86.1%) |
| Transcript messages | 39 → 37 | 39 → 21 |
| Calls removed | 1 | 9 |
| Results shortened | 9 | 2 |
| Calls kept or pinned | 4 | 3 |

The table counts characters in message text, tool inputs, and tool results as [`messageChars`](../src/compact.ts) does. It does not measure Claude Code's actual context tokens, system prompt, or cache use. A `shorten` decision retains the call and a bounded output head; `remove` deletes the historical call and result. None of these decisions disables a tool. The text of all user and assistant messages was verified unchanged.

Claude Code's token indicator resets to zero immediately after `/compact-jev`, before Sonnet receives another request. The next API usage count includes the system prompt and tool definitions, which Claude Code can refresh during compaction. Those counts did not give us a comparable before/after measure of the conversation alone, so no token-savings percentage is claimed here.

| Call | Tool and target | Inferred goal | Explicit goal |
| --- | --- | --- | --- |
| t1 | `Read docs/billing.md` | shorten | remove |
| t2 | `Read src/billing.ts` | shorten | remove |
| t3 | `Read src/tax.ts` | shorten | remove |
| t4 | `Read docs/release.md` | shorten | remove |
| t5 | `Read src/cart.ts` | shorten | shorten |
| t6 | `Read tests/cart.test.ts` | shorten | shorten |
| t7 | `Read docs/release.md` | shorten | remove |
| t8 | `Read docs/billing.md` | shorten | remove |
| t9 | `Read src/cart.ts` | remove | remove |
| t10 | `Glob src/**/*.ts` | keep | remove |
| t11 | `Glob docs/**/*.md` | shorten | remove |
| t12 | `Glob tests/**/*.ts` | pinned | pinned |
| t13 | `Grep round in src` | pinned | pinned |
| t14 | `Bash wc -l …` | pinned | pinned |

In the explicit-goal run, Jev also removed the second read of `src/cart.ts`, even though that file is central to the stated task. The earlier read was shortened, so Claude would need to re-read the file to see its full contents. This benchmark measures compaction and decisions, not whether a later coding task would succeed without another tool call. Results may change with model behavior, file contents, settings, or the recent-message boundary.

## Local Laya comparison (2026-09-26)

I installed `laya==0.3.20` in a separate Python 3.12 environment and loaded
`convaiinnovations/laya-multilingual` on an Apple Silicon Mac with 16 GB of
unified memory. The [comparison runner](compare-laya.ts) uses the same fixture,
questions, decision threshold, and compaction code for both models. Its
[Python bridge](laya-worker.py) converts Jev's boolean questions to Laya's
`noul` questions and uses `max_len=8192`. Each row below is one live run of
Laya and Jev, with Laya's checkpoint already downloaded. Model loading is
measured separately. The [recorded responses](laya-comparison.json) contain
per-call decisions, probabilities, timings, and token counts.

The Italian fixture translates **the four user requests only**. Claude's
responses, code, tool inputs, and outputs remain in English, so it represents
a mixed-language coding session rather than a fully Italian one. Jev is the
comparison baseline, not a ground-truth label for every decision.

| Fixture and goal | Laya time | Jev time | Laya reduction | Jev reduction | Calls removed, Laya / Jev |
| --- | ---: | ---: | ---: | ---: | ---: |
| English, explicit cart goal; full state | 66.49 s | 1.29 s | 27.1% | 86.1% | 0 / 9 |
| Italian prompts, explicit cart goal; full state | 25.02 s | 1.44 s | 27.0% | 85.9% | 0 / 9 |
| Italian prompts, inferred goal; 1,200-token Laya state | 9.48 s | 0.91 s | 27.0% | 82.9% | 0 / 3 |

The full states held about 4,200 estimated tokens. Laya encodes that state
again for each question: the two requests in the Italian explicit run reported
78,102 and 5,072 input tokens. Its `noul` probabilities were high for nearly
every call, including old billing and release work, so it kept all 11
non-pinned calls. Three results were shortened by the compactor's deterministic
duplicate rule. JEV agreed with Laya on only 4 of 14 actions in each explicit
case, including the 3 calls pinned by the compactor.

I also tested two changes to the adapter. At a 1,200-token state, `noul` took
5.05 s on the Italian explicit case but still removed no calls. Converting the
questions to a two-option `choice` took 25.74 s with the full state or 4.55 s
with a short state; it removed **all 11** non-pinned calls. That includes the
reads of `src/cart.ts` and `tests/cart.test.ts` needed for the stated task.
The similar 87.3% reduction is therefore not evidence of comparable quality.
For this explicit cart task, two simple review checks are: retain at least
one `src/cart.ts` read and the `tests/cart.test.ts` read as calls, and discard
the older billing/release work. Jev passes both checks (though it shortens the
two relevant outputs), Laya `noul` fails the stale-work check, and Laya
`choice` fails the relevant-read check. These checks do not establish general
accuracy; a labeled set of real compactions is still needed.

Warm checkpoint loading took 6.1–56.2 s across the recorded processes;
first download requires network access to Hugging Face. The Python process
reported peak resident memory of 1.3–2.2 GB in completed runs. The macOS
process view showed roughly 7–11 GB of combined memory during longer runs.
A repeated full-context run in one process grew and slowed severely, and a
fresh full-context Italian inferred-goal run was interrupted after more than
two minutes without a result. This makes a persistent local worker unsuitable
for the plugin as measured. The runner now limits each invocation to one
condition and times out a request after two minutes.

**Decision:** keep Jev as the plugin's model for now. These results do not
support offering Laya as a user option or an automatic model download. A
future attempt would need a compaction-specific question formulation or
fine-tuned checkpoint, labeled English and non-English sessions, and bounded
latency and memory on CPU and GPU. Laya's [model card](https://huggingface.co/convaiinnovations/laya-multilingual)
also reports weak zero-shot performance on typed decisions and recommends
task-specific fine-tuning.

Reproduce one case in a fresh process:

```sh
python3.12 -m venv ~/.cache/compact-jev-laya-venv
~/.cache/compact-jev-laya-venv/bin/python -m pip install laya==0.3.20
LAYA_PYTHON=~/.cache/compact-jev-laya-venv/bin/python \
  LAYA_DEVICE=mps BENCH_LANGUAGE=it BENCH_CONDITION=explicit \
  AI_GATEWAY_API_KEY=... ./node_modules/.bin/tsx benchmarks/compare-laya.ts > /tmp/laya-it-explicit.json
```

Set `LAYA_DEVICE=cpu` on machines without Apple MPS or CUDA. Omit
`AI_GATEWAY_API_KEY` to run only Laya. Use `LAYA_MAX_STATE_TOKENS=1200` for the
short-state case or `LAYA_QUESTION_TYPE=choice` for the alternative question
formulation. Run repeats in separate processes to include the same load and
memory conditions.

## Claude Code command check

I resumed the same Sonnet session interactively with the checkout loaded as a plugin and ran `/compact-jev Fix the cart discount rounding failure in src/cart.ts using tests/cart.test.ts.` Claude Code reported **43 → 23 messages, 86% character reduction, 10 calls removed, 2 results shortened, and no summary**. Its debug log confirmed that the plugin answered `session.compact` without calling `next()`, so the built-in summarizer did not run. The message count and decisions differ slightly from the replay because Claude Code includes command and engine messages and applies the six-message protection to that full session.
