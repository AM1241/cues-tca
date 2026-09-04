/**
 * Carousel slides as downloadable PNG images.
 *
 * WHY THE TEXT IS DRAWN, NOT GENERATED
 * ------------------------------------
 * The obvious reading of "make the slides into images with GPT" is to hand the
 * slide's words to an image model and let it render them. That is the one thing
 * this module deliberately does not do. Every image model still garbles exact
 * multi-line text, so an editor would approve wording in Review and publish a
 * picture containing slightly different wording — silently breaking the promise
 * the whole review layer exists to make (0017: the model's words and the
 * editor's edit stay separately answerable, forever). So the text is always
 * drawn by this code, from the approved output, character for character.
 *
 * The AI's role, in the 'image' variant, is the BACKGROUND only — an abstract
 * backdrop with no words in it. A scrim is composited between the background
 * and the text so contrast is guaranteed no matter what the model returns; the
 * slide never depends on the image being light or dark in the right places.
 *
 * WHY THE BROWSER
 * ---------------
 * Same reasoning as lib/docx.ts: the client already holds the text and renders
 * it in the preview pane, so a round trip would buy a bucket, a storage policy,
 * signed URLs and a cleanup job to move bytes that are already here. Canvas is
 * built in — no dependency at all for the flat variant.
 *
 * This module has no imports on purpose: it is compiled standalone to produce
 * the sample images used to choose a design, so what is reviewed is byte-for-
 * byte what ships rather than a mock-up that can drift from it.
 */

/** LinkedIn renders carousel/document pages square; 1080 is the standard upload edge. */
export const SLIDE_SIZE = 1080
const MARGIN = 88

/**
 * A websafe stack rather than a webfont: canvas draws with whatever is actually
 * loaded at the moment toBlob runs, and a webfont that has not finished loading
 * silently falls back mid-render — producing one slide in Inter and the next in
 * Arial. A stack that is always resolvable is worth more here than the nicer
 * first choice.
 */
const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

export type SlideVariant = 'flat' | 'image'

export type SlideInput = {
  position: number
  heading: string
  body: string
}

export type SlideTheme = {
  /** Page background for the flat variant, and the scrim's base for the image one. */
  background: string
  /** Secondary background, used for the opening slide and the flat gradient. */
  backgroundAlt: string
  accent: string
  text: string
  /** Body copy. Deliberately brighter than `muted`: this is what gets read. */
  body: string
  /** Chrome only — the counter and the footer, which must recede. */
  muted: string
}

export const DEFAULT_THEME: SlideTheme = {
  background: '#0B1220',
  backgroundAlt: '#131F35',
  accent: '#34D399',
  text: '#F8FAFC',
  body: '#CBD5E1',
  muted: '#8CA0B8',
}

export type RenderOptions = {
  slide: SlideInput
  /** Total slides, for the "03 / 07" counter — a reader wants to know how long this is. */
  total: number
  /** The carousel's own title, shown as a footer on every slide but the first. */
  publicationTitle: string
  /** Small wordmark, top-left. */
  brand?: string
  variant?: SlideVariant
  theme?: SlideTheme
  /**
   * Decoded background for the 'image' variant. Passing null with
   * variant:'image' draws the flat background instead of failing — a missing
   * background is a degraded slide, not a broken export.
   */
  background?: CanvasImageSource | null
}

// =============================================================================
// Text layout
// =============================================================================

/**
 * Greedy wrap on real measured widths rather than a character-count estimate:
 * the difference shows up immediately on headings, where one word spilling past
 * the margin is the whole slide's first impression.
 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  // Respect newlines the editor actually typed; wrap within each of them.
  for (const paragraph of text.split(/\n+/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) continue
    let line = words[0]
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`
      if (ctx.measureText(candidate).width <= maxWidth) line = candidate
      else {
        lines.push(line)
        line = words[i]
      }
    }
    lines.push(line)
  }
  return lines
}

type Block = { lines: string[]; fontSize: number; lineHeight: number }

/**
 * Shrinks until the wrapped text fits the height it was given. A slide with an
 * unusually long heading is a real case — the model is told to be short, not
 * guaranteed to be — and the alternative to shrinking is text running off the
 * bottom of an image nobody re-reads before posting.
 */
function fitBlock(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  startSize: number,
  weight: string,
  minSize: number,
  lineHeightRatio: number,
): Block {
  let fontSize = startSize
  for (;;) {
    ctx.font = `${weight} ${fontSize}px ${FONT_STACK}`
    const lines = wrapText(ctx, text, maxWidth)
    const lineHeight = Math.round(fontSize * lineHeightRatio)
    if (lines.length * lineHeight <= maxHeight || fontSize <= minSize) {
      return { lines, fontSize, lineHeight }
    }
    fontSize -= 2
  }
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  block: Block,
  x: number,
  top: number,
  color: string,
  weight: string,
): number {
  ctx.font = `${weight} ${block.fontSize}px ${FONT_STACK}`
  ctx.fillStyle = color
  ctx.textBaseline = 'top'
  let y = top
  for (const line of block.lines) {
    ctx.fillText(line, x, y)
    y += block.lineHeight
  }
  return y
}

