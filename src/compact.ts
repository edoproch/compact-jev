import { JevRequestError, probabilityAnswer } from './request.js';
import { callTarget, collectToolCalls, estimateTokens, fitState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 8_000,
  maxRequestTokens: 25_000,
  maxQuestionsPerRequest: 20,
  truncateHeadChars: 300,
  outputExcerptChars: 240,
  retries: 12,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    maxQuestionsPerRequest: Math.max(
      2,
      Math.floor(finite(options.maxQuestionsPerRequest, DEFAULT_OPTIONS.maxQuestionsPerRequest)),
    ),
    outputExcerptChars: Math.max(
      0,
      Math.floor(finite(options.outputExcerptChars, DEFAULT_OPTIONS.outputExcerptChars)),
    ),
    retries: Math.max(0, Math.floor(finite(options.retries, DEFAULT_OPTIONS.retries))),
  };
}

// What each answer means. Jev's docs ask for `criteria` on every boolean
// question and for one judgment per question; without them the answers came
// back flat (every result below 0.25, measured 2026-09-23), with them the
// outputs a task still needs score 0.55–0.9 and the rest under 0.35.
const CALL_CRITERIA = {
  true: 'the fact that this step was taken (with its input) is something the current task builds on',
  false: 'a routine, exploratory or superseded step whose record no longer matters',
};
const RESULT_CRITERIA = {
  true: 'the current task still depends on the exact contents of this output (code about to be changed, an error still being fixed, data still being used) and no later call replaces it',
  false: 'the output is unrelated to the current task, belongs to finished earlier work, or a later call re-read or re-ran the same thing',
};

/** The two `boolean` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  const target = callTarget(call);
  const name = `tool call ${call.id} (${call.tool}${target ? ` ${target}` : ''})`;
  return {
    [`call_${call.id}`]: {
      type: 'boolean',
      instructions: `Is ${name} a step the current task still builds on?`,
      criteria: CALL_CRITERIA,
    },
    [`result_${call.id}`]: {
      type: 'boolean',
      instructions: `Does the current task still need the exact output of ${name}?`,
      criteria: RESULT_CRITERIA,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with a
 * state of `stateTokens`, fit one request, with at most
 * `maxQuestionsPerRequest` questions (two per call) in each.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'> &
    Partial<Pick<ResolvedCompactOptions, 'maxQuestionsPerRequest'>>,
): ToolCall[][] {
  const maxCalls = Math.max(1, Math.floor((options.maxQuestionsPerRequest ?? Infinity) / 2));
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && (currentTokens + tokens > budget || current.length >= maxCalls)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
  retries: number,
  onRetry: () => void,
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  // The Gateway answers 503 at random, more often the larger the request and
  // at some hours far more than others (the same ~11k-token request passed
  // 15% of the time, then 53%, measured 2026-09-23), and spacing attempts does
  // not help, so a retryable failure is sent again at once, up to `retries`
  // times.
  let left = retries;
  const ask = async (): Promise<Awaited<ReturnType<JevAsker['ask']>>> => {
    try {
      return await asker.ask(state, questions);
    } catch (error) {
      if (left <= 0 || !(error instanceof JevRequestError) || !error.retryable) throw error;
      left -= 1;
      onRetry();
      return ask();
    }
  };
  const { answers } = await ask();
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: probabilityAnswer(answers, `call_${call.id}`),
        keepResult: probabilityAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. Each batch of questions gets a state of its own, fitted into
 * `maxStateTokens`: every message's text plus only that batch's calls, each
 * with an excerpt of its output (Jev's docs: a state holding what the
 * question does not need makes its answers worse). Batches run in parallel.
 * Throws when Jev fails or the history cannot be fitted.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  let retries = 0;
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    // Sized against the largest state a batch may get, so every batch fits.
    batches = batchCalls(candidates, resolved.maxStateTokens, resolved);
    const states = batches.map((batch) => fitState(messages, batch, resolved, calls));
    fitted = states.reduce((a, b) => (b.tokens > a.tokens ? b : a));
    const answered = await Promise.all(
      batches.map((batch, i) =>
        askBatch(asker, states[i]!.state, batch, resolved.retries, () => (retries += 1)),
      ),
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const kept = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      retries,
      ms: Date.now() - started,
    },
  };
}
