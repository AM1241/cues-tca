import { useState } from 'react'

// Shared rendering for `generate` outputs — used by the Clusters view (the
// synchronous response, shown immediately) and the Generate view (the same
// shapes read back from cluster_generation_results). PHASE5_FRONTEND_HANDOFF.md
// defines the shapes; they are already-structured JSON, no markdown parsing.

export type PostOutput = {
  headline: string
  text: string
  cta: string
  hashtags: string[]
}

export type CarouselSlide = { position: number; heading: string; body: string }

export type CarouselOutput = {
  title: string
  slides: CarouselSlide[]
  caption: string
  cta: string
}

export type GenerationResultView = {
  cluster_id: string
  cluster_label: string
  post?: PostOutput | null
  carousel?: CarouselOutput | null
}

export type GenerationErrorView = {
  cluster_id: string
  error_type: string
  error_message: string | null
}

export function PostOutputCard({ post }: { post: PostOutput }) {
  return (
    <div className="rounded-md bg-slate-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Post</p>
      <h4 className="mt-1 text-sm font-semibold text-slate-900">{post.headline}</h4>
      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{post.text}</p>
      <p className="mt-3 text-sm font-medium text-slate-700">{post.cta}</p>
      {post.hashtags.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-1.5">
          {post.hashtags.map((h) => (
            <span key={h} className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700">
              {h}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

export function CarouselOutputCard({ carousel }: { carousel: CarouselOutput }) {
  return (
    <div className="rounded-md bg-slate-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Carousel</p>
      <h4 className="mt-1 text-sm font-semibold text-slate-900">{carousel.title}</h4>
      <ol className="mt-3 space-y-2">
        {carousel.slides.map((s) => (
          <li key={s.position} className="rounded border border-slate-200 bg-white p-3">
            <p className="text-xs text-slate-400">Slide {s.position}</p>
            <p className="mt-0.5 text-sm font-medium text-slate-900">{s.heading}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{s.body}</p>
          </li>
        ))}
      </ol>
      <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{carousel.caption}</p>
      <p className="mt-2 text-sm font-medium text-slate-700">{carousel.cta}</p>
    </div>
  )
}

export function GenerationResultCard({ result }: { result: GenerationResultView }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-sm font-semibold text-slate-900">{result.cluster_label}</p>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        {result.post && <PostOutputCard post={result.post} />}
        {result.carousel && <CarouselOutputCard carousel={result.carousel} />}
      </div>
    </div>
  )
}

// --- Editable counterparts, used by Review ------------------------------------
// The same shapes as above, as forms. Review writes the result into
// cluster_generation_reviews.edited_output; the generated original is never
// modified, so these always start from `edited_output ?? <original>`.

const fieldClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500'

function Field({
  label,
  value,
  onChange,
  rows,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  rows?: number
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      {rows ? (
        <textarea
          value={value}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          className={fieldClass}
        />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} className={fieldClass} />
      )}
    </label>
  )
}

export function PostOutputEditor({
  post,
  onChange,
}: {
  post: PostOutput
  onChange: (next: PostOutput) => void
}) {
  // Hashtags are edited as one comma/space-separated line and normalised back
  // to the array the JSON shape requires.
  const [hashtagText, setHashtagText] = useState(post.hashtags.join(' '))

  function commitHashtags(raw: string) {
    setHashtagText(raw)
    const tags = raw
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (t.startsWith('#') ? t : `#${t}`))
    onChange({ ...post, hashtags: tags })
  }

  return (
    <div className="space-y-3">
      <Field label="Headline" value={post.headline} onChange={(v) => onChange({ ...post, headline: v })} />
      <Field label="Text" value={post.text} rows={10} onChange={(v) => onChange({ ...post, text: v })} />
      <Field label="CTA" value={post.cta} onChange={(v) => onChange({ ...post, cta: v })} />
      <Field label="Hashtags" value={hashtagText} onChange={commitHashtags} />
    </div>
  )
}

export function CarouselOutputEditor({
  carousel,
  onChange,
}: {
  carousel: CarouselOutput
  onChange: (next: CarouselOutput) => void
}) {
  function setSlide(position: number, patch: Partial<CarouselSlide>) {
    onChange({
      ...carousel,
      slides: carousel.slides.map((s) => (s.position === position ? { ...s, ...patch } : s)),
    })
  }

  return (
    <div className="space-y-3">
      <Field label="Title" value={carousel.title} onChange={(v) => onChange({ ...carousel, title: v })} />
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">Slides</p>
        <ol className="space-y-3">
          {carousel.slides.map((s) => (
            <li key={s.position} className="rounded-md border border-slate-200 p-3">
              <p className="mb-2 text-xs text-slate-400">Slide {s.position}</p>
              <div className="space-y-2">
                <Field label="Heading" value={s.heading} onChange={(v) => setSlide(s.position, { heading: v })} />
                <Field label="Body" value={s.body} rows={4} onChange={(v) => setSlide(s.position, { body: v })} />
              </div>
            </li>
          ))}
        </ol>
      </div>
      <Field label="Caption" value={carousel.caption} rows={4} onChange={(v) => onChange({ ...carousel, caption: v })} />
      <Field label="CTA" value={carousel.cta} onChange={(v) => onChange({ ...carousel, cta: v })} />
    </div>
  )
}

export function GenerationErrorList({
  errors,
  labelFor,
}: {
  errors: GenerationErrorView[]
  labelFor: (clusterId: string) => string
}) {
  if (errors.length === 0) return null
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      <p className="font-medium">
        {errors.length} cluster{errors.length === 1 ? '' : 's'} failed to generate
      </p>
      <ul className="mt-1 space-y-1 text-xs">
        {errors.map((e) => (
          <li key={e.cluster_id}>
            <span className="font-medium">{labelFor(e.cluster_id)}</span> — {e.error_type}
            {e.error_message ? `: ${e.error_message}` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}
