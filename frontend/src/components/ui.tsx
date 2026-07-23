export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
      {label}
    </div>
  )
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
      {children}
    </div>
  )
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
      {message}
    </p>
  )
}
