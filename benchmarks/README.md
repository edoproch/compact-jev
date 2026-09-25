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

## Claude Code command check

I resumed the same Sonnet session interactively with the checkout loaded as a plugin and ran `/compact-jev Fix the cart discount rounding failure in src/cart.ts using tests/cart.test.ts.` Claude Code reported **43 → 23 messages, 86% character reduction, 10 calls removed, 2 results shortened, and no summary**. Its debug log confirmed that the plugin answered `session.compact` without calling `next()`, so the built-in summarizer did not run. The message count and decisions differ slightly from the replay because Claude Code includes command and engine messages and applies the six-message protection to that full session.
