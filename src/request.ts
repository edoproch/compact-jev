import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

/** Vercel AI Gateway's evaluation endpoint, which serves Jev. */
export const EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';
export const DEFAULT_MODEL = 'typesafe-ai/jev';

/** Preferred policy: require both ZDR and no prompt training. */
export const PROVIDER_OPTIONS = {
  gateway: { zeroDataRetention: true, disallowPromptTraining: true },
} as const;

/** Used only after the Gateway explicitly rejects the ZDR requirement. */
export const NO_TRAINING_PROVIDER_OPTIONS = {
  gateway: { disallowPromptTraining: true },
} as const;

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
    zeroDataRetention?: boolean;
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
      providerOptions:
        params.zeroDataRetention === false ? NO_TRAINING_PROVIDER_OPTIONS : PROVIDER_OPTIONS,
    }),
  };
}

/** A non-2xx answer from the evaluation API; `status` is the HTTP status. */
export class JevRequestError extends Error {
  constructor(
    readonly status: number,
    readonly responseText: string,
  ) {
    super(`Jev request failed (${status}): ${responseText.slice(0, 200)}`);
    this.name = 'JevRequestError';
  }

  /** 429 and 5xx: the same request may well succeed when sent again. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** A ZDR-specific rejection, including a Hobby plan restriction or no eligible provider. */
export function isZdrUnavailable(error: unknown): error is JevRequestError {
  return (
    error instanceof JevRequestError &&
    [400, 402, 403].includes(error.status) &&
    /\bZDR\b|ZdrUnauthorizedError|zero[\s_-]*data[\s_-]*retention/i.test(error.responseText)
  );
}

export type JevFetchResponse = { status: number; ok: boolean; text: string };
export type JevFetch = (
  url: string,
  init: Pick<JevRequest, 'method' | 'headers' | 'body'>,
) => Promise<JevFetchResponse>;

/** Try ZDR first; downgrade only a ZDR-specific rejection, keeping no-training mandatory. */
export async function askJev(
  fetchFn: JevFetch,
  params: { apiKey: string; model?: string; baseUrl?: string },
  state: JevState,
  questions: JevQuestions,
  onZdrFallback?: () => void,
): Promise<JevResponse> {
  const send = async (zeroDataRetention: boolean): Promise<JevResponse> => {
    const request = buildJevRequest({ ...params, zeroDataRetention }, state, questions);
    const response = await fetchFn(request.url, request);
    return parseJevResponse(response.status, response.ok, response.text);
  };
  try {
    return await send(true);
  } catch (error) {
    if (!isZdrUnavailable(error)) throw error;
    onZdrFallback?.();
    return send(false);
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
