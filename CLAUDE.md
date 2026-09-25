# CLAUDE.md — compact-jev

## Project overview

`compact-jev` is a Claude Code plugin, and an npm library, that adds a separate
`/compact-jev [goal]` slash command. The command compacts the conversation
**without summarizing**. It asks Jev, TypeSafe AI's System One evaluation
model, whether each tool call and each tool result is still needed, then drops
or truncates the stale ones. All user and assistant text stays verbatim.

Jev is called through **Vercel AI Gateway's evaluation API**:
`POST https://ai-gateway.vercel.sh/v1/evaluate`, model `typesafe-ai/jev`,
`Authorization: Bearer $AI_GATEWAY_API_KEY`.

It is a fork of `tamaratran/fast-jev-compaction` (remote `upstream`). The fork
differs in three ways:
- Jev is reached through the Gateway rather than TypeSafe's API.
- Compaction is a separate command and never intercepts `/compact` or
  auto-compaction.
- There is no minimum-reduction gate, and there is no fallback to the built-in
  summary.

**Stack:** TypeScript (ESM, Node ≥ 18 for the library), vitest. The Claude Code
function-hooks API is early access (2.1.274+, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`).

**Commands:**

| Task | Command |
| --- | --- |
| Install | `npm install` (or `npm ci --ignore-scripts`) |
| Test | `npm test` (vitest, fake Jev + stand-in engine, no network) |
| Live benchmark | `AI_GATEWAY_API_KEY=... npm run benchmark` (real Jev, six runs and 12 requests over a Sonnet transcript) |
| Type-check | `npm run typecheck` (`src/` via tsconfig.json and `hooks/` via tsconfig.hooks.json; tests are not type-checked) |
| Build library | `npm run build` (→ `dist/`, gitignored) |
| Pack library | `npm pack` (`prepack` builds `dist/` first) |
| Validate plugin | `npm run validate:plugin` (`claude plugin validate`) |
| Live demo | `AI_GATEWAY_API_KEY=... npm run demo` (real network call) |
| Run plugin from checkout | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .` |

## Directory tree

```
compact-jev/
├── .claude-plugin/
│   ├── plugin.json        # plugin manifest + userConfig options
│   └── marketplace.json   # makes the repo installable as a marketplace
├── hooks/
│   ├── hooks.json         # {"modules": ["./compact-jev.ts"]}
│   ├── compact-jev.ts     # the function-hooks module (Claude Code adapter)
│   └── README.md          # plugin behaviour + configuration
├── benchmarks/
│   ├── README.md          # Sonnet/Jev measurement method, results, per-call decisions
│   ├── sonnet-session.json # normalized, synthetic-file Claude Code Sonnet transcript
│   ├── run.ts             # live Jev replay: inferred vs explicit goal, three repeats each
│   └── results.json       # recorded live decisions and size statistics
├── src/                   # the library (host-agnostic)
│   ├── index.ts           # re-exports everything
│   ├── types.ts
│   ├── state.ts
│   ├── compact.ts
│   ├── request.ts
│   ├── client.ts
│   └── messages.ts
├── tests/
│   ├── fast-jev-compaction.test.ts   # library tests
│   └── hook.test.ts                  # hook tests (register() vs stand-in engine)
├── examples/demo.ts       # live demo over a canned transcript
├── types/claude-code.d.ts # ~11k lines, generated Claude Code 2.1.274 hook API types
├── demo/JevDemo/          # upstream SwiftUI screen-recording animation (no API calls)
├── tsconfig.json          # library build/type-check
└── tsconfig.hooks.json    # hook type-check (maps 'claude-code' to types/)
```

## File / folder purpose index

### Library: compaction (`src/`)

- **`types.ts`**: every type.
  - Conversation types: `Message` (a subset of Claude Code's `SessionMessage`), `ToolUse`, `ToolResult`, `ToolCall`.
  - Decision types: `CallAnswer`, `CallDecision`.
  - Options and result: `CompactOptions`, `CompactResult` (with `stats`).
  - Wire types: `BooleanQuestion` / `ChoiceQuestion` / `ScoreQuestion`, `BooleanAnswer` (`probability`), `JevResponse`.
  - `JevAsker`, the transport interface.
- **`state.ts`**: builds and sizes the state Jev sees.
  - Pairing and pinning: `collectToolCalls` pairs tool_use and tool_result by id and assigns ids `t1…tN`; `isPinned` pins the first message and the newest `preserveRecentMessages`.
  - Call facts: `callTarget` (the path/command/URL/query a call acts on), `outputExcerpt` (start + end of an output), `laterNotes` (`run again later as tN`, `changed later by tN (Edit)`).
  - Estimation: `estimateTokens`, a heuristic that uses no tokenizer.
  - Goal: `goalFromMessages` defaults to the last 3 user requests, skipping slash-command echoes, `<local-command-…>`, task notifications, interruptions and `[Image #n]` placeholders.
  - Fitting: `fitState(messages, calls, options, allCalls?)` lists every message's text plus only `calls` (with output excerpts and `later` notes computed over `allCalls`), and reduces it in stages into `maxStateTokens`; it throws if the state cannot fit. `STATE_CONTEXT` is the fixed preamble sent with the state.
- **`compact.ts`**: orchestration.
  - Options: `resolveOptions`, `DEFAULT_OPTIONS`.
  - Questions: `questionsFor` produces two `boolean` questions per call, `call_tN` and `result_tN`, each with `criteria` (`CALL_CRITERIA`, `RESULT_CRITERIA`) and the call's tool + target in the instructions; `batchCalls` packs them into requests of at most `maxQuestionsPerRequest` under `maxRequestTokens`.
  - Decisions: `decideCall` chooses keep, `drop_result` (truncate the head) or `drop_call`, using `keepThreshold`; `applyDecisions` rebuilds the messages.
  - Entry points: `compact(messages, asker, options)` is the main one; `reductionRatio` is a helper.
- **`request.ts`**: the HTTP shape, with no I/O.
  - Constants: `EVALUATE_URL`, `DEFAULT_MODEL`, `PROVIDER_OPTIONS` (ZDR and no training), and `NO_TRAINING_PROVIDER_OPTIONS` (no training only).
  - Functions: `buildJevRequest`, `askJev` (tries ZDR first and retries without it only after a ZDR-specific 400/402/403), `parseJevResponse` (throws `JevRequestError` with `status`, `responseText` and `retryable` on non-2xx), and `probabilityAnswer`, which extracts one boolean answer.
- **`client.ts`**: `JevClient` implements `JevAsker` over `fetch` using `askJev`. The key comes from the option or from `AI_GATEWAY_API_KEY`, and the client is Node-only. `onZdrFallback` reports a privacy downgrade to library callers.
- **`messages.ts`**: `compactMessages(messages, opts)` is `compact` with a `JevClient`.

### Claude Code plugin (`hooks/`, `.claude-plugin/`)

- **`hooks/compact-jev.ts`**: exports `register(on, options)` plus testable helpers.
  - Helpers: `resolveHookConfig`, `jevAsker` (over `$.http.fetch`), `toSessionMessages`, `compactSession`, `changedAnything`, `summarize`, `decisionLog`, `decisionLogLines`, and the `COMMAND` constant.
  - Hooks: `session.start` registers the command; `command.run` on `compact-jev` serves it; `session.compact` is gated.
- **`.claude-plugin/plugin.json`**: `userConfig` options, namely `apiKey` (sensitive), `keepThreshold`, `preserveRecentMessages`, `maxStateTokens`, `maxRequestTokens`, `maxQuestionsPerRequest`, `truncateHeadChars`, `outputExcerptChars`, `retries` and `model`.
- **`types/claude-code.d.ts`**: the reference for every `$` call and event shape. Grep it; do not read it whole. Regenerate it with `/plugin-types` after a Claude Code upgrade.

## Key architectural patterns

- **The library is host-agnostic.** `src/` never imports Claude Code. The hook module calls `src/` directly, because the plugin root is the repo root.
- **The hook runtime has no Node and no DOM.**
  - Inside `hooks/`, use `$.http.fetch`, `$.env.get` and `$.settings.read`; never `fetch`, `process.env` or npm packages.
  - `import type … from 'claude-code'` is erased at run time.
- **Gating is what keeps the plugin from touching `/compact`.**
  - `command.run` sets a closure variable, `pending`, and with `$.clock.after` runs core's `/compact` via `$.command.run({ command: 'compact' })`, retrying while the session is busy; it reports the outcome with `ui.toast` and `ui.log`. The outcome comes from `run.outcome`, because `/compact` resolves `{}` whatever happened.
  - **Never use `$.session.compact()` here.** The engine skips the calling plugin's own hooks for a compaction its code raised (debug log: `session.compact skipped: re-entry (the plugin's own code raised it)`), so core's summary ran instead of Jev. A compaction raised by core's `/compact` reaches the hook normally.
  - `session.compact` acts only if `pending` is set and there is no `agentId`. Every other case must `return next(event)` untouched.
  - Do not gate on `trigger`: the `/compact` the command runs arrives as `manual`.
  - **The built-in summary must never run during `/compact-jev`.** Three layers enforce this:
    1. `classic.PreCompact` returns `{ block }` while `pending`, because core raises PreCompact before summarizing. It is only a backstop: on machines with managed settings the built-in `sec-default` plugin sits outermost on `classic.*` and answers first, so this veto is never reached.
    2. The `session.compact` registration's `.catch` answers `{ skip }` if the hook throws or times out during a run. It must be chained directly on `on(...)`; `claude plugin validate` rejects a stored registration.
    3. If `/compact` resolves without `run.handled`, it warns (`warning: /compact-jev failed, …`).
  - Do not add `turn.complete` or auto triggers; they would violate the product requirement.
- **Outcomes never fall back to the summary.**
  - If anything changed, return `{ messages }`: the pruned transcript, with no summary message.
  - If nothing changed, or on any error, return `{ skip: reason }`.
  - Never call `next(event)` during a `/compact-jev` run, because `next` runs Claude Code's summarizer.
  - There is no minimum-reduction threshold, by design.
- **Handles:** messages the library returns unchanged are the engine's own objects, with their `handle`. Rebuilt ones have no handle, and the engine rebuilds them from `role`, `text` and the tool blocks. `toSessionMessages` maps by object identity.
- **Wire format:** the Gateway evaluation API uses `type: 'boolean'` questions and answers `{ type: 'boolean', probability }`. This is not TypeSafe's native `noul`. Usage fields are camelCase (`inputTokens`).
- **How Jev is asked (quality, measured 2026-09-23):** follow Jev's docs (docs.typesafe.ai primitives/jaggedness, vercel.com/docs/ai-gateway/modalities/evaluation):
  - Every boolean question carries `criteria: { true, false }` and asks one judgment. Without criteria, and with outputs replaced by `ok, N chars (omitted)`, every `keepResult` came back under 0.25 (so nothing was ever kept) even though the ranking was right.
  - Each batch gets its **own focused state**: all message texts plus only that batch's calls, with an output excerpt and `later` notes. Docs: unrelated state is a distractor.
  - On three labeled synthetic conversations (lab harness, not in the repo), agreement with the labels was 98–100/102; needed outputs score 0.55–0.9, stale ones mostly < 0.35. On real Bash-heavy sessions of this project, keepResult stays low (< 0.3) but keepCall ranks the task-relevant calls first, so they end as `drop_result` (call + 300-char head) instead of vanishing.
  - A `choice` question (keep/brief/drop) was tried and discriminated worse than two booleans with criteria. Short criteria (≈25 tokens) separated worse than the current ones.
  - The softer false criterion ("re-read or re-ran", not "changed") matters: a small Edit does not make an earlier Read of that file useless.
- **Request sizing and retries (Gateway reliability):** Jev through AI Gateway answers 503 ("Service temporarily unavailable") at random, more often for larger requests, and the rate swings over time (the same ~11k-token request passed 15%, then 53%, of attempts minutes apart; ~6k-token requests 80–95%). Parallel requests are no worse than sequential ones, and spacing attempts does not help. Defaults: `maxStateTokens` 8000 (6000 changed 11/87 decisions vs 4/87 run-to-run noise), `maxQuestionsPerRequest` 20 (~11k input tokens with criteria), `retries` 12 (immediate; `askBatch` resends a `JevRequestError` with `retryable`, i.e. 429/5xx, and counts them in `stats.retries`). A 644-message, 251-call transcript took 26 requests, ~7 s and 30–40 retries.
- **Decisions:** `keepResult ≥ τ` keeps everything; otherwise `keepCall ≥ τ` truncates the result to `truncateHeadChars` plus a note (only when the result is longer than head + 120); otherwise the call and its result are removed. Then `dropRepeats` truncates a kept output whose identical later call (same tool and input) is kept or pinned too (reason `repeated`): Jev kept both copies of a re-read file even with a `later` note or the later copy in the state, so this is deterministic.

## Common workflows

**Reproduce the Sonnet benchmark:** set `AI_GATEWAY_API_KEY`, run `npm run benchmark > benchmarks/results.json`, and compare the results with `benchmarks/README.md` and the short table in the root README. The fixture is a recorded Claude Code Sonnet session; the runner replays it through the compaction library and live Jev. Its percentage is a count of transcript characters, not actual Claude Code context tokens. Update the reported numbers only after a live run. The source session used synthetic files with repeated long lines, so do not generalize its reduction rate.

**Pack the npm library:** `npm pack` runs `prepack` (`npm run build`) so a clean checkout includes `dist/` even though it is gitignored. Only `dist/`, README, LICENSE and package metadata are published. Validate the tarball with a fresh install before publishing; publishing needs an authenticated npm account with 2FA or an approved publishing credential.

**Release an npm patch:** bump `package.json`, `package-lock.json` and `.claude-plugin/plugin.json` together; update the README before packing because npm versions cannot be overwritten. Run tests, typecheck, plugin validation and `npm publish --dry-run --access public`, then publish with the account's 2FA approval and verify a fresh install from the registry.

**Change what Jev is asked:**
1. Edit `questionsFor` / the criteria in `src/compact.ts` (or `STATE_CONTEXT` / `historyEntries` in `src/state.ts`). Measure before and after on labeled conversations with the real API: flat probabilities mean the question or state is wrong, not the model.
2. Update the exact-text expectations in `tests/fast-jev-compaction.test.ts`.
3. Run `npm test`.

**Add a plugin option:**
1. Declare it in `.claude-plugin/plugin.json` under `userConfig`. Undeclared options never reach `register`.
2. Read it in `resolveHookConfig` in `hooks/compact-jev.ts`. If it is a library option, add it to `CompactOptions` and `resolveOptions` as well.
3. Document it in `hooks/README.md`.
4. Add a test in `tests/hook.test.ts`.

**Change the command's behaviour or output:**
1. Edit the `command.run` and `session.compact` hooks in `register()`.
2. Extend the stand-in `engine()` tests in `tests/hook.test.ts`, which simulate `$` and `next`.
3. Keep the test that asserts `/compact` and auto-compaction make zero fetches and call `next`.

**Switch model or endpoint:** change `DEFAULT_MODEL` / `EVALUATE_URL` in `src/request.ts`, the `model` default in `plugin.json`, and `HOOK_DEFAULTS` in `hooks/compact-jev.ts`.

**Verify live (the stand-in engine cannot catch engine behaviour):**
1. Make a throwaway session with tool calls: `claude -p --model haiku --allowedTools Read "Read a.txt …"` in a trusted scratch folder (with `CLAUDE_CODE_CHILD_SESSION` unset when run from inside Claude Code).
2. Drive an interactive `claude --resume <id> --plugin-dir ~/compact-jev --debug-file dbg.txt` with `expect`, typing `/compact-jev`. Headless `-p` cannot compact from a plugin.
3. In `dbg.txt`, look for `compacting N messages with Jev`, `decisions:` and `answered session.compact without next()`, and for no `re-entry` skip on `session.compact`.

**After a Claude Code upgrade:**
1. Regenerate `types/claude-code.d.ts`.
2. Run `npm run typecheck`.
3. Run `npm run validate:plugin`.

## Environment & config

- **`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`** is required wherever Claude Code runs the plugin.
- **`AI_GATEWAY_API_KEY`** is the Vercel AI Gateway key. The hook looks it up in this order:
  1. the sensitive `apiKey` plugin option (preferred; kept in secure storage);
  2. the process env;
  3. `env.AI_GATEWAY_API_KEY` in the merged settings.

  The library reads `process.env.AI_GATEWAY_API_KEY`. Never commit a key.
- **Defaults:**
  - `keepThreshold` 0.5
  - `preserveRecentMessages` 6
  - `maxStateTokens` 8000
  - `maxRequestTokens` 25000
  - `maxQuestionsPerRequest` 20
  - `truncateHeadChars` 300
  - `outputExcerptChars` 240
  - `retries` 12
  - `model` `typesafe-ai/jev`
- **Install:** `claude plugin marketplace add edoproch/compact-jev`, then `claude plugin install compact-jev@compact-jev`.
- **Privacy:** every run sends all user and assistant text, the tool inputs (at most 1000 characters each) and an excerpt of each candidate tool output (at most `outputExcerptChars`, 240) to the Gateway and on to TypeSafe. `outputExcerptChars: 0` sends no output. Every request first requires ZDR and no prompt training. On a ZDR-specific 400/402/403 (including Hobby plan rejection or `no_providers_available`), `askJev` retries the same state and questions with no prompt training still required, but without requesting ZDR. Other errors do not weaken the policy. Hobby users may therefore have provider-side retention under TypeSafe's terms. The hook's outcome notes when any batch used the fallback; library callers can use `onZdrFallback`. Gateway routing metadata confirms applied request filters.
