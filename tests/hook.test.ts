import { describe, expect, it } from 'vitest';
import {
  changedAnything,
  COMMAND,
  compactSession,
  decisionLog,
  decisionLogLines,
  register,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/compact-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'boolean', probability: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ model: 'typesafe-ai/jev' });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', preserveRecentMessages: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
    });
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/AI_GATEWAY_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

type Handler = (...args: never[]) => unknown;
type Hooks = Map<string, Handler>;

/** Loads the module the way Claude Code does, keeping each registered hook by event name. */
function load(options: Record<string, unknown> = { preserveRecentMessages: 1 }): Hooks {
  const hooks: Hooks = new Map();
  const on = (pattern: string, matcherOrHook: unknown, hook?: unknown) => {
    hooks.set(pattern, (hook ?? matcherOrHook) as Handler);
  };
  register(on as never, options as never);
  return hooks;
}

const BUILT_IN_SUMMARY = { messages: [{ role: 'user', text: 'built-in summary', toolUses: [] }] };

/**
 * A stand-in for the engine: `$.session.compact()` dispatches `session.compact`
 * with trigger `plugin` through the plugin's hook, with core's summary beneath.
 */
function engine(
  hooks: Hooks,
  fetch: ReturnType<typeof jevFetch>,
  env: Record<string, string> = { AI_GATEWAY_API_KEY: 'gw' },
  messages: () => SessionMessage[] = transcript,
) {
  const state = {
    registered: [] as unknown[],
    logs: [] as string[],
    fetches: 0,
    coreRuns: 0,
    installed: undefined as { messages?: unknown[]; skip?: string } | undefined,
  };
  const next = async () => {
    state.coreRuns += 1;
    return BUILT_IN_SUMMARY;
  };
  const compactHook = hooks.get('session.compact') as unknown as (
    $: unknown,
    e: unknown,
    next: () => Promise<unknown>,
  ) => Promise<{ messages?: unknown[]; skip?: string }>;
  const $ = {
    env: { get: async (name: string) => env[name] },
    settings: { read: async () => ({}) },
    ui: { log: (text: string) => state.logs.push(text) },
    http: {
      fetch: async (url: string, init?: { body?: string }) => {
        state.fetches += 1;
        return fetch(url, init);
      },
    },
    command: { register: async (spec: unknown) => state.registered.push(spec) },
    session: {
      compact: async () => {
        const out = await compactHook($, { trigger: 'plugin', messages: messages() }, next);
        state.installed = out;
        return out.messages ? out : { skip: out.skip };
      },
    },
  } as Record<string, unknown> & { session: { compact: () => Promise<unknown> } };
  const compactEvent = (trigger: string) => compactHook($, { trigger, messages: transcript() }, next);
  const runCommand = (args = '') =>
    (hooks.get('command.run') as unknown as ($: unknown, e: unknown) => Promise<{ text: string }>)($, {
      command: COMMAND,
      args,
    });
  return { $, state, compactEvent, runCommand };
}

