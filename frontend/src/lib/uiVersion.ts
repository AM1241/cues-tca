/**
 * Which set of screens to show. The new layout (journey) is the default; the
 * classic screens stay available, unchanged, one click away — the operator
 * asked on 2026-11-17 that the old version not be thrown away. With
 * NEW_LAYOUT off (lib/features.ts) everyone gets the classic screens and the
 * choice is not offered at all.
 *
 * A per-viewer convenience, so browser storage is enough, guarded because it
 * can be unavailable.
 */
import { NEW_LAYOUT } from './features'

export type UiVersion = 'journey' | 'classic'

const KEY = 'cues.ui'

export function readUiVersion(): UiVersion {
  if (!NEW_LAYOUT) return 'classic'
  try {
    return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'journey'
  } catch {
    return 'journey'
  }
}

export function writeUiVersion(v: UiVersion) {
  try {
    localStorage.setItem(KEY, v)
  } catch {
    // storage unavailable — the choice holds for this visit only
  }
}
