import type { ContentInspection } from '../../domain/models';

const composerSelectors = [
  '[data-testid="tweetTextarea_0"]',
  '[contenteditable="true"][role="textbox"]',
  'div[role="textbox"][contenteditable="true"]',
  '[data-testid="tweetTextarea_0"] [contenteditable="true"]',
  // Defensive fallback: future composer markup may suffix the testid
  // (e.g. tweetTextarea_0_rich) — match any tweetTextarea-prefixed editor.
  'div[data-testid^="tweetTextarea"][contenteditable="true"]',
  'textarea[aria-label*="Post"]',
  'textarea[aria-label*="Tweet"]',
  'textarea[aria-label*="نص المنشور"]',
  'textarea[aria-label*="منشور"]',
  'textarea[placeholder*="Post"]',
  'textarea[placeholder*="Tweet"]',
  'textarea[placeholder*="منشور"]'
];

const publishTestIdPattern = /(?:tweet|post|publish).*button|button.*(?:tweet|post|publish)/iu;
const excludedLabelPattern = /(?:إضافة|الكل|رد|reply|add|cancel|إلغاء)/iu;
const publishLabelPattern = /^(?:نشر|نشر\s+المنشور|إرسال|post|tweet|publish|send)$/iu;
const dailyPostLimitPattern = /(?:لقد\s+وصلت\s+إلى\s+الحد\s+الأقصى\s+لعدد\s+المنشورات\s+اليومية|الحد\s+الأقصى\s+لعدد\s+المنشورات\s+اليومية|you(?:'|’)?ve\s+reached\s+(?:the\s+)?daily\s+(?:post|posts?)\s+limit|daily\s+post(?:ing)?\s+limit|subscribe\s+to\s+premium.*limit)/iu;

function findFirst(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element && isVisibleControl(element)) return element;
  }
  return null;
}

function readText(element: HTMLElement): string {
  return (element instanceof HTMLTextAreaElement ? element.value : element.innerText || element.textContent || '').trim();
}

export function normalizeControlLabel(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/gu, '')
    .replace(/\u0640/gu, '')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase();
}

export function isPublishButtonLabel(value: string): boolean {
  const label = normalizeControlLabel(value);
  return Boolean(label) && !excludedLabelPattern.test(label) && publishLabelPattern.test(label);
}

export function isDailyPostLimitMessage(value: string): boolean {
  return dailyPostLimitPattern.test(value.normalize('NFKC'));
}

function isVisibleControl(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = element.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? element.getClientRects().length > 0 : true;
}

function isEnabledControl(element: HTMLElement): boolean {
  return !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
}

function controlMetadata(element: HTMLElement): string {
  return [
    readText(element),
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('title') ?? '',
    element.getAttribute('data-testid') ?? ''
  ].filter(Boolean).join(' ');
}

function isPublishControl(element: HTMLElement): boolean {
  if (!isVisibleControl(element) || !isEnabledControl(element)) return false;
  const testId = element.getAttribute('data-testid') ?? '';
  if (publishTestIdPattern.test(testId) && !excludedLabelPattern.test(normalizeControlLabel(controlMetadata(element)))) return true;
  return isPublishButtonLabel(readText(element)) || isPublishButtonLabel(element.getAttribute('aria-label') ?? '') || isPublishButtonLabel(element.getAttribute('title') ?? '');
}

function findPostButton(): HTMLElement | null {
  const selected = findFirst(['[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]', 'button[data-testid*="tweetButton"]', 'button[aria-label="Post"]', 'button[aria-label="Tweet"]', 'button[aria-label="نشر"]', 'button[aria-label="غرد"]']);
  if (selected && isPublishControl(selected)) return selected;
  return Array.from(document.querySelectorAll<HTMLElement>('button,[role="button"],[data-testid*="tweetButton"],[data-testid*="postButton"]')).find(isPublishControl) ?? null;
}

export function inspect(): ContentInspection {
  const host = location.hostname.toLowerCase();
  if (!['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(host)) {
    return { ok: false, pageKind: 'UNKNOWN', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: 'WRONG_HOST' };
  }
  const body = document.body?.innerText?.toLocaleLowerCase() ?? '';
  if (location.pathname.startsWith('/i/flow/login') || body.includes('log in to x') || body.includes('تسجيل الدخول')) {
    return { ok: false, pageKind: 'LOGIN', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: 'NOT_LOGGED_IN' };
  }
  if (body.includes('captcha') || body.includes('challenge')) {
    return { ok: false, pageKind: 'CHALLENGE', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: 'CAPTCHA_OR_SECURITY_CHALLENGE' };
  }
  if (isDailyPostLimitMessage(body)) {
    return { ok: false, pageKind: 'X', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: 'X_DAILY_POST_LIMIT_REACHED', dailyPostLimitReached: true };
  }
  const composer = findFirst(composerSelectors);
  const postButton = findPostButton();
  const contentPresent = composer ? readText(composer).length > 0 : false;
  const postButtonEnabled = Boolean(postButton && isEnabledControl(postButton));
  const ok = Boolean(composer && contentPresent && postButton && postButtonEnabled);
  return { ok, pageKind: 'X', composerFound: Boolean(composer), contentPresent, postButtonFound: Boolean(postButton), postButtonEnabled, reason: ok ? undefined : 'PUBLISH_CONTROLS_NOT_READY', dailyPostLimitReached: false };
}

export function getPublishedPostUrl(): string | undefined {
  const statusLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
    .map((anchor) => anchor.href)
    .filter((href) => /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(href));
  const current = location.href.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i)?.[0];
  return statusLinks.at(-1) ?? current;
}

export function publish(): ContentInspection {
  const state = inspect();
  if (!state.ok) return state;
  const button = findPostButton();
  if (!button) return { ...state, ok: false, postButtonFound: false, reason: 'POST_BUTTON_NOT_FOUND' };
  button.click();
  return { ...state, ok: true };
}
