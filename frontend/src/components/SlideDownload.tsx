import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CarouselOutput, CarouselSlide } from './generation'
import { slideFilename, type SlideVariant } from '../lib/slides'
import {
  DOWNLOAD_GAP_MS,
  renderOneSlide,
  sleep,
  type SlideQuality,
} from '../lib/slideExport'
import { downloadBlob } from '../lib/exporters'

/**
 * Downloading an approved carousel as PNG slides.
 *
 * GENERATE AND DOWNLOAD ARE SEPARATE STEPS, deliberately. An earlier version
 * downloaded each slide the moment it was rendered, which meant the only place
 * to look at a paid-for image was the Downloads folder, after the money was
 * spent. Now every slide is shown here as it arrives; downloading is a second,
 * free click, and a slide whose picture is wrong can be regenerated on its own.
 *
 * WHY renderSlideAt TAKES THE VARIANT AS AN ARGUMENT
 * The flat variant renders automatically, because it is free. The paid one must
 * never render without an explicit click. Relying on a `variant !== 'flat'`
 * guard inside an effect was not enough: an earlier build fired all seven paid
 * requests merely on switching the radio, and only escaped billing because the
 * function was not deployed yet. Passing the variant explicitly means the
 * automatic path hardcodes 'flat' and is structurally incapable of spending
 * anything, whatever the component state happens to be.
 *
 * A PICTURE IS BOUGHT ONCE
 * Backgrounds are kept for the life of this panel, so changing a word redraws
 * the text on the picture that was already paid for instead of buying it
 * again. Only `redo` — which says so — deliberately buys a new one. The panel
 * is remounted (Review keys it by result id) when a different carousel is
 * opened, so a picture can never be carried over to copy it was not made for.
 */
type SlideState = {
  slide: CarouselSlide
  status: 'idle' | 'working' | 'done' | 'error'
  blob: Blob | null
  url: string | null
  error: string | null
}

function initialStates(slides: CarouselSlide[]): SlideState[] {
  return slides.map((slide) => ({ slide, status: 'idle', blob: null, url: null, error: null }))
}

/**
 * How long the copy must stand still before the slides are redrawn.
 *
 * Long enough that ordinary typing produces one pass rather than one per
 * character; short enough that a pause reads as "it updated", not as a wait.
 */
const EDIT_SETTLE_MS = 400