describe('the /compact-jev plugin', () => {
  it('registers /compact-jev at session start and nothing on turn.complete', async () => {
    const hooks = load();
    expect([...hooks.keys()].sort()).toEqual(['command.run', 'session.compact', 'session.start']);
    const { $, state } = engine(hooks, jevFetch(() => 0.9));
    let nexted = false;
    await (hooks.get('session.start') as unknown as ($: unknown, e: unknown, n: () => unknown) => Promise<unknown>)(
      $,
      {},
      () => (nexted = true),
    );
    expect(state.registered).toEqual([expect.objectContaining({ name: 'compact-jev', argumentHint: '[goal]' })]);
    expect(nexted).toBe(true);
  });

  it('leaves /compact, auto-compaction, precompute and other plugins to Claude Code without calling Jev', async () => {
    const { state, compactEvent } = engine(load(), jevFetch(() => 0.1));
    for (const trigger of ['manual', 'auto', 'precompute', 'plugin']) {
      expect(await compactEvent(trigger)).toBe(BUILT_IN_SUMMARY);
    }
    expect(state.coreRuns).toBe(4);
    expect(state.fetches).toBe(0);
  });

  it('replaces the history with the pruned messages and no summary', async () => {
    const { state, runCommand } = engine(
      load(),
      jevFetch((name) => (name.endsWith('_t2') ? 0.9 : 0.1)),
    );
    const { text } = await runCommand();
    expect(state.fetches).toBe(1);
    expect(state.coreRuns).toBe(0);
    const installed = state.installed?.messages as Array<{ handle?: string; text: string }>;
    expect(installed.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(installed.some((m) => m.text === 'built-in summary')).toBe(false);
    expect(text).toMatch(/^compact-jev: kept 5\/7 messages, no summary \(\d+% reduction; 1 kept, 1 call_dropped/);
    expect(state.logs[0]).toMatch(/^decisions: t1:Read:drop_call/);
  });

  it('applies any reduction, however small (no minimum ratio)', async () => {
    // Only t1 (Read, 1000 chars) is truncated; the 10k-char t2 output stays, so the
    // reduction is well under the 25% the original plugin required.
    const bigOutput = () => {
      const messages = transcript();
      messages[4]!.toolResults![0]!.text = 'x'.repeat(10_000);
      return messages;
    };
    const { state, runCommand } = engine(
      load(),
      jevFetch((name) => (name === 'result_t1' ? 0.1 : 0.9)),
      undefined,
      bigOutput,
    );
    const { text } = await runCommand();
    expect(state.installed?.messages).toBeDefined();
    const [, percentText] = /\((\d+)% reduction/.exec(text) ?? [];
    expect(Number(percentText)).toBeGreaterThan(0);
    expect(Number(percentText)).toBeLessThan(25);
    expect(state.coreRuns).toBe(0);
  });

  it('keeps the conversation as is, never the built-in summary, when there is nothing to remove or Jev fails', async () => {
    const keepAll = engine(load(), jevFetch(() => 0.9));
    expect((await keepAll.runCommand()).text).toMatch(/^compact-jev: nothing to remove, conversation left as is/);
    expect(keepAll.state.installed).toEqual({ skip: 'Jev kept every tool call and result' });

    const failing = engine(load(), async () => ({ status: 429, ok: false, text: 'rate limited' }));
    expect((await failing.runCommand()).text).toBe(
      'compact-jev: conversation left as is (Jev request failed (429): rate limited)',
    );
    expect(failing.state.installed?.skip).toMatch(/429/);

    const keyless = engine(load(), jevFetch(() => 0.1), {});
    expect((await keyless.runCommand()).text).toMatch(/AI_GATEWAY_API_KEY is not configured/);
    for (const run of [keepAll, failing, keyless]) expect(run.state.coreRuns).toBe(0);
  });

  it('sends the text after /compact-jev as the goal, over AI Gateway', async () => {
    const bodies: string[] = [];
    const urls: string[] = [];
    const fetch = jevFetch(() => 0.1, bodies);
    const { runCommand } = engine(load(), async (url, init) => {
      urls.push(url);
      return fetch(url, init);
    });
    await runCommand('  finish the parser fix  ');
    expect(urls).toEqual(['https://ai-gateway.vercel.sh/v1/evaluate']);
    const body = JSON.parse(bodies[0]!);
    expect(body.model).toBe('typesafe-ai/jev');
    expect(body.state.goal).toBe('finish the parser fix');
    expect(Object.values(body.questions).every((q) => (q as { type: string }).type === 'boolean')).toBe(true);
  });

  it('reports whether a result changed anything', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const kept = await compactSession(transcript(), config, jevFetch(() => 0.9));
    const dropped = await compactSession(transcript(), config, jevFetch(() => 0.1));
    expect(changedAnything(kept.result)).toBe(false);
    expect(changedAnything(dropped.result)).toBe(true);
  });
});
