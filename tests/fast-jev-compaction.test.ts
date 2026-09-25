import { describe, expect, it } from 'vitest';
import {
  applyDecisions,
  batchCalls,
  buildJevRequest,
  collectToolCalls,
  compact,
  compactMessages,
  decideCall,
  estimateTokens,
  fitState,
  goalFromMessages,
  JevClient,
  laterNotes,
  outputExcerpt,
  questionsFor,
  JevRequestError,
  parseJevResponse,
  reductionRatio,
  resolveOptions,
  type HistoryToolCall,
  type JevAsker,
  type JevQuestions,
  type Message,
  type ToolCall,
} from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

const fileA = 'export const a = 1;\n'.repeat(50);
const fileB = 'export const b = 2;\n'.repeat(50);

function transcript(): Message[] {
  return [
    message('user', 'Never edit anything under src/generated. Fix the failing test.'),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    message('assistant', 'a.ts looks fine; checking b.ts'),
    call('tool-2', 'Read', { file_path: 'src/b.ts' }, fileB),
    result('tool-2', fileB),
    call('tool-3', 'Bash', { command: 'npm test' }, 'FAIL b.test.ts'),
    result('tool-3', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'The failure is in b.test.ts; fixing now.'),
    message('user', 'go ahead'),
  ];
}

type Seen = { state: unknown; questions: string[] };

function fakeJev(answer: (name: string) => number, seen: Seen[] = []): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      seen.push({ state, questions: Object.keys(questions) });
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'boolean' as const, probability: answer(key) }]),
        ),
      };
    },
  };
}

const fit = {
  maxStateTokens: 25_000,
  preserveRecentMessages: 0,
  goal: 'fix the test',
};

describe('options', () => {
  it('fills in defaults and ignores non-finite values', () => {
    expect(resolveOptions()).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 8_000,
      maxRequestTokens: 25_000,
      maxQuestionsPerRequest: 20,
      truncateHeadChars: 300,
      outputExcerptChars: 240,
      retries: 12,
    });
    expect(resolveOptions({
      keepThreshold: Number.NaN,
      preserveRecentMessages: 2.7,
      truncateHeadChars: -1.2,
    })).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 2,
      truncateHeadChars: 0,
    });
  });
});

describe('token estimate', () => {
  it('charges words, digits and symbols separately and never undercounts JSON badly', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBe(2);
    expect(estimateTokens('internationalization')).toBe(4);
    expect(estimateTokens('12345678')).toBe(4);
    const json = JSON.stringify({ file_path: '/Users/x/src/a.ts', old_string: 'a = 1;', n: 42 });
    expect(estimateTokens(json)).toBeGreaterThanOrEqual(Math.ceil(json.length / 3));
  });
});

describe('tool call collection', () => {
  it('pairs each tool call with its result and pins recent ones', () => {
    const calls = collectToolCalls(transcript(), 3);
    expect(calls.map((c) => [c.id, c.tool, c.callIndex, c.resultIndex, c.pinned])).toEqual([
      ['t1', 'Read', 1, 2, false],
      ['t2', 'Read', 4, 5, false],
      ['t3', 'Bash', 6, 7, true],
    ]);
    expect(calls[2]?.isError).toBe(true);
    expect(calls[0]?.resultChars).toBe(fileA.length);
  });

  it('ignores calls without a result', () => {
    expect(collectToolCalls([message('user', 'hi'), call('x', 'Read', {}, '')], 0)).toHaveLength(0);
  });
});

