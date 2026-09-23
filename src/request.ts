import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

/** Vercel AI Gateway's evaluation endpoint, which serves Jev. */
export const EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';
export const DEFAULT_MODEL = 'typesafe-ai/jev';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? EVALUATE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/** A non-2xx answer from the evaluation API; `status` is the HTTP status. */
export class JevRequestError extends Error {
  constructor(
    readonly status: number,
    text: string,
  ) {
    super(`Jev request failed (${status}): ${text.slice(0, 200)}`);
    this.name = 'JevRequestError';
  }

  /** 429 and 5xx: the same request may well succeed when sent again. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new JevRequestError(status, text);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/** The probability of one `boolean` answer; throws when it is not there. */
export function probabilityAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('probability' in answer) ||
    typeof answer.probability !== 'number' ||
    !Number.isFinite(answer.probability)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.probability;
}
