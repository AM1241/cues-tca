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
 * The publication: what was written, what it will look like, and the files.
 *
 * This used to be a strip of 118px thumbnails called "Download as slides",
 * sitting below the citation list at the very bottom of Review. The framing was
 * backwards. On LinkedIn a carousel IS the images; the text is the source they
 * are drawn from. So the finished post now leads, and the editing happens
 * underneath it.
 *
 * TWO BANDS, ONE DRAFT
 * The preview and the bench read and write the same `carousel` prop. Editing a
 * heading below changes the post above after the copy settles — there is no
 * second copy of the text to fall out of step, which is the whole reason they
 * are stacked rather than living on separate screens.
 *
 * WHY renderSlideAt TAKES THE VARIANT AS AN ARGUMENT
 * The flat variant renders automatically, because it is free. The paid one must
 * never render without an explicit click. Relying on a `variant !== 'flat'`
 * guard inside an effect was not enough: an earlier build fired all seven paid
 * requests merely on switching the radio, and only escaped billing because the
 * function was not deployed yet. Passing the variant explicitly means the
 * automatic path decides for itself and cannot be talked into spending.
 *
 * THE AUTOMATIC PATH STILL CANNOT SPEND, and it is worth being exact about why,
 * because it no longer hardcodes 'flat'. It now picks per slide: 'image' only
 * where a background has ALREADY been bought (passed straight back in, so
 * `renderOneSlide` never reaches for the network), otherwise 'flat'. The
 * invariant is unchanged and is the thing to preserve — the automatic path
 * never passes a combination that could trigger a fetch. What it buys is a
 * preview that stays populated while you type instead of blanking, which
 * matters a great deal now that it is the first thing on the screen.
 *
 * A PICTURE IS BOUGHT ONCE
 * Backgrounds are kept for the life of this panel, so changing a word redraws
 * the text on the picture already paid for. Only `redo` — which says so — buys
 * a new one. Review keys its detail component by result id, so opening a
 * different carousel remounts this and no picture is ever carried over to copy
 * it was not made for.
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

