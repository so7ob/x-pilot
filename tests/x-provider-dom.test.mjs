/**
 * X adapter DOM fixtures — drift guard for x.com markup.
 *
 * The adapter (src/content/providers/x-provider-adapter.ts) is the only
 * DOM-coupled publish component. These fixtures pin its behavior against
 * realistic X.com page shapes so selector drift is caught by the suite
 * instead of by failed publishing in the wild:
 *   - modern DraftEditor composer (testid on the contenteditable element)
 *   - wrapped variant (testid on a wrapper, contenteditable inside)
 *   - legacy textarea composers (EN + AR)
 *   - login / challenge / daily-limit / wrong-host classification
 *   - disabled, hidden, and excluded (add-post / reply) controls
 *   - published-post URL extraction and the exact click target of publish()
 *
 * jsdom has no layout engine, so getBoundingClientRect is patched to a
 * non-zero rect and visibility gating relies on the adapter's own
 * display/visibility/opacity checks (which jsdom resolves from inline styles).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { inspect, publish, getPublishedPostUrl } from '../src/content/providers/x-provider-adapter.ts';

function mount(bodyHtml, url = 'https://x.com/compose/post') {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, { url });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  // The adapter references these window constructors as bare identifiers.
  globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  globalThis.HTMLElement = dom.window.HTMLElement;
  // jsdom does not implement innerText; approximate it with textContent.
  // The adapter keeps using innerText (the correct browser API — it excludes
  // hidden elements), the shim only bridges the test environment.
  if (!('innerText' in dom.window.HTMLElement.prototype)) {
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent; },
    });
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 40, top: 0, left: 0, right: 120, bottom: 40, x: 0, y: 0, toJSON() {} };
  };
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return [dom.window.HTMLElement.prototype.getBoundingClientRect.call(this)];
  };
  return dom;
}

function unmount() {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.location;
}

const MODERN_COMPOSER = '<div aria-label="Compose post"><div class="DraftEditor-root"><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" spellcheck="false"><span data-text="true">Hello from X-Pilot</span></div></div><button data-testid="tweetButtonInline" type="button"><span>Post</span></button></div>';
const WRAPPED_COMPOSER = '<div><div data-testid="tweetTextarea_0"><div role="textbox" contenteditable="true"><span data-text="true">Wrapped content</span></div></div><button data-testid="tweetButtonInline" type="button"><span>Post</span></button></div>';
const AR_COMPOSER = '<div><textarea aria-label="نص المنشور" placeholder="منشور">محتوى عربي للنشر</textarea><button aria-label="نشر" type="button">نشر</button></div>';
const LEGACY_EN_COMPOSER = '<div><textarea aria-label="Post" placeholder="What is happening?">Legacy content</textarea><button aria-label="Post" type="button">Post</button></div>';
const EMPTY_COMPOSER = '<div><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div><button data-testid="tweetButtonInline" type="button"><span>Post</span></button></div>';
const DISABLED_BUTTON = '<div><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"><span>Ready content</span></div><button data-testid="tweetButtonInline" type="button" disabled><span>Post</span></button></div>';
const ARIA_DISABLED_BUTTON = DISABLED_BUTTON.replace('disabled><span>Post', 'aria-disabled="true"><span>Post');
const HIDDEN_COMPOSER = '<div><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" style="display: none;"><span>Hidden content</span></div><button data-testid="tweetButtonInline" type="button"><span>Post</span></button></div>';
const FADED_COMPOSER = '<div><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" style="opacity: 0;"><span>Faded content</span></div><button data-testid="tweetButtonInline" type="button"><span>Post</span></button></div>';
const ADD_POST_TRAP = '<div><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"><span>Thread content</span></div><button data-testid="addButton" type="button"><span>Add another post</span></button></div>';
const REPLY_BUTTON = '<div><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"><span>Reply content</span></div><button data-testid="tweetButtonInline" type="button" aria-label="Post your reply"><span>Post</span></button></div>';
const COMPOSER_NO_BUTTON = '<div><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"><span>Orphan content</span></div></div>';

test('modern EN compose page is publish-ready', () => {
  const dom = mount(MODERN_COMPOSER);
  try {
    const state = inspect();
    assert.equal(state.ok, true);
    assert.equal(state.pageKind, 'X');
    assert.equal(state.composerFound, true);
    assert.equal(state.contentPresent, true);
    assert.equal(state.postButtonFound, true);
    assert.equal(state.postButtonEnabled, true);
  } finally { unmount(); dom.window.close(); }
});

test('wrapped composer variant (testid on wrapper, editable inside) is recognized', () => {
  const dom = mount(WRAPPED_COMPOSER);
  try {
    const state = inspect();
    assert.equal(state.composerFound, true);
    assert.equal(state.contentPresent, true);
    assert.equal(state.ok, true);
  } finally { unmount(); dom.window.close(); }
});

test('suffixed composer testid variant is recognized by the defensive prefix selector', () => {
  const dom = mount(WRAPPED_COMPOSER.replace(/tweetTextarea_0/g, 'tweetTextarea_0_rich'));
  try {
    const state = inspect();
    assert.equal(state.composerFound, true);
    assert.equal(state.contentPresent, true);
    assert.equal(state.ok, true);
  } finally { unmount(); dom.window.close(); }
});

test('Arabic textarea composer with نشر button is publish-ready', () => {
  const dom = mount(AR_COMPOSER);
  try {
    const state = inspect();
    assert.equal(state.ok, true);
    assert.equal(state.composerFound, true);
    assert.equal(state.contentPresent, true);
  } finally { unmount(); dom.window.close(); }
});

test('legacy EN textarea composer is publish-ready', () => {
  const dom = mount(LEGACY_EN_COMPOSER);
  try {
    assert.equal(inspect().ok, true);
  } finally { unmount(); dom.window.close(); }
});

test('empty composer reports missing content without publishing readiness', () => {
  const dom = mount(EMPTY_COMPOSER);
  try {
    const state = inspect();
    assert.equal(state.ok, false);
    assert.equal(state.composerFound, true);
    assert.equal(state.contentPresent, false);
    assert.equal(state.reason, 'PUBLISH_CONTROLS_NOT_READY');
  } finally { unmount(); dom.window.close(); }
});

test('disabled post button blocks readiness (disabled attribute)', () => {
  const dom = mount(DISABLED_BUTTON);
  try {
    const state = inspect();
    assert.equal(state.ok, false);
    assert.equal(state.postButtonEnabled, false);
  } finally { unmount(); dom.window.close(); }
});

test('aria-disabled post button blocks readiness', () => {
  const dom = mount(ARIA_DISABLED_BUTTON);
  try {
    const state = inspect();
    assert.equal(state.ok, false);
    assert.equal(state.postButtonEnabled, false);
  } finally { unmount(); dom.window.close(); }
});

test('display:none composer is not detected', () => {
  const dom = mount(HIDDEN_COMPOSER);
  try {
    const state = inspect();
    assert.equal(state.composerFound, false);
    assert.equal(state.ok, false);
  } finally { unmount(); dom.window.close(); }
});

test('opacity:0 composer is not detected', () => {
  const dom = mount(FADED_COMPOSER);
  try {
    assert.equal(inspect().composerFound, false);
  } finally { unmount(); dom.window.close(); }
});

test('add-another-post control is never picked as the publish button', () => {
  const dom = mount(ADD_POST_TRAP);
  try {
    const state = inspect();
    assert.equal(state.postButtonFound, false);
    assert.equal(state.ok, false);
  } finally { unmount(); dom.window.close(); }
});

test('reply publish button (Post your reply) is recognized through its Post label', () => {
  const dom = mount(REPLY_BUTTON);
  try {
    const state = inspect();
    assert.equal(state.postButtonFound, true);
    assert.equal(state.ok, true);
  } finally { unmount(); dom.window.close(); }
});

test('composer content without any publish button is not ready', () => {
  const dom = mount(COMPOSER_NO_BUTTON);
  try {
    const state = inspect();
    assert.equal(state.composerFound, true);
    assert.equal(state.postButtonFound, false);
    assert.equal(state.ok, false);
  } finally { unmount(); dom.window.close(); }
});

test('English login wall is classified NOT_LOGGED_IN', () => {
  const dom = mount('<div role="main"><span>Log in to X to continue</span></div>');
  try {
    const state = inspect();
    assert.equal(state.ok, false);
    assert.equal(state.pageKind, 'LOGIN');
    assert.equal(state.reason, 'NOT_LOGGED_IN');
  } finally { unmount(); dom.window.close(); }
});

test('Arabic login wall (تسجيل الدخول) is classified NOT_LOGGED_IN', () => {
  const dom = mount('<div role="main"><span>سجّل الدخول — تسجيل الدخول إلى X</span></div>');
  try {
    const state = inspect();
    assert.equal(state.reason, 'NOT_LOGGED_IN');
    assert.equal(state.pageKind, 'LOGIN');
  } finally { unmount(); dom.window.close(); }
});

test('login flow path is classified NOT_LOGGED_IN even without body text', () => {
  const dom = mount('<div></div>', 'https://x.com/i/flow/login');
  try {
    const state = inspect();
    assert.equal(state.pageKind, 'LOGIN');
    assert.equal(state.reason, 'NOT_LOGGED_IN');
  } finally { unmount(); dom.window.close(); }
});

test('captcha page is classified CHALLENGE', () => {
  const dom = mount('<div><h1>Verify yourself</h1><p>Complete the captcha to continue.</p></div>');
  try {
    const state = inspect();
    assert.equal(state.pageKind, 'CHALLENGE');
    assert.equal(state.reason, 'CAPTCHA_OR_SECURITY_CHALLENGE');
  } finally { unmount(); dom.window.close(); }
});

test('English daily post limit message is detected as a limit stop', () => {
  const dom = mount('<div><span>You’ve reached the daily post limit. Subscribe to Premium for higher limits.</span></div>');
  try {
    const state = inspect();
    assert.equal(state.ok, false);
    assert.equal(state.reason, 'X_DAILY_POST_LIMIT_REACHED');
    assert.equal(state.dailyPostLimitReached, true);
  } finally { unmount(); dom.window.close(); }
});

test('Arabic daily post limit message is detected as a limit stop', () => {
  const dom = mount('<div><span>لقد وصلت إلى الحد الأقصى لعدد المنشورات اليومية. اشترك في Premium للحصول على حدود أعلى.</span></div>');
  try {
    const state = inspect();
    assert.equal(state.reason, 'X_DAILY_POST_LIMIT_REACHED');
    assert.equal(state.dailyPostLimitReached, true);
  } finally { unmount(); dom.window.close(); }
});

test('non-X hosts are rejected without page inspection', () => {
  const dom = mount(MODERN_COMPOSER, 'https://example.com/compose/post');
  try {
    const state = inspect();
    assert.equal(state.ok, false);
    assert.equal(state.pageKind, 'UNKNOWN');
    assert.equal(state.reason, 'WRONG_HOST');
  } finally { unmount(); dom.window.close(); }
});

test('legacy twitter.com host is accepted', () => {
  const dom = mount(MODERN_COMPOSER, 'https://twitter.com/compose/post');
  try {
    assert.equal(inspect().pageKind, 'X');
  } finally { unmount(); dom.window.close(); }
});

test('publish() clicks exactly the publish button on a ready page', () => {
  const dom = mount(MODERN_COMPOSER);
  try {
    let clicks = 0;
    dom.window.document.querySelector('[data-testid="tweetButtonInline"]').addEventListener('click', () => { clicks += 1; });
    const state = publish();
    assert.equal(state.ok, true);
    assert.equal(clicks, 1);
  } finally { unmount(); dom.window.close(); }
});

test('publish() never clicks when the page is not ready', () => {
  const dom = mount(ADD_POST_TRAP);
  try {
    let clicks = 0;
    dom.window.document.body.addEventListener('click', () => { clicks += 1; });
    const state = publish();
    assert.equal(state.ok, false);
    assert.equal(clicks, 0);
  } finally { unmount(); dom.window.close(); }
});

test('getPublishedPostUrl prefers the newest status anchor', () => {
  const dom = mount('<a href="https://x.com/alice/status/111">1</a><a href="https://x.com/alice/status/222">2</a><a href="https://x.com/alice/other">x</a>', 'https://x.com/home');
  try {
    assert.equal(getPublishedPostUrl(), 'https://x.com/alice/status/222');
  } finally { unmount(); dom.window.close(); }
});

test('getPublishedPostUrl falls back to the current status URL', () => {
  const dom = mount('<div>no anchors here</div>', 'https://x.com/bob/status/333');
  try {
    assert.equal(getPublishedPostUrl(), 'https://x.com/bob/status/333');
  } finally { unmount(); dom.window.close(); }
});

test('getPublishedPostUrl returns undefined off a status context', () => {
  const dom = mount('<a href="https://cdn.x.com/media/1">ad</a>', 'https://x.com/home');
  try {
    assert.equal(getPublishedPostUrl(), undefined);
  } finally { unmount(); dom.window.close(); }
});
