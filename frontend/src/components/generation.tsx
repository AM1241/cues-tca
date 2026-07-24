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
