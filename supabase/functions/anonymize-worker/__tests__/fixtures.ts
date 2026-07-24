/**
 * Scripted OpenAI responses for the entity-extraction call. Nothing in this
 * suite touches the real API, mirroring score-worker/__tests__/fixtures.ts.
 */
import type { CallOpenAiOptions, OpenAiCallResult } from "../../_shared/openai.ts";
import { OpenAiError, type OpenAiFailureType } from "../../_shared/openai.ts";

export interface ScriptedCall {
  /** Resolve with these extracted entity names. */
  entities?: string[];
  /** Or throw this failure type instead. */
  throws?: OpenAiFailureType;
  httpStatus?: number;
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

    if (step.throws) {
      throw new OpenAiError(step.throws, `scripted failure: ${step.throws}`, step.httpStatus);
    }
    const result = { entities: step.entities ?? [] };
    const raw = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }] };
    return { parsed: result as unknown as Record<string, unknown>, raw };
  }) as typeof import("../../_shared/openai.ts").callOpenAi;

  return { callOpenAiImpl, calls };
}
