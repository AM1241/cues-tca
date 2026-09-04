/**
 * Turning an approved carousel into downloadable PNG slides.
 *
 * Two variants, and the difference is only where the background comes from:
 *
 *   'flat'  — drawn entirely by lib/slides.ts. Free, instant, offline.
 *   'image' — one gpt-image background per slide from the `slide-images` Edge
 *             Function, composited under the same drawn text.
 *
 * In BOTH cases the words are drawn from the approved output by our own code.
 * Nothing ever asks a model to render the copy; see the header of lib/slides.ts
 * for why that distinction is the whole design.
 *
 * This module renders ONE slide at a time and hands back the bytes. It does not
 * download anything and does not loop over the carousel — the caller does both,
 * so that generated slides can be shown on screen and only downloaded once the
 * operator has actually looked at them. The first version downloaded as it
 * generated, which meant paying for an image and finding out whether it was any
 * good afterwards, in the Downloads folder.
 */
import { supabase } from './supabase'
import type { CarouselOutput, CarouselSlide } from '../components/generation'
import { DEFAULT_THEME, renderSlidePng, type SlideVariant } from './slides'

export type SlideQuality = 'low' | 'medium' | 'high'

export class SlideImageError extends Error {
  // Declared and assigned rather than a constructor parameter property: the
  // frontend tsconfig sets `erasableSyntaxOnly`, which rules those out.
  readonly position: number

  constructor(position: number, message: string) {
    super(message)
    this.name = 'SlideImageError'
    this.position = position
  }
}

/** base64 (jpeg from the API) -> a decoded image the canvas can draw. */
async function decodeBase64Image(b64: string, mime: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = `data:${mime};base64,${b64}`
  await img.decode()
  return img
}

/**
 * One background for one slide. Deliberately one request per slide rather than
 * a batch: generation takes tens of seconds, so a whole-carousel call would
 * outlive any sensible function timeout and lose every image when it tripped.
 * See supabase/functions/slide-images/index.ts.
 */
export async function fetchSlideBackground(
  slide: CarouselSlide,
  quality: SlideQuality,
): Promise<HTMLImageElement> {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token

  const { data, error } = await supabase.functions.invoke('slide-images', {
    body: { position: slide.position, heading: slide.heading, body: slide.body, quality },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })

  if (error) {
    throw new SlideImageError(slide.position, error.message || 'the image request failed')
  }
  const payload = data as { ok?: boolean; error?: string; image_b64?: string; output_format?: string }
  if (!payload?.ok || !payload.image_b64) {
    throw new SlideImageError(slide.position, payload?.error || 'no image was returned')
  }

  return await decodeBase64Image(
    payload.image_b64,
    payload.output_format === 'png' ? 'image/png' : 'image/jpeg',
  )
}

export type RenderSlideOptions = {
  variant: SlideVariant
  quality?: SlideQuality
  brand?: string
  /**
   * A background already fetched for this slide. Passing one re-renders without
   * spending anything again — which is what makes "change the wording and see
   * it on the same picture" free, and what a retry of a FAILED slide must not
   * accidentally bypass.
   */
  background?: HTMLImageElement | null
}

/** Renders one slide to PNG bytes, fetching its background first when needed. */
export async function renderOneSlide(
  carousel: CarouselOutput,
  slide: CarouselSlide,
  opts: RenderSlideOptions,
): Promise<{ blob: Blob; background: HTMLImageElement | null }> {
  const total = carousel.slides.length
  let background = opts.background ?? null

  if (opts.variant === 'image' && !background) {
    background = await fetchSlideBackground(slide, opts.quality ?? 'low')
  }

  const blob = await renderSlidePng({
    slide,
    total,
    publicationTitle: carousel.title,
    brand: opts.brand ?? 'CUES',
    variant: opts.variant,
    theme: DEFAULT_THEME,
    background,
  })

  return { blob, background }
}

/**
 * Browsers throttle rapid programmatic downloads, and Chrome prompts once a
 * page starts several in a row. A short gap between them is the difference
 * between seven files arriving and two arriving with a blocked-downloads icon
 * the operator never notices.
 */
export const DOWNLOAD_GAP_MS = 300

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