describe('state fitting', () => {
  it('sends the whole history with tool results replaced by a note', () => {
    const messages = transcript();
    const { state, stage } = fitState(messages, collectToolCalls(messages, 0), fit);
    expect(stage).toBe('full');
    const json = JSON.stringify(state);
    expect(json).not.toContain('export const a = 1;');
    expect(json).toContain('Never edit anything under src/generated');
    expect(json).toContain('go ahead');
    expect(state.history.map((entry) => entry.i)).toEqual([0, 1, 3, 4, 6, 8, 9]);
    expect(state.history[1]?.tool_calls?.[0]).toMatchObject({
      id: 't1',
      tool: 'Read',
      result: `ok, ${fileA.length} chars (omitted)`,
    });
    expect((state.history[4]?.tool_calls?.[0] as HistoryToolCall).result).toMatch(/^error, /);
  });

  it('defaults the goal to the latest user prompts', () => {
    const { state } = fitState(transcript(), [], { ...fit, goal: '' });
    expect(state.goal).toContain('Fix the failing test');
    expect(state.goal).toContain('go ahead');
  });

  it('leaves command echoes, notifications and image placeholders out of the goal', () => {
    const goal = goalFromMessages([
      message('user', '[Image #3] the tests fail on CI'),
      message('user', '<command-name>/compact</command-name> <command-message>compact</command-message>'),
      message('user', '<local-command-stdout>Compacted</local-command-stdout>'),
      message('user', '<task-notification> <task-id>a1</task-id> done </task-notification>'),
      message('user', '[Request interrupted by user]'),
      message('user', '/compact-jev'),
      message('user', 'fix it'),
    ]);
    expect(goal).toBe('the tests fail on CI\nfix it');
  });

  it('shows an excerpt of each output and what later replaced it', () => {
    const messages = [
      message('user', 'start'),
      call('r1', 'Read', { file_path: 'src/a.ts' }, fileA),
      result('r1', fileA),
      call('e1', 'Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'ok'),
      result('e1', 'The file src/a.ts has been updated.'),
      message('assistant', 'done'),
    ];
    const { state } = fitState(messages, collectToolCalls(messages, 0), { ...fit, outputExcerptChars: 90 });
    const read = state.history[1]?.tool_calls?.[0] as HistoryToolCall;
    expect(read.result).toMatch(/^ok, 1000 chars: export const a = 1;/);
    expect(read.result).toContain('chars…]');
    expect(read.later).toBe('changed later by t2 (Edit)');
    expect((state.history[2]?.tool_calls?.[0] as HistoryToolCall).result).toBe(
      'ok, 35 chars: The file src/a.ts has been updated.',
    );
  });

  it('lists only the calls it is given, with later notes from all of them', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const { state } = fitState(messages, [calls[0]!], fit, calls);
    const listed = state.history.flatMap((e) => (e.tool_calls ?? []) as HistoryToolCall[]).map((c) => c.id);
    expect(listed).toEqual(['t1']);
    expect(JSON.stringify(state)).toContain('checking b.ts');
  });

  it('truncates tool inputs before touching message text', () => {
    const messages = [
      message('user', 'start'),
      call('w', 'Write', { file_path: 'x.ts', content: 'x'.repeat(5000) }, 'ok'),
      result('w', 'ok'),
      message('assistant', 'written'),
    ];
    const { state, stage, tokens } = fitState(messages, collectToolCalls(messages, 0), {
      ...fit,
      maxStateTokens: 400,
    });
    expect(stage).toBe('inputs<=200');
    expect(tokens).toBeLessThanOrEqual(400);
    expect(state.history[0]?.text).toBe('start');
    expect((state.history[1]?.tool_calls?.[0] as HistoryToolCall).input.length).toBeLessThanOrEqual(200);
  });

  it('shrinks old tool calls to one line each when nothing else is left to cut', () => {
    const messages = [message('user', 'start')];
    for (let i = 0; i < 40; i += 1) {
      messages.push(call(`c${i}`, 'Read', { file_path: `/repo/src/module-${i}.ts` }, 'x'), result(`c${i}`, 'x'));
    }
    messages.push(message('assistant', 'done'));
    const calls = collectToolCalls(messages, 1);
    const full = fitState(messages, calls, { ...fit, preserveRecentMessages: 1 });
    const compacted = fitState(messages, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.8),
    });
    expect(compacted.stage).toBe('old calls compacted');
    expect(compacted.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.8));
    expect(compacted.tokens).toBeGreaterThanOrEqual(estimateTokens(JSON.stringify(compacted.state)));
    expect(compacted.state.history[1]?.tool_calls?.[0]).toBe(
      't1 Read file_path=/repo/src/module-0.ts → ok 1ch',
    );
    expect(compacted.state.history.at(-1)?.text).toBe('done');

    const merged = fitState(messages, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.45),
    });
    expect(merged.stage).toBe('old calls merged');
    expect(merged.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.45));
    expect(merged.state.history).toHaveLength(3);
    expect(merged.state.history[1]?.tool_calls).toHaveLength(40);
    expect(merged.state.history[1]?.tool_calls?.[39]).toMatch(/^t40 Read /);
    expect(merged.state.history[0]?.text).toBe('start');
    expect(merged.state.history[2]?.text).toBe('done');
  });

  it('abridges long texts oldest-first and collapses old messages last', () => {
    const long = (n: number) => `${n} ` + 'lorem ipsum '.repeat(300);
    const messages = [
      message('user', long(0)),
      message('assistant', long(1)),
      message('user', long(2)),
      message('assistant', long(3)),
      message('user', 'latest'),
    ];
    const abridged = fitState(messages, [], { ...fit, maxStateTokens: 1800, preserveRecentMessages: 1 });
    expect(abridged.stage).toBe('texts abridged');
    expect(abridged.tokens).toBeLessThanOrEqual(1800);
    expect(abridged.state.history[1]?.text).toContain('chars omitted');
    expect(abridged.state.history[0]?.text).toBe(long(0));
    expect(abridged.state.history[4]?.text).toBe('latest');

    const collapsed = fitState(messages, [], { ...fit, maxStateTokens: 420, preserveRecentMessages: 1 });
    expect(collapsed.stage).toBe('old messages collapsed');
    expect(collapsed.tokens).toBeLessThanOrEqual(420);
    expect(collapsed.state.history[1]?.text).toMatch(/^\[… \d+ chars omitted …\]$/);
    expect(collapsed.state.history[0]?.text).toContain('lorem');
    expect(collapsed.state.history[4]?.text).toBe('latest');
  });

  it('throws when the history cannot be fitted', () => {
    const messages = [message('user', 'a'.repeat(2000)), message('assistant', 'b')];
    expect(() => fitState(messages, [], { ...fit, maxStateTokens: 50 })).toThrow(/too large/);
  });
});

