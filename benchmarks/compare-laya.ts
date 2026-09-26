/** Compare local Laya and live Jev on the same compaction core and transcript. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  compact,
  compactMessages,
  goalFromMessages,
  reductionRatio,
  type JevAsker,
  type JevQuestions,
  type JevState,
  type Message,
} from '../src/index.js';

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./sonnet-session.json', import.meta.url)), 'utf8')) as {
  source: string;
  messages: Message[];
};
const goals = {
  en: 'Fix the cart discount rounding failure in src/cart.ts using tests/cart.test.ts.',
  it: 'Correggi il problema di arrotondamento dello sconto nel carrello in src/cart.ts usando tests/cart.test.ts.',
};
const italianPrompts = new Map([
  [0, 'Leggi docs/billing.md, src/billing.ts, src/tax.ts e docs/release.md, poi spiega come si calcolano i totali delle fatture. Non modificare i file.'],
  [11, 'Ora indaga il problema di arrotondamento dello sconto nel carrello. Leggi src/cart.ts e tests/cart.test.ts, verifica se la logica delle imposte è rilevante e spiega la correzione minima. Non modificare i file.'],
  [18, 'Prepara una bozza di note di rilascio che copra il calcolo delle fatture e il bug di arrotondamento del carrello. Rileggi docs/release.md e docs/billing.md e controlla src/cart.ts per descrivere correttamente il comportamento. Non modificare i file.'],
  [26, 'Per una checklist di rilascio, usa Glob per elencare i file sorgente e la documentazione, Grep per trovare i riferimenti all’arrotondamento in src e Bash per eseguire wc -l sui file sorgente, di test e di documentazione. Non modificare nulla; riferisci cosa hai trovato.'],
]);

function transcript(language: 'en' | 'it'): Message[] {
  const messages = structuredClone(fixture.messages);
  if (language === 'it') {
    for (const [index, prompt] of italianPrompts) messages[index]!.text = prompt;
  }
  return messages;
}

const python = process.env.LAYA_PYTHON;
if (!python) throw new Error('Set LAYA_PYTHON to a Python environment with laya==0.3.20');
const checkpoint = process.env.LAYA_CHECKPOINT ?? 'multilingual';
const device = process.env.LAYA_DEVICE ?? 'mps';
const repeats = Number(process.env.REPEATS ?? '1');
if (repeats !== 1) throw new Error('Run each repeat in a fresh process to avoid MPS memory accumulation');
const requestTimeoutMs = Number(process.env.LAYA_REQUEST_TIMEOUT_MS ?? '120000');
const selectedLanguage = process.env.BENCH_LANGUAGE ?? 'en';
const selectedCondition = process.env.BENCH_CONDITION ?? 'explicit';
if (!['en', 'it'].includes(selectedLanguage) || !['inferred', 'explicit'].includes(selectedCondition)) {
  throw new Error('BENCH_LANGUAGE must be en or it; BENCH_CONDITION must be inferred or explicit');
}
const worker = spawn(python, [fileURLToPath(new URL('./laya-worker.py', import.meta.url)), checkpoint, device], {
  env: { ...process.env, USE_TF: '0' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let nextId = 0;
let readyResolve!: (value: number) => void;
let readyReject!: (error: Error) => void;
const ready = new Promise<number>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
createInterface({ input: worker.stdout }).on('line', (line) => {
  let message: any;
  try { message = JSON.parse(line); } catch (error) { readyReject(error as Error); return; }
  if (message.ready) { readyResolve(message.loadMs); return; }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error));
  else request.resolve(message);
});
worker.on('error', readyReject);
worker.on('exit', (code) => {
  const error = new Error(`Laya worker exited with code ${code}`);
  readyReject(error);
  for (const request of pending.values()) request.reject(error);
  pending.clear();
});

const requestMetrics: Array<{ inferMs: number; usage: unknown; peakRssBytes: number }> = [];
const asker: JevAsker = {
  async ask(state: JevState, questions: JevQuestions) {
    const id = ++nextId;
    const response = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Laya request exceeded ${requestTimeoutMs} ms`));
      }, requestTimeoutMs);
      pending.set(id, {
        resolve(value) { clearTimeout(timeout); resolve(value); },
        reject(error) { clearTimeout(timeout); reject(error); },
      });
    });
    worker.stdin.write(`${JSON.stringify({ id, state, questions })}\n`);
    const result = await response;
    requestMetrics.push({ inferMs: result.inferMs, usage: result.usage, peakRssBytes: result.peakRssBytes });
    return { answers: result.answers };
  },
};

function summary(result: Awaited<ReturnType<typeof compact>>) {
  return {
    reductionPercent: Number((100 * reductionRatio(result)).toFixed(1)),
    ...result.stats,
    decisions: result.decisions.map(({ id, tool, action, reason, keepCall, keepResult }) => ({
      id, tool, action, reason,
      keepCall: Number(keepCall.toFixed(3)),
      keepResult: Number(keepResult.toFixed(3)),
    })),
  };
}

try {
  const loadMs = await ready;
  const runs = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const language of ['en', 'it'] as const) {
      if (language !== selectedLanguage) continue;
      for (const condition of ['inferred', 'explicit'] as const) {
        if (condition !== selectedCondition) continue;
        const messages = transcript(language);
        const options = condition === 'explicit' ? { goal: goals[language] } : {};
        const before = messages.filter((message) => message.text).map((message) => message.text);
        requestMetrics.length = 0;
        const layaOptions = {
          ...options,
          ...(process.env.LAYA_MAX_STATE_TOKENS ? { maxStateTokens: Number(process.env.LAYA_MAX_STATE_TOKENS) } : {}),
          ...(process.env.LAYA_MAX_QUESTIONS ? { maxQuestionsPerRequest: Number(process.env.LAYA_MAX_QUESTIONS) } : {}),
        };
        const laya = await compact(messages, asker, layaOptions);
        const after = laya.messages.filter((message) => message.text).map((message) => message.text);
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Laya changed user/assistant text');
        const row: Record<string, unknown> = {
          repeat, language, condition, inferredGoal: condition === 'inferred' ? goalFromMessages(messages) : undefined,
          laya: { options: layaOptions, ...summary(laya), requests: [...requestMetrics] },
        };
        if (process.env.AI_GATEWAY_API_KEY) {
          const jev = await compactMessages(messages, options);
          row.jev = summary(jev);
          row.actionAgreement = laya.decisions.filter((decision, index) => decision.action === jev.decisions[index]?.action).length;
        }
        runs.push(row);
        process.stderr.write(`Completed ${language}/${condition} repeat ${repeat}\n`);
      }
    }
  }
  console.log(JSON.stringify({
    fixture: fixture.source, checkpoint, device,
    questionType: process.env.LAYA_QUESTION_TYPE ?? 'noul',
    loadMs, repeats, runs,
  }, null, 2));
} finally {
  worker.stdin.end();
  worker.kill();
}
