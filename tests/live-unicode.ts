import assert from 'node:assert/strict';
import type { SessionMessage } from 'claude-code';
import { compactSession, type HookFetch } from '../hooks/compact-jev.js';
import { DEFAULT_MODEL, JevClient, JevRequestError } from '../src/index.js';

const apiKey = process.env.AI_GATEWAY_API_KEY;
assert(apiKey, 'Set AI_GATEWAY_API_KEY before running npm run test:live');

const statuses: number[] = [];
const liveFetch: typeof fetch = async (url, init) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  statuses.push(response.status);
  return response;
};
const transport: HookFetch = async (url, init) => {
  const response = await liveFetch(url, init);
  return { status: response.status, ok: response.ok, text: await response.text() };
};

// The old 160-character head split this emoji's surrogate pair.
const output = 'a'.repeat(159) + '😀' + 'b'.repeat(400);
const legacy = output.slice(0, 160) + ' […excerpt…] ' + output.slice(-80);
const client = new JevClient({ apiKey, fetch: liveFetch });
let rejected = false;
for (let attempt = 0; attempt < 4; attempt += 1) {
  try {
    await client.ask({ output: legacy }, {
      q: {
        type: 'boolean',
        instructions: 'Does the output contain useful code?',
        criteria: { true: 'useful code', false: 'filler' },
      },
    });
    assert.fail('The legacy request should fail with invalid Unicode');
  } catch (error) {
    if (error instanceof JevRequestError && error.retryable && attempt < 3) continue;
    assert(error instanceof JevRequestError);
    assert.equal(error.status, 400);
    assert.match(error.responseText, /invalid Unicode/i);
    rejected = true;
    break;
  }
}
assert(rejected, 'The legacy request was not rejected');
console.log(JSON.stringify({ test: 'legacy Unicode rejected', statuses: statuses.splice(0) }));

const messages: SessionMessage[] = [
  {
    role: 'user',
    text: 'Earlier we inspected an unrelated file. Now implement a sum function. Ignore the old filler output. 😀',
    toolUses: [], handle: 'first',
  },
  {
    role: 'assistant', text: 'Inspecting the unrelated old file.', handle: 'call',
    toolUses: [{ tool_use_id: 'x', tool: 'Read', input: { file_path: 'unrelated.txt' }, text: output }],
  },
  {
    role: 'user', text: '', toolUses: [], handle: 'result',
    toolResults: [{ tool_use_id: 'x', text: output, isError: false }],
  },
  {
    role: 'user', text: 'Implement sum(a, b) in sum.ts. The unrelated file is irrelevant. 😀',
    toolUses: [], handle: 'last',
  },
];
const snapshot = JSON.stringify(messages);
const { result, messages: compacted, usedNoTrainingFallback } = await compactSession(
  messages, { apiKey, model: DEFAULT_MODEL, preserveRecentMessages: 1, retries: 3 }, transport,
);
assert(statuses.includes(200), 'The fixed request should receive HTTP 200');
assert.equal(result.stats.requests, 1);
assert.equal(JSON.stringify(messages), snapshot, 'Compaction must not mutate its input');
assert.equal(compacted[0], messages[0]);
assert.equal(compacted.at(-1), messages.at(-1));
assert.deepEqual(compacted.map((message) => message.text).filter(Boolean),
  messages.map((message) => message.text).filter(Boolean), 'Conversation text must stay verbatim');
assert(result.stats.callsDropped + result.stats.resultsDropped > 0, 'Jev should drop stale output');
assert(result.stats.charsAfter < result.stats.charsBefore, 'Compaction should shrink the transcript');
assert(!compacted.some((message) =>
  message.toolUses.some((tool) => tool.text === output) ||
  message.toolResults?.some((tool) => tool.text === output)), 'The full stale output must be removed');
console.log(JSON.stringify({ test: 'fixed hook adapter compacts', statuses, usedNoTrainingFallback, stats: result.stats }));
