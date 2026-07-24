/**
 * Scripted embedding + LLM-label responses. Nothing in this suite touches
 * the real API, mirroring score-worker/anonymize-worker's fixtures.
 */
import type { CallEmbeddingOptions } from "../../_shared/embeddings.ts";
import { EmbeddingError, type EmbeddingFailureType } from "../../_shared/embeddings.ts";
import type { CallOpenAiOptions, OpenAiCallResult } from "../../_shared/openai.ts";

/** A 1536-dim vector built by tiling a short base pattern, so two "similar"
 *  or "distinct" test fixtures are trivial to construct and reason about. */
export function tileVector(base: number[]): number[] {
  const out: number[] = [];
  while (out.length < 1536) out.push(...base);
  return out.slice(0, 1536);
}

export interface ScriptedEmbeddingCall {
  vector?: number[];
  throws?: EmbeddingFailureType;
}

export interface ScriptedEmbedding {
  callEmbeddingImpl: typeof import("../../_shared/embeddings.ts").callEmbedding;
  calls: CallEmbeddingOptions[];
}

/** Maps each call's `input` text to a scripted vector/failure via `byInput`,
 *  falling back to `fallback` (default: an all-zero vector) for unmapped input. */
export function scriptedEmbedding(byInput: Record<string, ScriptedEmbeddingCall>, fallback?: ScriptedEmbeddingCall): ScriptedEmbedding {
  const calls: CallEmbeddingOptions[] = [];
  const callEmbeddingImpl = (async (opts: CallEmbeddingOptions): Promise<number[]> => {
    calls.push(opts);
    const step = byInput[opts.input] ?? fallback ?? { vector: tileVector([0]) };
    if (step.throws) throw new EmbeddingError(step.throws, `scripted failure: ${step.throws}`);
    return step.vector ?? tileVector([0]);
  }) as typeof import("../../_shared/embeddings.ts").callEmbedding;
  return { callEmbeddingImpl, calls };
}

export interface ScriptedLabelOpenAi {
  callOpenAiImpl: typeof import("../../_shared/openai.ts").callOpenAi;
  calls: CallOpenAiOptions[];
}

export interface ScriptedLabelOptions {
  label?: string;
  /** When true, every label call throws instead of resolving — for testing
   * that a label failure marks label_failed rather than faking a title. */
  throws?: boolean;
}

/** Serves a fixed label for every cluster-labeling call, or throws if configured to. */
export function scriptedLabel(opts: ScriptedLabelOptions = {}): ScriptedLabelOpenAi {
  const { label = "Test Cluster Label", throws = false } = opts;
  const calls: CallOpenAiOptions[] = [];
  const callOpenAiImpl = (async (callOpts: CallOpenAiOptions): Promise<OpenAiCallResult> => {
    calls.push(callOpts);
    if (throws) throw new Error("scripted label generation failure");
    const result = { label };
    const raw = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }] };
    return { parsed: result as unknown as Record<string, unknown>, raw };
  }) as typeof import("../../_shared/openai.ts").callOpenAi;
  return { callOpenAiImpl, calls };
}