describe('questions', () => {
  it('asks one judgment per question, names the call and defines both answers', () => {
    const [read] = collectToolCalls(transcript(), 0);
    const questions = questionsFor(read!);
    expect(Object.keys(questions)).toEqual(['call_t1', 'result_t1']);
    expect(questions.result_t1).toMatchObject({
      type: 'boolean',
      instructions: 'Does the current task still need the exact output of tool call t1 (Read src/a.ts)?',
    });
    for (const q of Object.values(questions)) {
      expect(q.type === 'boolean' && q.criteria?.true && q.criteria.false).toBeTruthy();
    }
  });

  it('excerpts the start and end of an output', () => {
    expect(outputExcerpt('short', 240)).toBe('short');
    expect(outputExcerpt('x'.repeat(1000), 0)).toBe('');
    const excerpt = outputExcerpt(`HEAD${'.'.repeat(1000)}TAIL`, 60);
    expect(excerpt.startsWith('HEAD')).toBe(true);
    expect(excerpt.endsWith('TAIL')).toBe(true);
  });

  it('notes a call run again later', () => {
    const calls = collectToolCalls(transcript().concat(call('b2', 'Bash', { command: 'npm test' }, ''), result('b2', 'ok')), 0);
    expect(laterNotes(calls).get('t3')).toBe('run again later as t4');
    expect(laterNotes(calls).has('t1')).toBe(false);
  });
});

describe('repeated calls', () => {
  it('truncates a kept output that a later identical call keeps too', async () => {
    const messages = [
      message('user', 'start'),
      call('r1', 'Read', { file_path: 'src/a.ts' }, fileA),
      result('r1', fileA),
      call('r2', 'Read', { file_path: 'src/b.ts' }, fileB),
      result('r2', fileB),
      message('assistant', 'reading a.ts again'),
      call('r3', 'Read', { file_path: 'src/a.ts' }, fileA),
      result('r3', fileA),
      message('user', 'go on'),
    ];
    const output = await compact(messages, fakeJev(() => 0.9), { preserveRecentMessages: 2 });
    expect(output.decisions.map((d) => [d.id, d.action, d.reason])).toEqual([
      ['t1', 'drop_result', 'repeated'],
      ['t2', 'keep', 'kept'],
      ['t3', 'keep', 'pinned'],
    ]);
    expect(output.stats.resultsDropped).toBe(1);
  });
});

