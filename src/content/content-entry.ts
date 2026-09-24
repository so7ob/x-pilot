import { getPublishedPostUrl, inspect, publish } from './providers/x-provider-adapter';

const listenerKey = '__xPilotContentListenerInstalled';
const contentGlobal = globalThis as typeof globalThis & Record<string, unknown>;

if (!contentGlobal[listenerKey]) {
  contentGlobal[listenerKey] = true;
  chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
    if (message.type === 'X_INSPECT') {
      sendResponse(inspect());
      return true;
    }
    if (message.type === 'X_PUBLISH') {
      sendResponse(publish());
      return true;
    }
    if (message.type === 'X_GET_PUBLISHED_URL') {
      sendResponse({ publishedPostUrl: getPublishedPostUrl() });
      return true;
    }
    return false;
  });
}
