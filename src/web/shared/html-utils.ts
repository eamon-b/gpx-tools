/**
 * Shared HTML utilities for web tools
 */

/**
 * Escape a string for safe interpolation into HTML markup
 * (e.g. user-supplied filenames or track names rendered via innerHTML)
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