export function SlideDownload({ carousel }: { carousel: CarouselOutput }) {
  const [variant, setVariant] = useState<SlideVariant>('flat')
  const [quality, setQuality] = useState<SlideQuality>('low')
  const [busy, setBusy] = useState(false)
  const [zoomed, setZoomed] = useState<string | null>(null)

  const slides = useMemo(
    () => [...carousel.slides].sort((a, b) => a.position - b.position),
    [carousel.slides],
  )
  const [states, setStates] = useState<SlideState[]>(() => initialStates(slides))

  /**
   * Backgrounds live outside React state so renderSlideAt does not have to
   * close over `states` — a stale closure there is what makes "re-render the
   * text on the picture I already paid for" quietly turn into a second
   * purchase.
   */
  const backgroundsRef = useRef(new Map<number, HTMLImageElement>())

  /** Slide positions whose background has been bought. Display only. */
  const [paidPositions, setPaidPositions] = useState<number[]>([])

  /**
   * Which pass over the copy the slides on screen belong to.
   *
   * Every render reads this when it starts and checks it again before it
   * writes. A pass that has been superseded — because the copy changed, or the
   * variant did — therefore cannot put its result on screen, no matter how the
   * timing falls out. See the note above the render effect for what went wrong
   * without it.
   */
  const renderGenerationRef = useRef(0)

  /** The `variant::copy` the slides on screen were drawn for. */
  const renderedKey = useRef<string | null>(null)

  // Object URLs are freed when the set is replaced or the component unmounts;
  // revoking eagerly would blank an <img> still on screen.
  const urlsRef = useRef<string[]>([])
  const releaseUrls = () => {
    urlsRef.current.forEach(URL.revokeObjectURL)
    urlsRef.current = []
  }
  useEffect(
    () => () => {
      // Retiring the generation on unmount stops an in-flight render writing
      // into a component that is gone.
      //
      // `renderedKey` MUST be cleared in the same breath. Refs survive a
      // remount, so leaving it set means the render effect sees "already drawn"
      // and skips, while the pass that was actually drawing has just been
      // retired — and the slides sit on "Generating…" forever. React's
      // StrictMode mounts every component twice in development, so this is not
      // a corner case: it is what happens on every single page load.
      renderGenerationRef.current++
      renderedKey.current = null
      releaseUrls()
    },
    [],
  )

  const total = slides.length

  const renderSlideAt = useCallback(
    async (index: number, useVariant: SlideVariant, opts: { reuseBackground: boolean }) => {
      const slide = slides[index]
      if (!slide) return
      // Fixed when this render starts. Everything below refuses to write once
      // it no longer matches — a stale result is discarded, never displayed.
      const generation = renderGenerationRef.current
      const current = () => renderGenerationRef.current === generation

      setStates((prev) =>
        prev.map((s, i) => (i === index ? { ...s, status: 'working', error: null } : s)),
      )
      try {
        const reused = opts.reuseBackground ? backgroundsRef.current.get(slide.position) ?? null : null
        const { blob, background } = await renderOneSlide(carousel, slide, {
          variant: useVariant,
          quality,
          background: reused,
        })
        // No object URL is created for a superseded render: it would never be
        // shown and nothing would ever revoke it.
        if (!current()) return
        if (background) {
          backgroundsRef.current.set(slide.position, background)
          // Mirrored into state purely so the cost shown on the button can be
          // the number of pictures that will actually be bought.
          setPaidPositions((prev) =>
            prev.includes(slide.position) ? prev : [...prev, slide.position],
          )
        }
        const url = URL.createObjectURL(blob)
        urlsRef.current.push(url)
        setStates((prev) =>
          prev.map((s, i) => (i === index ? { ...s, status: 'done', blob, url, error: null } : s)),
        )
      } catch (e) {
        if (!current()) return
        setStates((prev) =>
          prev.map((s, i) =>
            i === index ? { ...s, status: 'error', error: (e as Error).message } : s,
          ),
        )
      }
    },
    [carousel, quality, slides],
  )

  /**
   * Re-render the free previews whenever the copy or the variant changes.
   *
   * `carousel` is Review's LIVE draft: it changes on every keystroke, not on
   * save. The first version keyed the render loop straight off it, so typing a
   * four-letter word started four seven-slide passes at once — and a pass only
   * checked whether it had been superseded BETWEEN slides, so the render
   * already in flight always finished and wrote its result. Whichever pass
   * happened to be slowest won. An editor who typed "full" watched the slide
   * sit on "fu" until something unrelated redrew it.
   *
   * Two changes, and both are needed:
   *   - the copy is debounced, so a burst of typing produces one pass;
   *   - a pass writes only while it is the current generation, so a late
   *     straggler is discarded however the timing falls out.
   *
   * The second is the one that protects the guarantee this panel exists to
   * make — that the words on the image are the words that were approved.
   */
  const contentKey = useMemo(() => JSON.stringify(carousel), [carousel])
  const [settledContentKey, setSettledContentKey] = useState(contentKey)

  useEffect(() => {
    if (settledContentKey === contentKey) return
    const timer = setTimeout(() => setSettledContentKey(contentKey), EDIT_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [contentKey, settledContentKey])

  /** The editor has typed something the slides on screen do not show yet. */
  const stale = contentKey !== settledContentKey

  /**
   * Only the copy is debounced. A variant change applies at once: waiting on a
   * radio click would open a window in which `generateAll` could spend real
   * money and then have its results wiped by a settle that was already queued.
   */
  const renderKey = `${variant}::${settledContentKey}`

  useEffect(() => {
    if (renderedKey.current === renderKey) return
    renderedKey.current = renderKey

    const generation = ++renderGenerationRef.current
    releaseUrls()
    // Backgrounds are deliberately NOT cleared here. Clearing them meant every
    // edited word threw away every picture already bought and charged for them
    // again on the next Generate — while the code that exists to prevent that
    // (`reuseBackground`) was never once called with `true`.
    setStates(initialStates(slides))

    // Only the free variant renders on sight. The paid one waits for the
    // button — see the note at the top of this file.
    if (variant !== 'flat') {
      // Any earlier pass is already barred from writing by the bump above, so
      // nothing is left rendering.
      setBusy(false)
      return
    }

    void (async () => {
      setBusy(true)
      for (let i = 0; i < slides.length; i++) {
        if (renderGenerationRef.current !== generation) return
        await renderSlideAt(i, 'flat', { reuseBackground: false })
      }
      if (renderGenerationRef.current === generation) setBusy(false)
    })()
  }, [renderKey, slides, variant, renderSlideAt])

  async function generateAll() {
    setBusy(true)
    for (let i = 0; i < slides.length; i++) {
      // Skip what is already produced, so pressing this after a partial
      // failure only pays for what is actually missing.
      if (states[i]?.status === 'done') continue
      // Reuse the picture for this slide if one was already bought: after an
      // edit that is every slide, and the whole pass costs nothing.
      await renderSlideAt(i, variant, { reuseBackground: true })
    }
    setBusy(false)
  }

  async function downloadAll() {
    const ready = states.filter((s) => s.status === 'done' && s.blob)
    for (let i = 0; i < ready.length; i++) {
      downloadBlob(slideFilename(ready[i].slide.position), ready[i].blob!)
      if (i < ready.length - 1) await sleep(DOWNLOAD_GAP_MS)
    }
  }

  const doneCount = states.filter((s) => s.status === 'done').length
  const failed = states.filter((s) => s.status === 'error')
  const remaining = total - doneCount

  /**
   * How many pictures pressing Generate would actually BUY — which is not the
   * same as how many slides it would draw. After an edit every slide needs
   * drawing again, but each one that already has a picture is redrawn for
   * nothing. Showing `remaining` here would have quoted a price for work that
   * is free.
   */
  const paid = new Set(paidPositions)
  const needsBuying =
    variant === 'image'
      ? states.filter((s) => s.status !== 'done' && !paid.has(s.slide.position)).length
      : 0

  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-700">Download as slides</h3>
      <p className="mt-1 text-xs text-slate-500">
        One PNG per slide, 1080×1080, ready to upload. The wording is drawn from the
        approved text exactly as it stands here — no model rewrites it into the picture.
      </p>

      <fieldset className="mt-3">
        <legend className="text-xs font-medium text-slate-600">Background</legend>
        <div className="mt-1.5 flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="radio"
              checked={variant === 'flat'}
              onChange={() => setVariant('flat')}
              disabled={busy}
              className="mt-0.5"
            />
            <span className="text-sm text-slate-700">
              Designed template
              <span className="block text-xs text-slate-500">Free and instant.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="radio"
              checked={variant === 'image'}
              onChange={() => setVariant('image')}
              disabled={busy}
              className="mt-0.5"
            />
            <span className="text-sm text-slate-700">
              AI background image
              <span className="block text-xs text-slate-500">
                One generated picture per slide.
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      {variant === 'image' && (
        <div className="mt-3 rounded-md bg-amber-50 p-2.5">
          <p className="text-xs text-amber-800">
            {needsBuying > 0 ? (
              <>
                Nothing is generated until you press the button below. It creates{' '}
                <strong>
                  {needsBuying} image{needsBuying === 1 ? '' : 's'}
                </strong>{' '}
                and bills for each one. Downloading what you see is free; generating again is
                not.
              </>
            ) : (
              <>
                Every slide already has a picture you have paid for.{' '}
                <strong>Redrawing puts your new wording on them and costs nothing.</strong> Only{' '}
                <em>redo</em> on a single slide buys a new picture.
              </>
            )}
          </p>
          <label className="mt-2 block text-xs text-amber-900">
            Quality{' '}
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value as SlideQuality)}
              disabled={busy}
              className="ml-1 rounded border border-amber-300 bg-white px-1.5 py-0.5 text-xs"
            >
              <option value="low">low — about 15s a slide</option>
              <option value="medium">medium — about 60s a slide</option>
              <option value="high">high — slowest</option>
            </select>
          </label>
        </div>
      )}

      {/* The slides themselves. This grid is where they are looked at, before
          anything is downloaded and before anything else is paid for. */}
      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
        {states.map((s, i) => (
          <div key={s.slide.position}>
            <div className="aspect-square overflow-hidden rounded-md border border-slate-200 bg-slate-900">
              {s.url ? (
                <img
                  src={s.url}
                  alt={`Slide ${s.slide.position}: ${s.slide.heading}`}
                  onClick={() => setZoomed(s.url)}
                  className="h-full w-full cursor-zoom-in object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center px-1 text-center">
                  <span className="text-[10px] leading-tight text-slate-400">
                    {s.status === 'working'
                      ? 'Generating…'
                      : s.status === 'error'
                        ? 'Failed'
                        : `Slide ${s.slide.position}`}
                  </span>
                </div>
              )}
            </div>
            <div className="mt-1 flex items-center justify-between gap-1">
              <span className="text-[10px] text-slate-500">{s.slide.position}</span>
              {s.status === 'done' && (
                <span className="flex gap-1.5">
                  <button
                    onClick={() => downloadBlob(slideFilename(s.slide.position), s.blob!)}
                    disabled={stale}
                    title={stale ? 'Waiting for your edits to be drawn' : undefined}
                    className="text-[10px] text-slate-500 underline underline-offset-2 hover:text-slate-900 disabled:no-underline disabled:opacity-40"
                  >
                    save
                  </button>
                  {variant === 'image' && (
                    <button
                      onClick={() => renderSlideAt(i, 'image', { reuseBackground: false })}
                      disabled={busy || stale}
                      title="Generates a new picture for this slide only, and bills for it"
                      className="text-[10px] text-amber-700 underline underline-offset-2 hover:text-amber-900 disabled:opacity-50"
                    >
                      redo
                    </button>
                  )}
                </span>
              )}
              {s.status === 'error' && (
                <button
                  onClick={() => renderSlideAt(i, variant, { reuseBackground: true })}
                  disabled={busy || stale}
                  className="text-[10px] text-red-600 underline underline-offset-2 disabled:opacity-50"
                >
                  retry
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {failed.length > 0 && (
        <p className="mt-2 text-xs text-red-600">
          {failed.length} slide{failed.length === 1 ? '' : 's'} failed: {failed[0].error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {variant === 'image' && remaining > 0 && (
          <button
            onClick={generateAll}
            disabled={busy || stale}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {busy
              ? 'Generating…'
              : needsBuying > 0
                ? `Generate ${needsBuying} image${needsBuying === 1 ? '' : 's'}`
                : `Redraw ${remaining} slide${remaining === 1 ? '' : 's'} — free`}
          </button>
        )}
        <button
          onClick={downloadAll}
          disabled={doneCount === 0 || busy || stale}
          className="rounded-md border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Download {doneCount || ''} {doneCount === 1 ? 'slide' : 'slides'}
        </button>
        <span className="text-xs text-slate-500">
          {stale
            ? 'Redrawing for your edits…'
            : `${doneCount} of ${total} ready${busy ? '…' : ''}`}
        </span>
      </div>

      {zoomed && (
        <div
          onClick={() => setZoomed(null)}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-6"
        >
          <img src={zoomed} alt="Slide preview" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </div>
  )
}
