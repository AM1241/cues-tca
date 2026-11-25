/**
 * Offline tests for _shared/text.ts. No database, no OpenAI.
 *
 * Pins the failure found on production on 2026-11-24: a post with an emoji at
 * the 500-character cut made "Create the carousel" fail with OpenAI's 400
 * "Invalid body: failed to parse JSON value", three times in a row.
 *
 *   deno test supabase/functions/_shared/__tests__/text_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { clipText, requestJson, wellFormed } from "../text.ts";
import { callOpenAi } from "../openai.ts";

/** An escaped surrogate half in serialised JSON that has no partner: what OpenAI refuses. */
const LONE_ESCAPE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;

const SEEDLING = "\u{1F331}"; // 🌱, two UTF-16 code units

Deno.test("the old cut leaves half an emoji, and its JSON carries the lone escape OpenAI refuses", () => {
  const text = "a".repeat(499) + SEEDLING + " more";
  const cut = text.slice(0, 500);
  assert(LONE_ESCAPE.test(JSON.stringify({ input: cut })), "precondition: slice(0, 500) splits the emoji");
});

Deno.test("clipText never splits an emoji", () => {
  const straddling = "a".repeat(499) + SEEDLING + " more";
  assertEquals(clipText(straddling, 500), "a".repeat(499));
  assert(!LONE_ESCAPE.test(JSON.stringify(clipText(straddling, 500))));

  const fits = "a".repeat(498) + SEEDLING + " more";
  assertEquals(clipText(fits, 500), "a".repeat(498) + SEEDLING, "a whole emoji that fits is kept");

  assertEquals(clipText("short " + SEEDLING, 500), "short " + SEEDLING, "short text is untouched");
  assertEquals(clipText("abcdef", 3), "abc");
});

Deno.test("wellFormed replaces lone halves and keeps real emoji", () => {
  assertEquals(wellFormed("x\ud83cy"), "x�y");
  assertEquals(wellFormed("x\udf31y"), "x�y");
  assertEquals(wellFormed("ok " + SEEDLING), "ok " + SEEDLING);
  assertEquals(wellFormed("end\ud83c"), "end�");
});

Deno.test("requestJson writes no lone escape, at any depth", () => {
  const body = requestJson({ input: "x\ud83c", nested: [{ t: "\udf31" }], n: 1, ok: SEEDLING });
  assert(!LONE_ESCAPE.test(body));
  assertEquals(JSON.parse(body), { input: "x�", nested: [{ t: "�" }], n: 1, ok: SEEDLING });
});

Deno.test("callOpenAi sends a well-formed body even when the prompt carries half an emoji", async () => {
  let sent = "";
  const fetchImpl = ((_url: string, init: RequestInit) => {
    sent = String(init.body);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as unknown as typeof fetch;

  await callOpenAi({
    apiKey: "k",
    model: "m",
    input: "evidence " + ("a".repeat(499) + SEEDLING).slice(0, 500),
    jsonSchema: { name: "t", schema: { type: "object" } } as never,
    fetchImpl,
  }).catch(() => undefined); // only the request body matters here

  assert(sent.length > 0, "the request was sent");
  assert(!LONE_ESCAPE.test(sent), "no lone surrogate escape in the request body");
});