// =============================================================================
// Backgrounds
// =============================================================================

function drawFlatBackground(ctx: CanvasRenderingContext2D, theme: SlideTheme, opening: boolean) {
  const g = ctx.createLinearGradient(0, 0, SLIDE_SIZE, SLIDE_SIZE)
  g.addColorStop(0, opening ? theme.backgroundAlt : theme.background)
  g.addColorStop(1, opening ? theme.background : theme.backgroundAlt)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, SLIDE_SIZE, SLIDE_SIZE)

  // A single soft accent glow, off-canvas centre, so the flat variant is not a
  // dead rectangle. Kept very low alpha: it must never compete with the text.
  const glow = ctx.createRadialGradient(
    SLIDE_SIZE * 0.85, SLIDE_SIZE * 0.15, 0,
    SLIDE_SIZE * 0.85, SLIDE_SIZE * 0.15, SLIDE_SIZE * 0.7,
  )
  glow.addColorStop(0, `${theme.accent}22`)
  glow.addColorStop(1, `${theme.accent}00`)
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, SLIDE_SIZE, SLIDE_SIZE)
}

/** Cover-fit: fills the square without distorting whatever aspect the model returned. */
function drawCover(ctx: CanvasRenderingContext2D, img: CanvasImageSource) {
  const w = (img as HTMLImageElement).width || SLIDE_SIZE
  const h = (img as HTMLImageElement).height || SLIDE_SIZE
  const scale = Math.max(SLIDE_SIZE / w, SLIDE_SIZE / h)
  const dw = w * scale
  const dh = h * scale
  ctx.drawImage(img, (SLIDE_SIZE - dw) / 2, (SLIDE_SIZE - dh) / 2, dw, dh)
}

/**
 * The scrim is what makes the image variant safe. Without it the slide's
 * legibility depends on the model happening to return something dark where the
 * text lands — not a property anything can guarantee, and one that fails
 * invisibly until someone reads the posted carousel.
 *
 * It is directional rather than a flat wash. A uniform veil heavy enough to
 * guarantee contrast also erases the picture, which defeats the point of paying
 * for one — the first attempt here did exactly that and the two variants came
 * out indistinguishable. So: darkest down the left column and along the top and
 * bottom edges, where the text and chrome actually sit, and close to clear
 * through the middle-right, where the image is free to show.
 */
function drawScrim(ctx: CanvasRenderingContext2D, theme: SlideTheme) {
  const vertical = ctx.createLinearGradient(0, 0, 0, SLIDE_SIZE)
  vertical.addColorStop(0, `${theme.background}B8`)
  vertical.addColorStop(0.5, `${theme.background}59`)
  vertical.addColorStop(1, `${theme.background}CC`)
  ctx.fillStyle = vertical
  ctx.fillRect(0, 0, SLIDE_SIZE, SLIDE_SIZE)

  const horizontal = ctx.createLinearGradient(0, 0, SLIDE_SIZE, 0)
  horizontal.addColorStop(0, `${theme.background}A6`)
  horizontal.addColorStop(0.72, `${theme.background}00`)
  ctx.fillStyle = horizontal
  ctx.fillRect(0, 0, SLIDE_SIZE, SLIDE_SIZE)
}

// =============================================================================
// The slide
// =============================================================================

function drawChrome(
  ctx: CanvasRenderingContext2D,
  theme: SlideTheme,
  brand: string,
  position: number,
  total: number,
) {
  ctx.textBaseline = 'top'
  ctx.font = `700 26px ${FONT_STACK}`
  ctx.fillStyle = theme.text
  ctx.fillText(brand.toUpperCase(), MARGIN, MARGIN)

  const counter = `${String(position).padStart(2, '0')} / ${String(total).padStart(2, '0')}`
  ctx.font = `600 26px ${FONT_STACK}`
  ctx.fillStyle = theme.muted
  ctx.textAlign = 'right'
  ctx.fillText(counter, SLIDE_SIZE - MARGIN, MARGIN)
  ctx.textAlign = 'left'
}

