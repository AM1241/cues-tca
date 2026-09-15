import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

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

// -----------------------------------------------------------------------------
// Button
// -----------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
type ButtonSize = 'sm' | 'md'

const BUTTON_VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-800',
  secondary: 'border border-slate-300 text-slate-700 hover:bg-slate-50',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  ghost: 'text-slate-500 hover:text-slate-900',
}

const BUTTON_SIZE_STYLES: Record<ButtonVariant, Record<ButtonSize, string>> = {
  primary: { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2 text-sm' },
  secondary: { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2 text-sm' },
  danger: { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2 text-sm' },
  // Ghost buttons are inline text actions (table rows) — never bordered or
  // padded like a filled button, so they get their own size scale.
  ghost: { sm: 'text-sm', md: 'text-sm' },
}

/**
 * The one button implementation for the app. `variant` picks the visual
 * treatment already in use everywhere (primary = "Save"/"Score now",
 * secondary = "Collect"/"Cancel", danger = "Delete permanently", ghost = the
 * text-only row actions like "Edit"/"Find names"); `size` only affects
 * padding, since ghost buttons never had any.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  disabled,
  ...props
}: {
  variant?: ButtonVariant
  size?: ButtonSize
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      disabled={disabled}
      className={`rounded-md font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_VARIANT_STYLES[variant]} ${BUTTON_SIZE_STYLES[variant][size]} ${className}`}
      {...props}
    />
  )
}

// -----------------------------------------------------------------------------
// Badge
// -----------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'success' | 'danger' | 'warning' | 'info' | 'violet' | 'teal'

const BADGE_TONE_STYLES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-600',
  success: 'bg-emerald-100 text-emerald-700',
  danger: 'bg-red-100 text-red-700',
  warning: 'bg-amber-100 text-amber-700',
  info: 'bg-blue-100 text-blue-700',
  violet: 'bg-violet-100 text-violet-700',
  teal: 'bg-teal-100 text-teal-700',
}

/** A small status/label pill. Covers every "rounded-* bg-*-100 text-*-700" pill in the app. */
export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: BadgeTone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${BADGE_TONE_STYLES[tone]} ${className}`}
    >
      {children}
    </span>
  )
}

// -----------------------------------------------------------------------------
// Toggle
// -----------------------------------------------------------------------------

/** The pill switch used for "enabled" and every boolean setting on Objective. */
export function Toggle({
  checked,
  onChange,
  label,
  ariaLabel,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: ReactNode
  ariaLabel?: string
}) {
  const switchEl = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${
        checked ? 'bg-emerald-500' : 'bg-slate-300'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
          checked ? 'translate-x-4' : 'translate-x-1'
        }`}
      />
    </button>
  )

  if (!label) return switchEl

  return (
    <label className="flex cursor-pointer items-center gap-3 text-sm text-slate-700">
      {switchEl}
      {label}
    </label>
  )
}

// -----------------------------------------------------------------------------
// Card
// -----------------------------------------------------------------------------

/** The white bordered panel used throughout for sections, lists and detail views. */
export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`rounded-lg border border-slate-200 bg-white p-5 ${className}`}>
      {children}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Modal
// -----------------------------------------------------------------------------

/**
 * The centered-panel-over-backdrop shell used by every dialog (source form,
 * delete confirmation, etc). Backdrop click and the panel's own click-stop are
 * built in, so call sites only supply the panel content.
 */
export function Modal({
  onClose,
  children,
  wide = false,
}: {
  onClose: () => void
  children: ReactNode
  /** Delete-confirmation-style dialogs are narrower (max-w-lg); wide covers larger forms. */
  wide?: boolean
}) {
  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 px-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full rounded-lg bg-white p-6 shadow-xl ${wide ? 'max-w-2xl' : 'max-w-lg'}`}
      >
        {children}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Table
// -----------------------------------------------------------------------------

/**
 * The bordered/rounded table wrapper shared by Sources and Posts. Renders only
 * the outer div — callers put their own <table> (via THead/TBody below) plus
 * anything else, like Posts' below-table empty state, as siblings inside it.
 */
export function TableShell({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`overflow-x-auto rounded-lg border border-slate-200 bg-white ${className}`}>
      {children}
    </div>
  )
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
      <tr>{children}</tr>
    </thead>
  )
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <th className={`px-4 py-3 font-medium ${className}`}>{children}</th>
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-slate-100">{children}</tbody>
}

// -----------------------------------------------------------------------------
// Field
// -----------------------------------------------------------------------------

/** Label + control wrapper for form fields. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      {children}
    </label>
  )
}

const inputClass = 'w-full rounded-md border border-slate-300 px-3 py-2'

/** A plain text input matching Field's expected styling, for the common case of a bare TextField. */
export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} />
}

// -----------------------------------------------------------------------------
// TabSwitch
// -----------------------------------------------------------------------------

/** The segmented control used by Review and Export to switch between tabs. */
export function TabSwitch<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: readonly (readonly [T, string])[]
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-slate-300 text-sm">
      {options.map(([key, label]) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-3 py-1.5 font-medium ${
            value === key
              ? 'bg-slate-900 text-white'
              : 'bg-white text-slate-600 hover:bg-slate-100'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