describe('question batching', () => {
  const calls: ToolCall[] = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i + 1}`,
    tool_use_id: `tool-${i + 1}`,
    tool: 'Read',
    input: {},
    callIndex: i * 2 + 1,
    resultIndex: i * 2 + 2,
    resultChars: 100,
    isError: false,
    pinned: false,
  }));
  const options = { maxRequestTokens: 30_000 };

  it('caps the questions in one request at maxQuestionsPerRequest', () => {
    const batches = batchCalls(calls, 1000, { ...options, maxQuestionsPerRequest: 4 });
    expect(batches.every((batch) => batch.length <= 2)).toBe(true);
    expect(batches.flat()).toHaveLength(calls.length);
  });

  it('puts everything in one request when it fits', () => {
    expect(batchCalls(calls, 1000, options)).toHaveLength(1);
  });

  it('splits questions across requests when the state leaves little room', () => {
    const batches = batchCalls(calls, 29_600, options);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((c) => c.id)).toEqual(calls.map((c) => c.id));
  });

  it('throws when a single question does not fit', () => {
    expect(() => batchCalls(calls, 29_990, options)).toThrow(/no room/);
  });
});

describe('decisions', () => {
  const options = { keepThreshold: 0.5 };
  const unpinned = { id: 't1', tool: 'Read', pinned: false };

  it('keeps, drops the result, or drops the call based on the keep probabilities', () => {
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.7 }, options).action).toBe('keep');
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.2 }, options).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, options).action).toBe('drop_call');
    expect(decideCall({ ...unpinned, pinned: true }, { keepCall: 0, keepResult: 0 }, options)).toMatchObject({
      action: 'keep',
      reason: 'pinned',
    });
  });

  it('removes dropped calls and truncates dropped results', () => {
    const messages = transcript();
    messages[4]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[5]!.toolResults![0]!.text = 'x'.repeat(2000);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, options),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, options),
      decideCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, options),
    ];
    const kept = applyDecisions(messages, decisions, calls, 300);

    expect(kept.map((m) => m.text || m.toolUses[0]?.tool_use_id || m.toolResults?.[0]?.tool_use_id)).toEqual([
      'Never edit anything under src/generated. Fix the failing test.',
      'a.ts looks fine; checking b.ts',
      'tool-2',
      'tool-2',
      'tool-3',
      'tool-3',
      'The failure is in b.test.ts; fixing now.',
      'go ahead',
    ]);
    expect(kept[0]).toBe(messages[0]);
    expect(kept[2]).not.toBe(messages[4]);
    expect(kept[2]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(kept[3]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(kept[2]).not.toBe(messages[4]);
    expect(kept[3]).not.toBe(messages[5]);
    expect(kept[4]).toBe(messages[6]);
    expect(kept[5]?.toolResults?.[0]?.text).toContain('expected 2 to be 3');

    const shortMessages = transcript();
    shortMessages[4]!.toolUses[0]!.text = 'y'.repeat(100);
    shortMessages[5]!.toolResults![0]!.text = 'y'.repeat(100);
    const shortKept = applyDecisions(shortMessages, decisions, calls, 300);
    expect(shortKept[2]).toBe(shortMessages[4]);
    expect(shortKept[3]).toBe(shortMessages[5]);
  });

  it('honours truncateHeadChars, including a zero head', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 })];
    const original = messages[2]!.toolResults![0]!.text;
    const total = original.length;

    const kept = applyDecisions(messages, decisions, calls, 50);
    expect(kept[2]?.toolResults?.[0]?.text).toBe(
      `${original.slice(0, 50)}\n[fast-jev-compaction truncated ${total - 50} chars of this tool result; re-run the tool if needed]`,
    );
    expect(kept[1]?.toolUses[0]?.text).toBe(kept[2]?.toolResults?.[0]?.text);

    const noHead = applyDecisions(messages, decisions, calls, 0);
    expect(noHead[2]?.toolResults?.[0]?.text).toBe(
      `[fast-jev-compaction truncated ${total} chars of this tool result; re-run the tool if needed]`,
    );
  });
});

/** Fails the first `failures` calls with `status`, then answers like `fakeJev`. */
function flakyJev(failures: number, status: number, answer: (name: string) => number) {
  const inner = fakeJev(answer);
  const state = { calls: 0 };
  const asker: JevAsker = {
    async ask(s, questions) {
      state.calls += 1;
      if (state.calls <= failures) throw new JevRequestError(status, 'Service temporarily unavailable');
      return inner.ask(s, questions);
    },
  };
  return { asker, state };
}

describe('retries', () => {
  it('sends a request again after a 503 or 429 and counts the retries', async () => {
    for (const status of [503, 429]) {
      const { asker, state } = flakyJev(2, status, () => 0.1);
      const output = await compact(transcript(), asker, { preserveRecentMessages: 1 });
      expect(state.calls).toBe(3);
      expect(output.stats.retries).toBe(2);
      expect(output.stats.callsDropped).toBeGreaterThan(0);
    }
  });

  it('gives up after `retries` extra attempts, and never retries a 4xx', async () => {
    const down = flakyJev(10, 503, () => 0.1);
    await expect(compact(transcript(), down.asker, { preserveRecentMessages: 1, retries: 2 })).rejects.toThrow(
      'Jev request failed (503)',
    );
    expect(down.state.calls).toBe(3);

    const bad = flakyJev(10, 400, () => 0.1);
    await expect(compact(transcript(), bad.asker, { preserveRecentMessages: 1 })).rejects.toThrow('(400)');
    expect(bad.state.calls).toBe(1);
  });
});

describe('compact', () => {
  it('gives every batch a state with only its own calls and merges the answers', async () => {
    const seen: Seen[] = [];
    const messages = transcript();
    const output = await compact(
      messages,
      fakeJev((name) => (name.startsWith('call_') ? 0.9 : 0.1), seen),
      { preserveRecentMessages: 1, maxQuestionsPerRequest: 2 },
    );

    expect(output.stats.requests).toBe(seen.length);
    expect(seen.length).toBe(3);
    for (const request of seen) {
      const state = request.state as { history: { text: string; tool_calls?: HistoryToolCall[] }[] };
      const listed = state.history.flatMap((e) => e.tool_calls ?? []).map((c) => c.id);
      expect(request.questions).toEqual(listed.flatMap((id) => [`call_${id}`, `result_${id}`]));
      expect(JSON.stringify(state)).toContain('Never edit anything under src/generated');
    }
    expect(seen.flatMap((r) => r.questions).sort()).toEqual([
      'call_t1',
      'call_t2',
      'call_t3',
      'result_t1',
      'result_t2',
      'result_t3',
    ]);
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_result', 'drop_result', 'drop_result']);
    expect(output.messages).toHaveLength(messages.length);
    expect(output.stats).toMatchObject({ resultsDropped: 3, kept: 0, callsDropped: 0, pinned: 0 });
    expect(reductionRatio(output)).toBeGreaterThan(0);
  });

  it('keeps everything without calling Jev when no tool call is a candidate', async () => {
    const seen: Seen[] = [];
    const messages = [message('user', 'hello'), message('assistant', 'hi')];
    const output = await compact(messages, fakeJev(() => 0, seen));
    expect(seen).toHaveLength(0);
    expect(output.stats).toMatchObject({ requests: 0, stateStage: '', calls: 0 });
    expect(output.messages).toEqual(messages);
  });

  it('reports a tiny reduction when Jev wants everything kept', async () => {
    const output = await compact(transcript(), fakeJev(() => 0.95), { preserveRecentMessages: 1 });
    expect(output.decisions.every((d) => d.action === 'keep')).toBe(true);
    expect(reductionRatio(output)).toBe(0);
  });

  it('rejects malformed answers', async () => {
    const broken: JevAsker = {
      // result_t1 uses TypeSafe's native `noul` field, which the Gateway API does not return.
      ask: async () => ({ answers: { call_t1: { probability: 0.5 }, result_t1: { noul: 0.5 } } }) as never,
    };
    await expect(compact(transcript(), broken, { preserveRecentMessages: 1 })).rejects.toThrow(
      /Invalid Jev answer/,
    );
  });
});

describe('HTTP client', () => {
  it('builds an AI Gateway evaluation request', () => {
    const request = buildJevRequest({ apiKey: 'k' }, { a: 1 }, {
      q: { type: 'boolean', instructions: 'x' },
    });
    expect(request.url).toBe('https://ai-gateway.vercel.sh/v1/evaluate');
    expect(request.headers.authorization).toBe('Bearer k');
    expect(JSON.parse(request.body)).toEqual({
      model: 'typesafe-ai/jev',
      state: { a: 1 },
      questions: { q: { type: 'boolean', instructions: 'x' } },
      providerOptions: { gateway: { zeroDataRetention: true, disallowPromptTraining: true } },
    });
    const fallback = buildJevRequest({ apiKey: 'k', zeroDataRetention: false }, 'state', {});
    expect(JSON.parse(fallback.body).providerOptions).toEqual({
      gateway: { disallowPromptTraining: true },
    });
  });

  it('rejects failed and malformed responses', () => {
    expect(() => parseJevResponse(500, false, 'boom')).toThrow(/500/);
    expect(() => parseJevResponse(200, true, 'not json')).toThrow(/malformed/);
    expect(() => parseJevResponse(200, true, '{}')).toThrow(/missing answers/);
    expect(parseJevResponse(200, true, '{"answers":{}}')).toEqual({ answers: {} });
  });

  it('asks over fetch and refuses to run without a key', async () => {
    const bodies: string[] = [];
    const client = new JevClient({
      apiKey: 'k',
      model: 'jev-test',
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ answers: { q: { type: 'boolean', probability: 0.4 } } }), { status: 200 });
      }) as typeof fetch,
    });
    const response = await client.ask('state', { q: { type: 'boolean', instructions: 'x' } });
    expect(response.answers.q).toEqual({ type: 'boolean', probability: 0.4 });
    expect(JSON.parse(bodies[0]!).model).toBe('jev-test');

    const keyless = new JevClient({ apiKey: '' });
    await expect(keyless.ask('s', {})).rejects.toThrow(/AI_GATEWAY_API_KEY/);
    await expect(
      compactMessages(transcript(), { apiKey: '', preserveRecentMessages: 1 }),
    ).rejects.toThrow(/AI_GATEWAY_API_KEY/);
  });

  it('falls back to no-training only after a ZDR-specific rejection', async () => {
    const bodies: Record<string, unknown>[] = [];
    let fallbacks = 0;
    const client = new JevClient({
      apiKey: 'k',
      onZdrFallback: () => { fallbacks += 1; },
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (bodies.length === 1) {
          return new Response(JSON.stringify({ type: 'no_providers_available', error: 'No ZDR providers available' }), { status: 400 });
        }
        return new Response(JSON.stringify({ answers: {} }), { status: 200 });
      }) as typeof fetch,
    });
    await expect(client.ask('state', {})).resolves.toEqual({ answers: {} });
    expect(fallbacks).toBe(1);
    expect(bodies.map((body) => body.providerOptions)).toEqual([
      { gateway: { zeroDataRetention: true, disallowPromptTraining: true } },
      { gateway: { disallowPromptTraining: true } },
    ]);
  });

  it('does not weaken privacy for unrelated errors or a failed fallback', async () => {
    for (const error of [
      { status: 401, text: 'invalid API key' },
      { status: 400, text: 'invalid request' },
      { status: 503, text: 'ZDR provider unavailable' },
    ]) {
      let calls = 0;
      const client = new JevClient({
        apiKey: 'k',
        fetch: (async () => {
          calls += 1;
          return new Response(error.text, { status: error.status });
        }) as typeof fetch,
      });
      await expect(client.ask('state', {})).rejects.toThrow(/Jev request failed/);
      expect(calls).toBe(1);
    }

    let calls = 0;
    const client = new JevClient({
      apiKey: 'k',
      fetch: (async () => {
        calls += 1;
        return new Response(calls === 1 ? 'ZDR requires Pro' : 'No no-training providers available', {
          status: 403,
        });
      }) as typeof fetch,
    });
    await expect(client.ask('state', {})).rejects.toThrow(/No no-training providers available/);
    expect(calls).toBe(2);
  });
});
