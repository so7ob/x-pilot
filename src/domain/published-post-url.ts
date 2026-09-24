/**
 * Published-post URL contract (v1.13.2, Closes #67).
 *
 * The session log must record the permalink of the post THIS extension just
 * published — never an arbitrary status link that happens to sit in the page.
 * After a successful publish the DOM is full of status links from other
 * accounts (timeline, notifications, analytics upsell rows like
 * `/{user}/status/{id}/analytics`), so any "pick a link from the page"
 * strategy eventually records a foreign post.
 *
 * Extraction may therefore only trust post-publish signals, in strict
 * priority order:
 *   1. the post-publish toast link (X's own "View post" affordance),
 *   2. status permalinks that APPEARED after the publish click and are
 *      authored by the logged-in account (fresh-diff against a pre-click
 *      snapshot),
 *   3. the current page location when it is a permalink of the logged-in
 *      account or X's internal `/i/web/status/{id}` own-post redirect.
 * Anything else yields `undefined` — the UI already renders "published link
 * unavailable". An honest missing link always beats a wrong link.
 */

const STATUS_URL_PATTERN = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)(?:\/web)?\/status\/(\d+)(?:[/?#].*)?$/i;
const INTERNAL_SELF_AUTHOR = 'i';

export interface StatusUrlParts {
  author: string;
  statusId: string;
  /** True for X's internal `/i/web/status/{id}` own-post path shape. */
  internal?: boolean;
}

export function parseStatusUrl(href: unknown): StatusUrlParts | undefined {
  if (typeof href !== 'string') return undefined;
  const match = href.trim().match(STATUS_URL_PATTERN);
  if (!match) return undefined;
  try {
    return { author: decodeURIComponent(match[1]), statusId: match[2], internal: match[0].includes('/web/status/') };
  } catch {
    return { author: match[1], statusId: match[2], internal: match[0].includes('/web/status/') };
  }
}

/** Canonical `https://x.com/{author}/status/{id}` — strips `/analytics`, `/photo/1`, query and hash suffixes (keeps the internal `/i/web/status/{id}` shape intact). */
export function canonicalStatusUrl(href: unknown): string | undefined {
  const parts = parseStatusUrl(href);
  if (!parts) return undefined;
  return `https://x.com/${parts.author}${parts.internal ? '/web' : ''}/status/${parts.statusId}`;
}

function normalizeScreenName(screenName: string): string {
  return screenName.trim().replace(/^@/, '').toLowerCase();
}

/** True when the permalink is authored by the given logged-in account (case-insensitive, `@`-tolerant). */
export function isAuthoredBy(href: unknown, screenName?: string): boolean {
  const parts = parseStatusUrl(href);
  if (!parts || !screenName) return false;
  return parts.author.toLowerCase() === normalizeScreenName(screenName);
}

/** True when the permalink belongs to the logged-in account, or is X's internal own-post redirect (`/i/web/status/{id}`). */
export function isOwnPermalink(href: unknown, screenName?: string): boolean {
  const parts = parseStatusUrl(href);
  if (!parts) return false;
  if (parts.author.toLowerCase() === INTERNAL_SELF_AUTHOR) return true;
  return isAuthoredBy(href, screenName);
}

/** Engine-side shape guard: only a canonical x.com status permalink may be persisted in history. */
export function sanitizePublishedPostUrl(raw: unknown): string | undefined {
  return canonicalStatusUrl(raw);
}
