import { getLocale } from '../../i18n/index.ts';
import { translateForLocale } from '../../i18n/translate.ts';

export const errorTranslationKeys: Record<string, string> = {
  X_DAILY_POST_LIMIT_REACHED: 'errors.dailyPostLimitReached',
  LOGIN_REQUIRED: 'errors.loginRequired',
  PUBLISH_CONTROLS_NOT_READY: 'errors.publishControlsNotReady',
  INVALID_JSON: 'errors.invalidJson',
  BANK_IMPORT_INVALID: 'errors.bankImportInvalid',
  BANK_IMPORT_UNSUPPORTED_VERSION: 'errors.bankImportUnsupportedVersion',
  BANK_IMPORT_EMPTY: 'errors.bankImportEmpty',
  BANK_IMPORT_TOO_LARGE: 'errors.bankImportTooLarge',
  BANK_IMPORT_BANK_TOO_LARGE: 'errors.bankImportBankTooLarge',
  BANK_IMPORT_INVALID_URL: 'errors.bankImportInvalidUrl',
  BANK_IMPORT_INVALID_SNAPSHOT: 'errors.bankImportInvalidSnapshot',
  BANK_EXPORT_NOT_FOUND: 'errors.bankExportNotFound',
};

export function errorTranslationKey(message?: string): string | undefined {
  if (!message) return undefined;
  return Object.keys(errorTranslationKeys).find((code) => message.includes(code));
}

export function toUserFacingMessage(message?: string): string | undefined {
  if (!message) return message;
  const code = errorTranslationKey(message);
  return code ? message.replaceAll(code, translateForLocale(getLocale(), errorTranslationKeys[code])) : message;
}

export function getUserFacingMessage(message: string): string {
  return toUserFacingMessage(message) ?? message;
}