function drawFooter(ctx: CanvasRenderingContext2D, theme: SlideTheme, title: string) {
  if (!title.trim()) return
  ctx.font = `500 24px ${FONT_STACK}`
  ctx.fillStyle = theme.muted
  ctx.textBaseline = 'alphabetic'
  const maxWidth = SLIDE_SIZE - MARGIN * 2
  let text = title.trim()
  while (ctx.measureText(text).width > maxWidth && text.length > 4) {
    text = `${text.slice(0, -2).trimEnd()}…`
  }
  ctx.fillText(text, MARGIN, SLIDE_SIZE - MARGIN)
}

/**
 * Draws one slide into a 1080×1080 context. Split out from the PNG helper so
 * the same code paints the on-screen preview and the downloaded file — a
 * preview that renders through a different path is how "it looked fine in the
 * app" happens.
 */
export function drawSlide(ctx: CanvasRenderingContext2D, opts: RenderOptions): void {
  const theme = opts.theme ?? DEFAULT_THEME
  const variant = opts.variant ?? 'flat'
  const brand = opts.brand ?? 'CUES'
  const { slide, total, publicationTitle } = opts
  const opening = slide.position === 1

  if (variant === 'image' && opts.background) {
    drawCover(ctx, opts.background)
    drawScrim(ctx, theme)
  } else {
    drawFlatBackground(ctx, theme, opening)
  }

  drawChrome(ctx, theme, brand, slide.position, total)

  const contentWidth = SLIDE_SIZE - MARGIN * 2
  const contentTop = MARGIN + 96
  const contentBottom = SLIDE_SIZE - MARGIN - 56
  const available = contentBottom - contentTop

  // The opening slide is the only one a reader sees before deciding to swipe,
  // so it gets the whole canvas for its heading and drops the body — an
  // opening slide that also explains itself has already lost the swipe.
  if (opening) {
    const heading = fitBlock(ctx, slide.heading, contentWidth, available * 0.62, 92, '800', 48, 1.16)
    const bodyMax = available - heading.lines.length * heading.lineHeight - 120
    const body = slide.body.trim()
      ? fitBlock(ctx, slide.body, contentWidth, Math.max(bodyMax, 120), 38, '400', 26, 1.42)
      : null

    const totalHeight = heading.lines.length * heading.lineHeight +
      (body ? body.lines.length * body.lineHeight + 56 : 0) + 84
    let y = contentTop + Math.max((available - totalHeight) / 2, 0)

    ctx.fillStyle = theme.accent
    ctx.fillRect(MARGIN, y, 132, 10)
    y += 74

    y = drawLines(ctx, heading, MARGIN, y, theme.text, '800')
    if (body) {
      y += 56
      drawLines(ctx, body, MARGIN, y, theme.body, '400')
    }
    return
  }

  const heading = fitBlock(ctx, slide.heading, contentWidth, available * 0.4, 68, '800', 38, 1.18)
  const usedByHeading = heading.lines.length * heading.lineHeight + 44
  const body = fitBlock(
    ctx, slide.body, contentWidth, available - usedByHeading - 60, 40, '400', 24, 1.46,
  )

  // Centred as a block rather than pinned to the top. Slide bodies are two or
  // three sentences and vary a lot in length; top-aligning them leaves half the
  // canvas empty on the short ones, which reads as an unfinished template
  // rather than a deliberate one. Biased slightly above true centre — optical
  // centre sits high, and the footer occupies the bottom margin anyway.
  const RULE_ABOVE = 30
  const RULE_HEIGHT = 8
  const RULE_BELOW = 46
  const blockHeight = heading.lines.length * heading.lineHeight +
    RULE_ABOVE + RULE_HEIGHT + RULE_BELOW +
    body.lines.length * body.lineHeight
  let y = contentTop + Math.max((available - blockHeight) * 0.42, 0)

  y = drawLines(ctx, heading, MARGIN, y, theme.text, '800')

  y += RULE_ABOVE
  ctx.fillStyle = theme.accent
  ctx.fillRect(MARGIN, y, 96, RULE_HEIGHT)
  y += RULE_HEIGHT + RULE_BELOW

  drawLines(ctx, body, MARGIN, y, theme.body, '400')

  drawFooter(ctx, theme, publicationTitle)
}

/**
 * Renders one slide to a PNG blob.
 *
 * Not `canvas.toDataURL`: a data URL for a 1080² PNG is a multi-megabyte string
 * that has to be built, held and re-parsed, where a Blob is the bytes the
 * download needs already.
 */
export async function renderSlidePng(opts: RenderOptions): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = SLIDE_SIZE
  canvas.height = SLIDE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('this browser did not provide a 2D canvas context')

  drawSlide(ctx, opts)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas produced no PNG data'))),
      'image/png',
    )
  })
}

/** `slide-03.png` — zero-padded so a file listing sorts in reading order. */
export function slideFilename(position: number): string {
  return `slide-${String(position).padStart(2, '0')}.png`
}
