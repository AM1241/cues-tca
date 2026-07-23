/**
 * Scripted OpenAI responses. Nothing in the test suite touches the real API —
 * every call is served from here, mirroring ingest/__tests__/fixtures.ts.
 */
import type { CallOpenAiOptions, OpenAiCallResult } from "../../_shared/openai.ts";
import { OpenAiError, type OpenAiFailureType } from "../../_shared/openai.ts";

export interface ScriptedCall {
  /** Resolve with a parsed result. */
  result?: { theme_scores: Record<string, number>; reason: string };
  /** Or throw this failure type instead. */
  throws?: OpenAiFailureType;
  /** Never settle. */
  hang?: boolean;
}

export interface ScriptedOpenAi {
  callOpenAiImpl: typeof import("../../_shared/openai.ts").callOpenAi;
  calls: CallOpenAiOptions[];
}

/** Serves `script` in order; the last entry repeats once exhausted. */
export function scriptedOpenAi(script: ScriptedCall[]): ScriptedOpenAi {
  const calls: CallOpenAiOptions[] = [];
  let i = 0;

  const callOpenAiImpl = (async (opts: CallOpenAiOptions): Promise<OpenAiCallResult> => {
    calls.push(opts);
    const step = script[Math.min(i, script.length - 1)];
    i++;

    if (step.hang) {
      return new Promise(() => {});
    }
    if (step.throws) {
      throw new OpenAiError(step.throws, `scripted failure: ${step.throws}`);
    }
    const raw = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(step.result) }] }] };
    return { parsed: step.result as unknown as Record<string, unknown>, raw };
  }) as typeof import("../../_shared/openai.ts").callOpenAi;

  return { callOpenAiImpl, calls };
}

export function themeScores(overrides: Partial<Record<string, number>> = {}): Record<string, number> {
  return {
    sustainability: 10, innovation: 10, talent_development: 10,
    food_safety: 10, supply_chain: 10, tradition: 10,
    ...overrides,
  };
}
