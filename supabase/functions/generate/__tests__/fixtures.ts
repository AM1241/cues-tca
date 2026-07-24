/**
 * Scripted OpenAI responses for the generate function. Nothing in this suite
 * touches the real API, mirroring cluster/anonymize-worker's fixtures.
 */
import type { CallOpenAiOptions, OpenAiCallResult } from "../../_shared/openai.ts";
import { OpenAiError } from "../../_shared/openai.ts";

export interface ScriptedGenerationOpenAi {
  callOpenAiImpl: typeof import("../../_shared/openai.ts").callOpenAi;
  calls: CallOpenAiOptions[];
}

export interface ScriptedGenerationOptions {
  /** When true, every generation call throws instead of resolving — for
   * testing that an LLM failure never produces a fake successful result. */
  throws?: boolean;
}

const VALID_RESULT = {
  post: {
    headline: "Test Headline",
    text: "Test body text for the generated post.",
    cta: "Learn more.",
    hashtags: ["#Test", "#Editorial"],
  },
  carousel: {
    title: "Test Carousel Title",
    slides: [
      { position: 1, heading: "Opening", body: "Opening slide body." },
      { position: 2, heading: "Context", body: "Context slide body." },
      { position: 3, heading: "Insight", body: "Insight slide body." },
      { position: 4, heading: "Evidence", body: "Evidence slide body." },
      { position: 5, heading: "Closing", body: "Closing slide body." },
    ],
    caption: "Test caption.",
    cta: "Follow for more.",
  },
};

/** Serves a fixed, schema-valid post+carousel result for every generation
 *  call, or throws a scripted OpenAiError if configured to. */
export function scriptedGeneration(opts: ScriptedGenerationOptions = {}): ScriptedGenerationOpenAi {
  const { throws = false } = opts;
  const calls: CallOpenAiOptions[] = [];
  const callOpenAiImpl = (async (callOpts: CallOpenAiOptions): Promise<OpenAiCallResult> => {
    calls.push(callOpts);
    if (throws) throw new OpenAiError("server_error", "scripted generation failure");
    const raw = {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(VALID_RESULT) }] }],
    };
    return { parsed: VALID_RESULT as unknown as Record<string, unknown>, raw };
  }) as typeof import("../../_shared/openai.ts").callOpenAi;
  return { callOpenAiImpl, calls };
}
