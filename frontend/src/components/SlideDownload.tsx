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

  // Object URLs are freed when the set is replaced or the component unmounts;
  // revoking eagerly would blank an <img> still on screen.
  const urlsRef = useRef<string[]>([])
  const releaseUrls = () => {
    urlsRef.current.forEach(URL.revokeObjectURL)
    urlsRef.current = []
  }
  useEffect(() => () => releaseUrls(), [])

  const total = slides.length

  const renderSlideAt = useCallback(
    async (index: number, useVariant: SlideVariant, opts: { reuseBackground: boolean }) => {
      const slide = slides[index]
      if (!slide) return
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
        if (background) backgroundsRef.current.set(slide.position, background)
        const url = URL.createObjectURL(blob)
        urlsRef.current.push(url)
        setStates((prev) =>
          prev.map((s, i) => (i === index ? { ...s, status: 'done', blob, url, error: null } : s)),
        )
      } catch (e) {
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
   * Keyed on the carousel's actual content so an editor's edit refreshes the
   * slides, while an unrelated re-render does not restart the loop.
   */
  const contentKey = useMemo(
    () => `${variant}::${JSON.stringify(carousel)}`,
    [variant, carousel],
  )
  const renderedKey = useRef<string | null>(null)

  useEffect(() => {
    if (renderedKey.current === contentKey) return
    renderedKey.current = contentKey

    releaseUrls()
    backgroundsRef.current.clear()
    setStates(initialStates(slides))

    // Only the free variant renders on sight. The paid one waits for the
    // button — see the note at the top of this file.
    if (variant !== 'flat') return

    let cancelled = false
    ;(async () => {
      setBusy(true)
      for (let i = 0; i < slides.length; i++) {
        if (cancelled) break
        await renderSlideAt(i, 'flat', { reuseBackground: false })
      }
      setBusy(false)
    })()
    return () => {
      cancelled = true
    }
  }, [contentKey, slides, variant, renderSlideAt])

  async function generateAll() {
    setBusy(true)
    for (let i = 0; i < slides.length; i++) {
      // Skip what is already produced, so pressing this after a partial
      // failure only pays for what is actually missing.
      if (states[i]?.status === 'done') continue
      await renderSlideAt(i, variant, { reuseBackground: false })
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
            Nothing is generated until you press the button below. It creates{' '}
            <strong>{remaining} image{remaining === 1 ? '' : 's'}</strong> and bills for each
            one. Downloading what you see is free; generating again is not.
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
                    className="text-[10px] text-slate-500 underline underline-offset-2 hover:text-slate-900"
                  >
                    save
                  </button>
                  {variant === 'image' && (
                    <button
                      onClick={() => renderSlideAt(i, 'image', { reuseBackground: false })}
                      disabled={busy}
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
                  onClick={() => renderSlideAt(i, variant, { reuseBackground: false })}
                  disabled={busy}
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
            disabled={busy}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {busy ? 'Generating…' : `Generate ${remaining} image${remaining === 1 ? '' : 's'}`}
          </button>
        )}
        <button
          onClick={downloadAll}
          disabled={doneCount === 0 || busy}
          className="rounded-md border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Download {doneCount || ''} {doneCount === 1 ? 'slide' : 'slides'}
        </button>
        <span className="text-xs text-slate-500">
          {doneCount} of {total} ready{busy ? '…' : ''}
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
