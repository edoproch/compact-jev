import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
} from 'claude-code';

import { applyDecisions, compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { askJev, DEFAULT_MODEL } from '../src/request.js';
import { collectToolCalls } from '../src/state.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

/** The slash command this plugin serves: `/compact-jev [goal]`. */
export const COMMAND = 'compact-jev';

const HOOK_DEFAULTS = {
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  model: string;
};

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'maxQuestionsPerRequest',
    'truncateHeadChars',
    'outputExcerptChars',
    'retries',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`, posting to AI Gateway. */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  onZdrFallback?: () => void,
): JevAsker {
  return {
    async ask(state, questions) {
      return askJev(fetchFn, { apiKey, model }, state, questions, onZdrFallback);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
  usedNoTrainingFallback: boolean;
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('AI_GATEWAY_API_KEY is not configured');
  let usedNoTrainingFallback = false;
  const asker = jevAsker(fetchFn, config.apiKey, config.model, () => {
    usedNoTrainingFallback = true;
  });
  const result = await compact(messages, asker, config);
  return { result, messages: toSessionMessages(messages, result.messages), usedNoTrainingFallback };
}

/** Whether applying the decisions removed or shortened anything at all. */
export function changedAnything(result: CompactResult): boolean {
  const { stats } = result;
  return stats.messagesAfter !== stats.messagesBefore || stats.charsAfter !== stats.charsBefore;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)${
    stats.retries > 0 ? `, ${stats.retries} retried after a Gateway error` : ''
  }`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('AI_GATEWAY_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['AI_GATEWAY_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** Delay before the deferred compaction starts, and between retries while the session is busy. */
const COMPACT_START_MS = 50;
const COMPACT_RETRY_MS = 500;
const COMPACT_RETRIES = 10;

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Preflight and the compact event must describe the same transcript. */
export function sameTranscript(before: readonly SessionMessage[], now: readonly SessionMessage[]): boolean {
  if (before.length > now.length) return false;
  // Core may append its own /compact command echo before raising the hook.
  if (now.slice(before.length).some((message) =>
    message.toolUses.length > 0 || (message.toolResults?.length ?? 0) > 0 ||
    !/^\s*(?:\/compact(?:\s|$)|<command-name>\/compact<\/command-name>)/.test(message.text)
  )) return false;
  return before.every((message, i) => {
    const current = now[i];
    return current !== undefined && message.role === current.role && message.text === current.text &&
      message.toolUses.length === current.toolUses.length &&
      message.toolUses.every((tool, j) =>
        tool.tool_use_id === current.toolUses[j]?.tool_use_id &&
        tool.tool === current.toolUses[j]?.tool &&
        JSON.stringify(tool.input) === JSON.stringify(current.toolUses[j]?.input) &&
        tool.text === current.toolUses[j]?.text,
      ) &&
      (message.toolResults?.length ?? 0) === (current.toolResults?.length ?? 0) &&
      (message.toolResults ?? []).every((result, j) =>
        result.tool_use_id === current.toolResults?.[j]?.tool_use_id &&
        result.text === current.toolResults[j]?.text &&
        result.isError === current.toolResults[j]?.isError,
      );
  });
}

/** One `/compact-jev` run: the goal typed after the command, and what it ended with. */
type PendingRun = {
  goal?: string;
  outcome?: string;
  handled?: boolean;
  compacting?: boolean;
  prepared?: {
    input: SessionMessage[];
    result: CompactResult;
    usedNoTrainingFallback: boolean;
  };
};

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  // Set only while `/compact-jev` runs its own compaction. Every other
  // compaction (`/compact`, auto-compaction, precompute, other plugins) finds
  // it unset and goes to Claude Code untouched.
  let pending: PendingRun | undefined;

  on('session.start', async ($, event, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description:
          'Compact with Jev: drop or truncate stale tool calls and results, keep everything else verbatim, no summary.',
        argumentHint: '[goal]',
      });
    } catch (error) {
      $.ui.log(`/${COMMAND} not registered (${errorText(error)})`);
    }
    return next(event);
  });

  on('command.run', { command: COMMAND }, async ($, event) => {
    if (pending) return { text: 'already running' };
    const run: PendingRun = {};
    const goal = event.args.trim();
    if (goal) run.goal = goal;
    pending = run;
    // Claude Code only lets a plugin rewrite the history inside a compaction.
    // Finish the expensive Jev work before starting core's /compact: the
    // session.compact hook has a short worker budget, and a killed worker can
    // no longer veto core's built-in summary.
    // Not `$.session.compact()`: the engine skips the calling plugin's own
    // hooks for a compaction its code raised ("re-entry", seen on 2.1.280), so
    // core would summarize. It starts from a timer once the command has
    // returned (refused while the command's turn is held), retrying while busy.
    const attempt = async (left: number): Promise<void> => {
      try {
        if (!run.prepared) {
          const input = await $.session.messages();
          if (input.length >= 4096) {
            throw new Error('conversation exceeds the 4096-message preflight limit');
          }
          const config: HookConfig = { ...configured, apiKey: await getApiKey($, configured) };
          if (run.goal) config.goal = run.goal;
          $.ui.log(`preparing ${input.length} messages with Jev`);
          const { result, usedNoTrainingFallback } = await compactSession(input, config, async (url, init) => {
            const response = await $.http.fetch(url, init);
            return { status: response.status, ok: response.ok, text: response.text };
          });
          run.prepared = { input, result, usedNoTrainingFallback };
        }
        run.compacting = true;
        try {
          await $.command.run({ command: 'compact' });
        } finally {
          run.compacting = false;
        }
        notify(
          $,
          run.outcome ??
            'warning: /compact-jev failed, its Jev hook was never reached and Claude Code summarized instead',
        );
        pending = undefined;
      } catch (error) {
        if (left > 0 && !run.handled && run.prepared) {
          $.clock.after(COMPACT_RETRY_MS, () => void attempt(left - 1));
          return;
        }
        notify($, run.outcome ?? `conversation left as is (${errorText(error)})`);
        pending = undefined;
      }
    };
    $.clock.after(COMPACT_START_MS, () => void attempt(COMPACT_RETRIES));
    return { text: 'compacting with Jev…' };
  });

  // While /compact-jev runs, Claude Code's own summarizer must never run.
  // If it is reached anyway (our session.compact hook skipped, a wrong shape,
  // a failure), it raises the classic PreCompact first: veto it there.
  on('classic.PreCompact', ($, event, next) => {
    if (!pending?.compacting) return next(event);
    $.ui.log('blocked Claude Code\'s built-in compaction during /compact-jev');
    const block = `/${COMMAND} is running; the built-in summary is disabled for it`;
    pending.outcome ??= `conversation left as is (${block})`;
    return { block };
  });

  on('session.compact', async ($, event, next) => {
    const run = pending;
    // Gate on the pending run only: the /compact the command runs arrives with
    // trigger `manual`, as a typed /compact does.
    if (!run?.compacting || event.agentId !== undefined) return next(event);
    run.handled = true;
    $.ui.log(`compacting ${event.messages.length} messages with Jev (trigger ${event.trigger})`);
    try {
      const prepared = run.prepared;
      if (!prepared || !sameTranscript(prepared.input, event.messages)) {
        run.outcome = 'conversation left as is (conversation changed while Jev was preparing)';
        return { skip: run.outcome };
      }
      const { result, usedNoTrainingFallback } = prepared;
      const calls = collectToolCalls(event.messages, resolveOptions(configured).preserveRecentMessages);
      const output = applyDecisions(
        event.messages, result.decisions, calls, resolveOptions(configured).truncateHeadChars,
      );
      const messages = toSessionMessages(event.messages, output);
      const policyNote = usedNoTrainingFallback ? '; ZDR unavailable, no-training fallback used' : '';
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (!changedAnything(result)) {
        run.outcome = `nothing to remove, conversation left as is (${summarize(result)}${policyNote})`;
        return { skip: 'Jev kept every tool call and result' };
      }
      run.outcome = `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)}${policyNote})`;
      return { messages };
    } catch (error) {
      run.outcome = `conversation left as is (${errorText(error)})`;
      return { skip: errorText(error) };
    }
  })
    // A hook that throws or overruns its budget would otherwise be skipped and
    // core would summarize in its place; during a run, answer with a skip.
    .catch((_$, _event, next) => {
      const run = pending;
      if (!run) return undefined;
      run.handled = true;
      run.outcome ??= `conversation left as is (the Jev hook failed: ${next.error.kind}${
        next.error.message ? `, ${next.error.message}` : ''
      })`;
      return { skip: run.outcome };
    });
};

export { resolveOptions };
