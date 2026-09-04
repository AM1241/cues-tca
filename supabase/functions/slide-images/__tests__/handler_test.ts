/**
 * Handler tests for slide-images. The provider is always a scripted fetch —
 * nothing here reaches OpenAI, and OPENAI_API_KEY is set to a dummy value so a
 * real call would fail loudly rather than quietly succeed.
 *
 * The internal-secret auth path is used throughout: it needs no Auth user and
 * no database, which keeps these tests pure. The editor path is exercised by
 * the shared authenticate() and by the suites that already cover it.
 *
 * Run: deno test --allow-env slide-images/__tests__/handler_test.ts
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import { handleSlideImages, parseSlideRequest } from "../index.ts";
import { OpenAiError } from "../../_shared/openai.ts";
import { callOpenAiImage } from "../../_shared/openai_images.ts";
import { RequestError } from "../../_shared/errors.ts";

const SECRET = "test-internal-secret-slide-images";
Deno.env.set("INGEST_INTERNAL_SECRET", SECRET);
Deno.env.set("OPENAI_API_KEY", "dummy-not-used");

/** A db that answers only the one configurations read the handler makes. */
function fakeDb(domain: string | null = "the food and agriculture sector"): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { editorial_domain: domain }, error: null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

function request(body: unknown, apikey = SECRET): Request {
  return new Request("https://local.test/slide-images", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey },
    body: JSON.stringify(body),
  });
}

const VALID = { position: 3, heading: "Sustainability needs solutions", body: "Circular economy and bioplastics." };

/** Records what the handler asked the provider for, and returns a fixed image. */
function scriptedImage(b64 = "QUJD") {
  const calls: { prompt: string; model: string; size: string; quality: string; outputFormat?: string }[] = [];
  const impl = ((opts: Parameters<typeof callOpenAiImage>[0]) => {
    calls.push({
      prompt: opts.prompt,
      model: opts.model,
      size: opts.size,
      quality: String(opts.quality),
      outputFormat: opts.outputFormat,
    });
    return Promise.resolve({ b64, revisedPrompt: "a dark field at dusk", raw: { created: 1, data: [{}] } });
  }) as typeof callOpenAiImage;
  return { impl, calls };
}

// ===========================================================================
// AUTHORISATION
// ===========================================================================
Deno.test("[slide-images] no credentials -> 401, and the provider is never called", async () => {
  const { impl, calls } = scriptedImage();
  const res = await handleSlideImages(
    new Request("https://local.test/slide-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    }),
    { db: fakeDb(), callOpenAiImageImpl: impl },
  );
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0, "an unauthenticated request must never spend provider quota");
});

