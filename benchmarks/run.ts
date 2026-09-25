import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callTarget, compactMessages, collectToolCalls, goalFromMessages, reductionRatio, type Message } from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./sonnet-session.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  source: string;
  date: string;
  messages: Message[];
};
const goal = 'Fix the cart discount rounding failure in src/cart.ts using tests/cart.test.ts.';
const calls = collectToolCalls(fixture.messages, 6);

if (!process.env.AI_GATEWAY_API_KEY) {
  throw new Error('Set AI_GATEWAY_API_KEY to run the live Jev benchmark');
}

const runs = [];
for (let repeat = 1; repeat <= 3; repeat += 1) {
  for (const condition of ['inferred', 'explicit'] as const) {
    let zdrFallback = false;
    const result = await compactMessages(fixture.messages, {
      ...(condition === 'explicit' ? { goal } : {}),
      onZdrFallback: () => { zdrFallback = true; },
    });
    const beforeText = fixture.messages.filter((message) => message.text).map((message) => message.text);
    const afterText = result.messages.filter((message) => message.text).map((message) => message.text);
    if (JSON.stringify(beforeText) !== JSON.stringify(afterText)) {
      throw new Error('Compaction changed user or assistant text');
    }
    runs.push({
      repeat,
      condition,
      reductionPercent: Number((100 * reductionRatio(result)).toFixed(1)),
      ...result.stats,
      zdrFallback,
      decisions: result.decisions.map((decision) => ({
        id: decision.id,
        tool: decision.tool,
        target: callTarget(calls.find((call) => call.id === decision.id)!),
        action: decision.action,
        reason: decision.reason,
        keepCall: Number(decision.keepCall.toFixed(2)),
        keepResult: Number(decision.keepResult.toFixed(2)),
      })),
    });
  }
}

console.log(JSON.stringify({
  fixture: fixture.source,
  date: fixture.date,
  inferredGoal: goalFromMessages(fixture.messages),
  explicitGoal: goal,
  runs,
}, null, 2));
