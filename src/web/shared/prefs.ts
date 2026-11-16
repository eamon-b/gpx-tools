/**
 * Tool preferences. Every tool keeps its options under its own section of one
 * shared localStorage entry.
 */

export const PREFS_KEY = 'gpx-tools-prefs';

/**
 * Store one tool's section, leaving the others as they are.
 *
 * Never throws: this runs from `change` handlers, where a corrupt stored value
 * (overwritten with fresh prefs) or unavailable storage (private browsing,
 * quota) must not break the option the user just changed.
 */
export function savePrefs(section: string, value: unknown): void {
  try {
    let prefs: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        prefs = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupted stored prefs - overwrite with fresh values
    }
    prefs[section] = value;
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable: preferences simply do not persist.
  }
}