Deno.test("[slide-images] a wrong internal secret -> 401", async () => {
  const { impl, calls } = scriptedImage();
  const res = await handleSlideImages(request(VALID, "not-the-secret"), {
    db: fakeDb(),
    callOpenAiImageImpl: impl,
  });
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("[slide-images] GET is rejected", async () => {
  const res = await handleSlideImages(
    new Request("https://local.test/slide-images", { method: "GET", headers: { apikey: SECRET } }),
    { db: fakeDb() },
  );
  assertEquals(res.status, 405);
});

// ===========================================================================
// REQUEST VALIDATION — each of these must cost nothing
// ===========================================================================
Deno.test("[slide-images] invalid input is rejected before the provider is called", async () => {
  const cases: [string, unknown][] = [
    ["position missing", { heading: "H", body: "B" }],
    ["position not an integer", { position: 1.5, heading: "H", body: "B" }],
    ["position out of range", { position: 0, heading: "H", body: "B" }],
    ["heading empty", { position: 1, heading: "   ", body: "B" }],
    ["body missing", { position: 1, heading: "H" }],
    ["unknown quality", { position: 1, heading: "H", body: "B", quality: "ultra" }],
  ];

  for (const [name, body] of cases) {
    const { impl, calls } = scriptedImage();
    const res = await handleSlideImages(request(body), { db: fakeDb(), callOpenAiImageImpl: impl });
    assertEquals(res.status, 400, name);
    assertEquals(calls.length, 0, `${name}: must not reach the provider`);
  }
});

Deno.test("[slide-images] parseSlideRequest defaults quality to medium", () => {
  const { quality } = parseSlideRequest({ position: 2, heading: "H", body: "B" });
  assertEquals(quality, "medium");
});

Deno.test("[slide-images] parseSlideRequest accepts each documented quality", () => {
  for (const q of ["low", "medium", "high"]) {
    assertEquals(parseSlideRequest({ position: 2, heading: "H", body: "B", quality: q }).quality, q);
  }
});

Deno.test("[slide-images] an over-long field is refused rather than sent to a paid API", () => {
  let threw: RequestError | null = null;
  try {
    parseSlideRequest({ position: 1, heading: "H".repeat(2_001), body: "B" });
  } catch (e) {
    threw = e as RequestError;
  }
  assert(threw, "an oversized heading must be rejected");
  assertEquals(threw!.status, 400);
});

// ===========================================================================
// HAPPY PATH
// ===========================================================================
Deno.test("[slide-images] returns the image and the provenance the caller needs", async () => {
  const { impl, calls } = scriptedImage("aW1hZ2VieXRlcw==");
  const res = await handleSlideImages(request(VALID), { db: fakeDb(), callOpenAiImageImpl: impl });
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.position, 3);
  assertEquals(body.image_b64, "aW1hZ2VieXRlcw==");
  assertEquals(body.revised_prompt, "a dark field at dusk");
  assertEquals(body.output_format, "jpeg");
  assert(body.model.startsWith("gpt-image-"), `expected a pinned image model, got ${body.model}`);
  assert(body.prompt_version, "the prompt version must be reported so a change is traceable");

  assertEquals(calls.length, 1);
  assertEquals(calls[0].size, "1024x1024");
  assertEquals(calls[0].quality, "medium");
  assertEquals(calls[0].outputFormat, "jpeg", "a JPEG background keeps the response payload small");
});

Deno.test("[slide-images] the prompt carries the slide and the configured domain", async () => {
  const { impl, calls } = scriptedImage();
  await handleSlideImages(request(VALID), { db: fakeDb("marine logistics"), callOpenAiImageImpl: impl });
  assertStringIncludes(calls[0].prompt, "Sustainability needs solutions");
  assertStringIncludes(calls[0].prompt, "marine logistics");
});

Deno.test("[slide-images] the domain comes from config, never from the request body", async () => {
  const { impl, calls } = scriptedImage();
  await handleSlideImages(
    request({ ...VALID, domain: "attacker-supplied domain" }),
    { db: fakeDb("the food and agriculture sector"), callOpenAiImageImpl: impl },
  );
  assert(
    !calls[0].prompt.includes("attacker-supplied domain"),
    "a caller must not be able to redirect the imagery away from the configured scope",
  );
  assertStringIncludes(calls[0].prompt, "the food and agriculture sector");
});

// ===========================================================================
// FAILURE HANDLING — no silent fallback, and the reason survives
// ===========================================================================
Deno.test("[slide-images] a moderation refusal is 422, distinct from a transport failure", async () => {
  const impl = (() => Promise.reject(
    new OpenAiError("content_filter", "Image generation failed (400): rejected by the safety system"),
  )) as typeof callOpenAiImage;

  const res = await handleSlideImages(request(VALID), { db: fakeDb(), callOpenAiImageImpl: impl });
  assertEquals(res.status, 422, "a refusal is about this slide's wording, not a retryable outage");
  const body = await res.json();
  assertEquals(body.ok, false);
  assertStringIncludes(body.error, "Slide 3");
});

Deno.test("[slide-images] a provider outage is 502 and names the slide that failed", async () => {
  const impl = (() => Promise.reject(
    new OpenAiError("server_error", "Image generation failed (503): upstream unavailable", 503),
  )) as typeof callOpenAiImage;

  const res = await handleSlideImages(request({ ...VALID, position: 5 }), {
    db: fakeDb(),
    callOpenAiImageImpl: impl,
  });
  assertEquals(res.status, 502);
  assertStringIncludes((await res.json()).error, "Slide 5");
});

Deno.test("[slide-images] a missing OPENAI_API_KEY fails before the provider is called", async () => {
  const saved = Deno.env.get("OPENAI_API_KEY")!;
  Deno.env.delete("OPENAI_API_KEY");
  try {
    const { impl, calls } = scriptedImage();
    const res = await handleSlideImages(request(VALID), { db: fakeDb(), callOpenAiImageImpl: impl });
    assertEquals(res.status, 500);
    assertEquals(calls.length, 0);
  } finally {
    Deno.env.set("OPENAI_API_KEY", saved);
  }
});
