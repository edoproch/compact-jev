# compact-jev

`/compact-jev` is a Claude Code plugin that frees context without writing a summary. It asks [Jev](https://vercel.com/ai-gateway/models/jev), through Vercel AI Gateway, which old tool calls and results still matter. It keeps your and Claude's messages verbatim, removes stale calls, and shortens stale results. It runs only when you type `/compact-jev`; Claude Code's `/compact` and automatic compaction still work normally.

The repository also contains a TypeScript library for using the same compaction logic outside Claude Code.

## Install

You need Claude Code **2.1.274 or later** and your own [Vercel AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys).

1. Enable Claude Code function hooks in `~/.claude/settings.json` (merge this with your existing `env` block):

   ```json
   { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
   ```

2. Install the plugin:

   ```sh
   claude plugin marketplace add edoproch/compact-jev
   claude plugin install compact-jev@compact-jev
   ```

   On Claude Code 2.1.275+, you can instead run `/plugin install compact-jev --marketplace edoproch/compact-jev` inside a session.

3. Set the **AI Gateway API key** in the plugin's configuration (`/plugin`). The `apiKey` field is stored as a sensitive value. Alternatively, set `AI_GATEWAY_API_KEY` in the environment before starting Claude Code. Restart Claude Code, or run `/reload-plugins`.

## Use

Run `/compact-jev` in a long conversation. Optionally add the task you want Claude to continue:

```text
/compact-jev
/compact-jev fix the failing test in src/cart.ts
```

Jev judges tool calls against that task. Without an explicit task, it uses your last three requests. The first message and the six newest messages are always preserved. The command reports how many messages it kept, whether it used the no-training fallback, and per-call decisions in the debug log (`claude --debug`). If Jev or the Gateway fails, the conversation stays as it is; no summary replaces it.

## Measured example

I ran four read-only turns in Claude Code 2.1.282 with `--model sonnet` (resolved to `claude-sonnet-5`), then replayed the same 14-tool-call transcript through Jev three times per condition. All three runs in each condition produced the same decisions:

| | No goal (last three requests) | Goal: fix the cart rounding bug |
| --- | ---: | ---: |
| Transcript characters | 60,171 → 11,023 (**−81.7%**) | 60,171 → 8,384 (**−86.1%**) |
| Historical tool calls removed | 1 / 14 | 9 / 14 |
| Tool results shortened | 9 | 2 |

With the explicit goal, old `Read` calls about billing and release notes and two `Glob` calls were removed. Three recent calls (`Glob`, `Grep`, `Bash`) were protected in both replays. I also ran `/compact-jev` inside the actual Sonnet session: it kept 23 of 43 messages, removed 10 historical calls, and reported 86% character reduction without a summary. The files were synthetic and deliberately long, so this is an example, not an expected reduction rate. **We have not measured a comparable before/after count of Sonnet context tokens**; these percentages count transcript characters. See the [full method, per-call decisions, fixture, and live runner](benchmarks/README.md).

## Privacy and Vercel plans

Each run sends user and assistant text, tool inputs, and short excerpts of candidate tool outputs to Vercel AI Gateway and TypeSafe AI. The state is repeated across batches. Set `outputExcerptChars` to `0` in `/plugin` if you do not want tool output sent; this reduces Jev's accuracy. Your full tool outputs are not sent by default.

| Vercel plan attached to the API key | Gateway request policy |
| --- | --- |
| Pro or Enterprise | Requests first require **zero data retention (ZDR)** and **no prompt training**. |
| Hobby | ZDR is not available. When the Gateway rejects ZDR, the plugin automatically retries with **no prompt training** still required. |

The plugin cannot infer the plan from the key itself. It tries the stronger policy first and only changes it after an explicit ZDR-related error. A different error does not weaken the policy. If no provider meets the required policy, compaction stops and leaves the conversation unchanged. **No prompt training does not mean zero retention**: on the Hobby fallback, TypeSafe AI may retain data under its applicable terms. Vercel says [per-request ZDR requires Pro or Enterprise](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr), while [no prompt training is available to all users](https://vercel.com/changelog/zero-data-retention-no-prompt-training-on-ai-gateway).

A Vercel *Hobby plan* and the [AI Gateway free credit tier](https://vercel.com/docs/ai-gateway/pricing) are different things. Check the [Jev model page](https://vercel.com/ai-gateway/models/jev) for its current price.

## Configuration

The defaults work without tuning. Set options in `/plugin`:

| Option | Default | Purpose |
| --- | --- | --- |
| `apiKey` | `AI_GATEWAY_API_KEY` | Your Gateway key. |
| `keepThreshold` | `0.5` | Probability needed to keep a call or result. |
| `preserveRecentMessages` | `6` | Newest messages protected from compaction. |
| `outputExcerptChars` | `240` | Characters of each tool output sent to Jev; `0` sends none. |
| `truncateHeadChars` | `300` | Characters kept from a shortened tool result. |
| `maxStateTokens` | `8000` | Estimated state size per Jev request. |
| `maxRequestTokens` | `25000` | Estimated request size per batch. |
| `maxQuestionsPerRequest` | `20` | Questions per batch; two are asked per tool call. |
| `retries` | `12` | Extra tries for Gateway 429 and 5xx responses. |
| `model` | `typesafe-ai/jev` | Gateway evaluation model. |

The key is resolved from the sensitive plugin option first, then the process environment, then `env.AI_GATEWAY_API_KEY` in Claude Code settings. Prefer the sensitive option: settings environment values are also passed to child processes.

## TypeScript library

The library is **not yet published on npm**. To use it from a checkout, run `npm install && npm run build`, then import from `dist/index.js`. `compactMessages(messages, options)` uses `AI_GATEWAY_API_KEY` by default; pass `onZdrFallback` in its options to detect a no-training-only retry. To supply your own transport, implement `JevAsker` and call `compact(messages, asker, options)`. See [`src/index.ts`](src/index.ts) for exports and [`examples/demo.ts`](examples/demo.ts) for an example.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
npm run validate:plugin
```

To load the checkout directly, run `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`. Function hooks are an early-access Claude Code API and may change between releases. The checked-in type declarations target Claude Code 2.1.274.

This project is a fork of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction). Licensed under [MIT](LICENSE).