export function PublicationPanel({
  carousel,
  onChange,
}: {
  carousel: CarouselOutput
  onChange: (next: CarouselOutput) => void
}) {
  const [variant, setVariant] = useState<SlideVariant>('flat')
  const [quality, setQuality] = useState<SlideQuality>('low')
  const [busy, setBusy] = useState(false)
  const [zoomed, setZoomed] = useState<string | null>(null)
  const [current, setCurrent] = useState(0)

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
   * writes. A pass that has been superseded cannot put its result on screen,
   * however the timing falls out.
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
      // into a component that is gone. `renderedKey` MUST be cleared with it:
      // refs survive a remount, so leaving it set means the effect sees
      // "already drawn" and skips while the pass that was drawing has just been
      // retired — slides then sit on "Generating…" forever. StrictMode mounts
      // everything twice in development, so this is every page load, not a
      // corner case.
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
      const isCurrent = () => renderGenerationRef.current === generation

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
        if (!isCurrent()) return
        if (background) {
          backgroundsRef.current.set(slide.position, background)
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
        if (!isCurrent()) return
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
   * `carousel` is Review's LIVE draft: it changes on every keystroke, not on
   * save. The first version keyed the render loop straight off it, so typing a
   * four-letter word started four seven-slide passes at once — and a pass only
   * checked whether it had been superseded BETWEEN slides, so the render
   * already in flight always finished and wrote its result. Whichever pass was
   * slowest won, and an editor who typed "full" watched the slide sit on "fu".
   *
   * The debounce means a burst of typing produces one pass; the generation
   * counter means a superseded pass cannot write at all.
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
   * radio click would open a window in which a purchase could be wiped by a
   * settle that was already queued.
   */
  const renderKey = `${variant}::${settledContentKey}`

  useEffect(() => {
    if (renderedKey.current === renderKey) return
    renderedKey.current = renderKey

    const generation = ++renderGenerationRef.current
    releaseUrls()
    // Backgrounds are deliberately NOT cleared. Clearing them meant every
    // edited word threw away every picture already bought and charged for them
    // again on the next Generate.
    setStates(initialStates(slides))

    void (async () => {
      setBusy(true)
      for (let i = 0; i < slides.length; i++) {
        if (renderGenerationRef.current !== generation) return
        // The only place the automatic path chooses a variant, and it chooses
        // 'image' ONLY where the picture is already in hand — which is then
        // passed straight back in, so nothing is fetched. See the header.
        const owned = backgroundsRef.current.has(slides[i].position)
        await renderSlideAt(i, owned ? 'image' : 'flat', { reuseBackground: true })
      }
      if (renderGenerationRef.current === generation) setBusy(false)
    })()
  }, [renderKey, slides, renderSlideAt])

  // Keep the selected slide in range when the editor adds or removes one.
  useEffect(() => {
    if (current > total - 1) setCurrent(Math.max(0, total - 1))
  }, [current, total])

  const paid = useMemo(() => new Set(paidPositions), [paidPositions])

  /**
   * How many pictures pressing Generate would actually BUY. Not the same as how
   * many slides it would draw: after an edit every slide is redrawn, but each
   * one that already has a picture is redrawn for nothing.
   */
  const needsBuying = variant === 'image'
    ? slides.filter((s) => !paid.has(s.position)).length
    : 0

  async function generateAll() {
    setBusy(true)
    for (let i = 0; i < slides.length; i++) {
      // Skip what is already bought — pressing this after a partial failure
      // only pays for what is actually missing.
      if (paid.has(slides[i].position)) continue
      await renderSlideAt(i, 'image', { reuseBackground: true })
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

  function setSlideField(position: number, patch: Partial<CarouselSlide>) {
    onChange({
      ...carousel,
      slides: carousel.slides.map((s) => (s.position === position ? { ...s, ...patch } : s)),
    })
  }

  const doneCount = states.filter((s) => s.status === 'done').length
  const failed = states.filter((s) => s.status === 'error')
  const shown = states[current]
  const editing = slides[current]

  const statusLine = stale
    ? 'Redrawing for your edits…'
    : busy
      ? `Drawing ${doneCount} of ${total}…`
      : `${doneCount} of ${total} ready`

  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-700">Your publication</h3>
      <p className="mt-1 text-xs text-slate-500">
        {total} slides, 1080×1080, ready to upload. The wording is drawn from the text below
        exactly as it stands — no model rewrites it into the picture.
      </p>

      {/* ================= the post, as a reader meets it ================= */}
      <div className="mx-auto mt-4 w-full max-w-lg overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center gap-3 px-4 pt-4">
          <span className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold tracking-wide text-emerald-400">
            CUES
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-800">
              {carousel.title || 'Untitled publication'}
            </p>
            <p className="text-xs text-slate-500">Carousel · {total} slides</p>
          </div>
        </div>

        {(carousel.caption.trim() || carousel.cta.trim()) && (
          <div className="space-y-2 px-4 pb-3 pt-2 text-sm leading-relaxed text-slate-700">
            {carousel.caption.trim() && <p>{carousel.caption}</p>}
            {carousel.cta.trim() && <p className="text-slate-500">{carousel.cta}</p>}
          </div>
        )}

        <div className="relative bg-slate-900">
          {shown?.url ? (
            <img
              src={shown.url}
              alt={`Slide ${shown.slide.position}: ${shown.slide.heading}`}
              onClick={() => setZoomed(shown.url)}
              className="aspect-square w-full cursor-zoom-in object-cover"
            />
          ) : (
            <div className="flex aspect-square w-full items-center justify-center">
              <span className="text-xs text-slate-400">
                {shown?.status === 'error' ? 'Failed to draw' : 'Drawing…'}
              </span>
            </div>
          )}
          <span className="absolute right-2 top-2 rounded bg-slate-900/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-slate-100">
            {current + 1}/{total}
          </span>
          <span className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1 rounded-full bg-slate-900/70 px-2 py-1">
            {slides.map((s, i) => (
              <span
                key={s.position}
                className={`h-1.5 w-1.5 rounded-full ${i === current ? 'bg-emerald-400' : 'bg-slate-100/40'}`}
              />
            ))}
          </span>
        </div>

        <div className="flex border-t border-slate-200 text-xs text-slate-400">
          <span className="flex-1 py-2 text-center">Like</span>
          <span className="flex-1 py-2 text-center">Comment</span>
          <span className="flex-1 py-2 text-center">Repost</span>
          <span className="flex-1 py-2 text-center">Send</span>
        </div>
      </div>

      {/* ---- moving between slides ---- */}
      <div className="mt-3 flex items-center justify-center gap-3">
        <button
          onClick={() => setCurrent((i) => Math.max(0, i - 1))}
          disabled={current === 0}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          ‹ Previous
        </button>
        <span className="min-w-[5rem] text-center text-sm tabular-nums text-slate-500">
          {String(current + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
        </span>
        <button
          onClick={() => setCurrent((i) => Math.min(total - 1, i + 1))}
          disabled={current >= total - 1}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          Next ›
        </button>
      </div>

      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {states.map((s, i) => (
          <button
            key={s.slide.position}
            onClick={() => setCurrent(i)}
            aria-current={i === current}
            title={`Slide ${s.slide.position}`}
            className={`relative flex-none rounded-md border p-0 leading-none ${
              i === current ? 'border-emerald-500 ring-2 ring-emerald-100' : 'border-slate-200'
            }`}
          >
            {s.url ? (
              <img src={s.url} alt="" className="h-16 w-16 rounded-[3px]" />
            ) : (
              <span className="flex h-16 w-16 items-center justify-center rounded-[3px] bg-slate-900 text-[10px] text-slate-400">
                {s.slide.position}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ================= the files ================= */}
      <fieldset className="mt-4">
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
              <span className="block text-xs text-slate-500">One generated picture per slide.</span>
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
                and bills for each one.{' '}
                {needsBuying === total
                  ? 'Until then the slides above show the designed template.'
                  : 'Slides that already have a picture are shown on it.'}
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

      {failed.length > 0 && (
        <p className="mt-2 text-xs text-red-600">
          {failed.length} slide{failed.length === 1 ? '' : 's'} failed: {failed[0].error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {variant === 'image' && needsBuying > 0 && (
          <button
            onClick={generateAll}
            disabled={busy || stale}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {busy ? 'Generating…' : `Generate ${needsBuying} image${needsBuying === 1 ? '' : 's'}`}
          </button>
        )}
        {variant === 'image' && shown?.status === 'done' && (
          <button
            onClick={() => renderSlideAt(current, 'image', { reuseBackground: false })}
            disabled={busy || stale}
            title="Generates a new picture for this slide only, and bills for it"
            className="rounded-md border border-amber-300 px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-50 disabled:opacity-50"
          >
            Redo slide {current + 1}
          </button>
        )}
        <button
          onClick={downloadAll}
          disabled={doneCount === 0 || busy || stale}
          className="rounded-md border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Download {doneCount || ''} {doneCount === 1 ? 'slide' : 'slides'}
        </button>
        <span className="text-xs text-slate-500">{statusLine}</span>
      </div>

      {/* ================= the bench ================= */}
      <hr className="my-5 border-slate-200" />

      <h4 className="text-sm font-semibold text-slate-700">
        Slide {current + 1} of {total}
      </h4>
      <p className="mt-1 text-xs text-slate-500">
        Changes here reach the post above as you type.
      </p>

      {editing && (
        <div className="mt-3 grid gap-5 md:grid-cols-[1fr_240px]">
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Heading</span>
              <input
                value={editing.heading}
                onChange={(e) => setSlideField(editing.position, { heading: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Body</span>
              <textarea
                value={editing.body}
                onChange={(e) => setSlideField(editing.position, { body: e.target.value })}
                rows={7}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
          </div>

          {/* The file itself, with no chrome around it to flatter it: the frame
              above shows how it reads, this shows what gets uploaded. */}
          <div className="space-y-1">
            {shown?.url ? (
              <img
                src={shown.url}
                alt=""
                onClick={() => setZoomed(shown.url)}
                className="aspect-square w-full cursor-zoom-in rounded-md border border-slate-200"
              />
            ) : (
              <div className="aspect-square w-full rounded-md border border-slate-200 bg-slate-900" />
            )}
            <p className="text-[11px] tabular-nums text-slate-400">
              {slideFilename(editing.position)} · 1080×1080
            </p>
          </div>
        </div>
      )}

      {/* ================= the publication's own text ================= */}
      <hr className="my-5 border-slate-200" />

      <h4 className="text-sm font-semibold text-slate-700">Publication text</h4>
      <p className="mt-1 text-xs text-slate-500">
        The title carried in the footer of every slide, and the words posted alongside the images.
      </p>

      <div className="mt-3 space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Title</span>
          <input
            value={carousel.title}
            onChange={(e) => onChange({ ...carousel, title: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Caption</span>
          <textarea
            value={carousel.caption}
            onChange={(e) => onChange({ ...carousel, caption: e.target.value })}
            rows={4}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">CTA</span>
          <input
            value={carousel.cta}
            onChange={(e) => onChange({ ...carousel, cta: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
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
