import type { DiagnosticsResult } from '../../domain/models';
import { formatDateTime, useI18n } from '../../i18n';

const checkLabelKeys: Record<string, string> = {
  storage: 'diagnostics.storageCheck',
  'active-workspace': 'diagnostics.activeWorkspaceCheck',
  'automation-workspace': 'diagnostics.automationWorkspaceCheck',
  'running-session': 'diagnostics.runningSessionCheck',
  alarm: 'diagnostics.alarmCheck',
  'x-session': 'diagnostics.xSessionCheck',
  adapter: 'diagnostics.adapterCheck',
  composer: 'diagnostics.composerCheck',
  'post-button': 'diagnostics.postButtonCheck',
  permissions: 'diagnostics.permissionsCheck',
  'automation-tab': 'diagnostics.automationTabCheck',
};

function localizedDetail(details: string | undefined, t: (key: string, params?: Record<string, string | number>) => string): string | undefined {
  if (!details) return undefined;
  const schemaMatch = details.match(/^schemaVersion (.+)$/);
  if (schemaMatch) return t('diagnostics.schemaVersionDetail', { version: schemaMatch[1] });
  const permissionMatch = details.match(/^core=(true|false) x=(true|false)$/);
  if (permissionMatch) return t('diagnostics.permissionsDetail', { core: permissionMatch[1] === 'true' ? t('common.yes') : t('common.no'), x: permissionMatch[2] === 'true' ? t('common.yes') : t('common.no') });
  if (details === 'PUBLISH_CONTROLS_NOT_READY') return t('errors.publishControlsNotReady');
  if (details === 'DIAGNOSTICS_INSPECTION_FAILED') return t('diagnostics.inspectionFailed');
  if (details === 'ALARM_READ_FAILED') return t('diagnostics.alarmReadFailed');
  if (details === 'PERMISSIONS_READ_FAILED') return t('diagnostics.permissionsReadFailed');
  if (details === 'لا توجد Workspace نشطة') return t('diagnostics.noActiveWorkspace'); /* i18n-exempt: internal-code bridge — matches background diagnostic codes, renders t() only */
  if (details === 'لا يوجد Alarm مطلوب حاليًا') return t('diagnostics.noAlarmRequired'); /* i18n-exempt: internal-code bridge — matches background diagnostic codes, renders t() only */
  if (details === 'لا توجد جلسة أتمتة نشطة') return t('diagnostics.noAutomationSession'); /* i18n-exempt: internal-code bridge — matches background diagnostic codes, renders t() only */
  if (details === 'التبويب المسجل غير موجود') return t('diagnostics.registeredTabMissing'); /* i18n-exempt: internal-code bridge — matches background diagnostic codes, renders t() only */
  return details;
}

export function DiagnosticsTab({ result, onRun }: { result: DiagnosticsResult | null; onRun: () => void }) {
  const { t } = useI18n();
  return <section className="tab-panel diagnostics-panel" role="tabpanel" aria-label={t('nav.diagnostics')}><section className="card"><div className="section-heading"><div><span className="eyebrow">{t('diagnostics.title')}</span><h2>{t('diagnostics.title')}</h2></div><button className="primary" onClick={onRun}>{t('diagnostics.run')}</button></div><p className="muted">{t('diagnostics.readOnly')}</p></section>{result ? <><section className="card diagnostics-meta"><div><strong>{t('diagnostics.extensionVersion')}</strong><span>{result.extensionVersion}</span></div><div><strong>{t('diagnostics.storageSchema')}</strong><span>{result.schemaVersion}</span></div><div><strong>{t('diagnostics.activeWorkspace')}</strong><span>{result.activeWorkspaceId ?? t('common.none')}</span></div><div><strong>{t('diagnostics.automationWorkspace')}</strong><span>{result.automationWorkspaceId ?? t('common.none')}</span></div><div><strong>{t('diagnostics.runningSession')}</strong><span>{result.runningSession ? `${t(`statuses.${result.runningSession.status}`)} · ${result.runningSession.id.slice(0, 8)}` : t('diagnostics.noActiveSession')}</span></div><div><strong>{t('diagnostics.alarm')}</strong><span>{result.alarm?.name ?? t('common.none')}</span></div><div><strong>{t('diagnostics.automationTab')}</strong><span>{result.automationTabId ?? t('common.none')}</span></div></section><div className="diagnostics-checks">{result.checks.map((check) => { const detail = localizedDetail(check.details, t); return <article className={`diagnostics-check diagnostics-${check.status}`} key={check.id}><span className="diagnostics-check-icon">{check.status === 'OK' ? '✓' : check.status === 'FAIL' ? '×' : check.status === 'WARN' ? '!' : '?'}</span><div><strong>{t(check.labelKey ?? checkLabelKeys[check.id] ?? 'diagnostics.check')}</strong><small>{t(`statuses.${check.status}`)}{detail ? ` · ${detail}` : ''}</small></div></article>; })}</div><p className="diagnostics-safe">✓ {t('diagnostics.completed')} · {formatDateTime(result.checkedAt)}</p></> : <section className="card"><p className="muted">{t('diagnostics.pressRun')}</p></section>}</section>;
}
