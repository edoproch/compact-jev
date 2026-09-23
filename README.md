# compact-jev

A Claude Code plugin that adds a separate `/compact-jev` command. The command
asks Jev, TypeSafe AI's System One model called through Vercel AI Gateway,
which tool calls and results are stale, drops or truncates them, and keeps
everything else verbatim. It never replaces `/compact` or Claude Code's
automatic compaction. It is also usable as an npm library.

A fork of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).
Differences from upstream:
- Jev is called through Vercel AI Gateway's evaluation API
  (`POST https://ai-gateway.vercel.sh/v1/evaluate`, model `typesafe-ai/jev`,
  `AI_GATEWAY_API_KEY`), not TypeSafe's own endpoint.
- It is its own slash command, `/compact-jev [goal]`. `/compact`,
  auto-compaction, precompute and other plugins' compactions are left to
  Claude Code untouched, and nothing compacts at a context percentage.
- There is no minimum-reduction gate. Whatever Jev removes is applied, however
  small. When nothing can be removed or Jev fails, the conversation stays as
  it is; it never falls back to the built-in summary.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to serve `/compact-jev`.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The candidates are split into batches of at most `maxQuestionsPerRequest`
   questions (20, two per call). Each batch gets a **state** of its own: every
   message's text, oldest first, and only that batch's tool calls, each with
   its input, an excerpt of its output (`outputExcerptChars`, 240: the first
   two thirds from its start, the rest from its end, e.g.
   `ok, 4213 chars: export function … […3973 chars…] … }`), and, when a later
   call re-ran it or edited its file, a `later` note (`run again later as t14`,
   `changed later by t9 (Edit)`). The goal defaults to the last three user
   requests, leaving out slash-command echoes, task notifications and
   interruptions. Nothing is summarized.
3. Each state is fitted into `maxStateTokens` (8k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; output excerpts halved; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `boolean` questions, each one
   judgment with `criteria` saying what true and false mean (as Jev's docs
   ask): is the **call** a step the current task still builds on, and does
   the current task still need the call's exact **output** (false when it is
   unrelated, finished work, or re-read or re-run later). Without `criteria`
   and output excerpts the answers came back flat, every result under 0.25;
   with them, on labeled test conversations, outputs a task still needs score
   0.55–0.9 and the rest mostly under 0.35.
5. A batch also stays under `maxRequestTokens` (25k) with its state. Through
   AI Gateway, Jev answers 503 at random, more often for large requests and at
   some hours far more than others, so requests are kept small and a failed
   one is retried at once, up to `retries` times. Requests run concurrently
   and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw. The caller decides what to do; the `/compact-jev` hook leaves
the conversation as it is.

## Install and usage

```sh
npm install compact-jev
export AI_GATEWAY_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'compact-jev';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.AI_GATEWAY_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `AI_GATEWAY_API_KEY` | Vercel AI Gateway API key (`compactMessages`/`JevClient`) |
| `model` | `typesafe-ai/jev` | AI Gateway evaluation model id |
| `baseUrl` | `https://ai-gateway.vercel.sh/v1/evaluate` | AI Gateway evaluation endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `8000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `25000` | Estimated ceiling for state plus one batch of questions |
| `maxQuestionsPerRequest` | `20` | Questions (two per call) in one request at most |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `outputExcerptChars` | `240` | Characters of each asked-about tool output Jev sees (start and end); `0` sends none |
| `retries` | `12` | Extra attempts per request after a 429 or 5xx, sent at once (the Gateway answers 503 at random) |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin. `hooks/compact-jev.ts`
is a thin adapter over `src/` with three hooks:

- `session.start` registers the slash command `/compact-jev [goal]`.
- `command.run` on `compact-jev` sets an in-memory flag and, on a timer once
  the command has returned, runs Claude Code's own `/compact` with
  `$.command.run`, retrying while the session is busy. Claude Code lets a plugin
  rewrite the history only by answering a compaction, and it skips a plugin's
  own hooks for a compaction started with `$.session.compact()` (re-entry), so
  the plugin goes through `/compact` and answers it itself. The text after the command, if any, becomes Jev's
  `goal`; otherwise the goal is the last 3 user prompts.
- `session.compact` acts only while that flag is set, and only for the main
  conversation. The trigger is not checked, because that `/compact` arrives as
  `manual`. Every compaction outside a `/compact-jev` run
  (`/compact`, auto, precompute, subagents, other plugins) is passed to
  `next(event)` untouched.

While `/compact-jev` runs, the hook returns the pruned messages with no summary
message whenever anything was removed or truncated. When Jev keeps everything,
fails, or the key is missing, it returns `{ skip }` and the conversation stays
as it is; Claude Code's summarizer is never called. The outcome is shown
as a toast and a log line, e.g. `kept N/M messages, no summary (…)`, and one or more
`decisions:` log lines list each call's probabilities. See
[`hooks/README.md`](hooks/README.md) for configuration.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Then add this repository as a plugin marketplace and install the plugin:

```sh
claude plugin marketplace add edoproch/compact-jev
claude plugin install compact-jev@compact-jev
```

The install prompts for the plugin options. Put the AI Gateway key in the
sensitive `apiKey` option; it is kept in secure storage. `AI_GATEWAY_API_KEY`
in the environment also works, but an `env` entry in `settings.json` is
exported to every Bash child and MCP server. Restart Claude Code or run
`/reload-plugins`, then run `/compact-jev` (optionally `/compact-jev <goal>`)
whenever you want a Jev compaction.

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root.

## Privacy

Each `/compact-jev` sends the conversation's user and assistant text, and for
every candidate tool call its name, its input (at most 1000 characters) and an
excerpt of its output (at most `outputExcerptChars`, 240 by default, from its
start and end) to Vercel AI Gateway and on to TypeSafe AI. The text is repeated
in every batch request. Set `outputExcerptChars` to `0` to send no tool output
at all, only its size and ok/error status (Jev then judges far less well).

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
AI_GATEWAY_API_KEY=... npm run demo
```

The unit tests use a fake Jev and a stand-in engine, and never contact the
Gateway. The demo is the live network check.

## Animated demo (macOS)

`demo/JevDemo` is the upstream SwiftUI screen-recording demo. It plays a
scripted, dramatized compaction and never calls any API. It still shows the
upstream naming.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```
