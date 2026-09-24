import type { Dispatch, SetStateAction } from 'react';
import type { AppState, PreflightResult, QueueItem, RuntimeMessage, Settings } from '../../domain/models';
import { formatDateTime } from '../../i18n';
import { MetricCard, ProgressBar } from '../components';
import { CurrentTweetCard, MissedScheduleCard, RecoveryCard } from '../components/operation-cards';
import { detectMissedSchedule } from '../../domain/recovery';
import { useI18n } from '../../i18n';

export interface OperationTabProps {
  state: AppState;
  session: AppState['session'];
  currentItem?: QueueItem;
  logoUrl: string;
  activeWorkspaceName?: string;
  published: number;
  failed: number;
  remaining: number;
  progress: number;
  countdownSeconds: number;
  nowMs: number;
  canPause: boolean;
  canResume: boolean;
  preflight: PreflightResult | null;
  settings: Settings;
  scheduleAt: string;
  setScheduleAt: Dispatch<SetStateAction<string>>;
  start: () => void;
  stop: () => void;
  schedule: (reschedule?: boolean) => void;
  act: (message: RuntimeMessage, success?: string) => void;
}

export function OperationTab({ state, session, currentItem, logoUrl, activeWorkspaceName, published, failed, remaining, progress, countdownSeconds, nowMs, canPause, canResume, preflight, settings, scheduleAt, setScheduleAt, start, stop, schedule, act }: OperationTabProps) {
  const { t } = useI18n();
  const startOverFromRecovery = async () => { if (!window.confirm(t('recovery.confirmStartOver', { count: failed }))) return; await act({ type: 'RECOVERY_START_OVER' }, t('recovery.startedOver')); };
  const cancelRecoverySession = async () => { await act({ type: 'STOP' }, t('notifications.stopped')); };
  return <section className="tab-panel" role="tabpanel" aria-label={t('nav.operation')}>
    <section className="card operation-hero"><div className="hero-copy"><span className="eyebrow">{t('common.publishingControlCenter')}</span><h2>{t('operation.title')}</h2><p>{activeWorkspaceName ?? t('ui.undefined')} · {session?.status === 'RUNNING' ? t('operation.engineRunning') : t('operation.readyToRun')}</p></div><div className="hero-metric"><strong>{published}<small>/{state.queue.length}</small></strong><span>{t('operation.published')}</span></div><ProgressBar value={progress} label={t('operation.published')} /><div className="stats compact-stats"><MetricCard label={t('operation.remaining')} value={remaining} tone="primary" /><MetricCard label={t('operation.failed')} value={failed} tone={failed ? 'danger' : 'neutral'} /><MetricCard label={t('operation.skipped')} value={state.queue.filter((item) => item.status === 'SKIPPED').length} /></div>{session?.status === 'SCHEDULED' && session.scheduledStartAt && <div className="countdown dashboard-countdown"><span>{t('operation.startAt')}</span><strong>{formatDateTime(session.scheduledStartAt)}</strong></div>}{session?.status === 'WAITING' && <div className="countdown dashboard-countdown"><span>{t('operation.nextTweetAfter')}</span><strong>{formatCountdown(countdownSeconds)}</strong></div>}</section>
    <CurrentTweetCard item={currentItem} position={session?.currentIndex} logoUrl={logoUrl} />
    {session?.status === 'PAUSED' && remaining > 0 && <RecoveryCard logoUrl={logoUrl} failedCount={failed} onResume={() => void act({ type: 'RESUME' }, t('operation.resumed'))} onStartOver={() => void startOverFromRecovery()} onCancel={() => void cancelRecoverySession()} />}
    {session?.status === 'SCHEDULED' && detectMissedSchedule(session, nowMs) && <MissedScheduleCard logoUrl={logoUrl} scheduledAt={session.scheduledStartAt ?? nowMs} onStartNow={() => void act({ type: 'START_SCHEDULED_NOW' }, t('recovery.startedNow'))} onCancelSchedule={() => void act({ type: 'CANCEL_SCHEDULE' }, t('notifications.cancelled'))} />}
    <section className="card controls"><h2>{t('nav.operation')}</h2><div className="row controls-row"><button className="primary" onClick={start} disabled={!state.queue.length || canPause || canResume || session?.status === 'SCHEDULED' || preflight === null || !preflight.ready}>{t('actions.start')}</button><button onClick={() => void act({ type: 'PAUSE' }, t('operation.paused'))} disabled={!canPause}>{t('actions.pause')}</button><button onClick={() => void act({ type: 'RESUME' }, t('operation.resumed'))} disabled={!canResume}>{t('actions.resume')}</button><button className="danger" onClick={stop} disabled={!session || session.status === 'STOPPED' || session.status === 'COMPLETED'}>{session?.status === 'SCHEDULED' ? t('ui.cancelSchedule') : t('ui.stop')}</button></div><div className="schedule-controls"><label>{t('ui.startAt')}<input type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} /></label><div className="row controls-row"><button onClick={() => schedule(false)} disabled={!state.queue.length || !scheduleAt || canPause || canResume}>{t('ui.schedule')}</button><button onClick={() => schedule(true)} disabled={session?.status !== 'SCHEDULED' || !scheduleAt}>{t('ui.reschedule')}</button></div></div><p className="muted">{t('ui.currentItem')}: {session?.currentItemId ? currentItem?.position ?? '-' : '-'}</p>{session?.status === 'PAUSED' && <p className="paused-hint">{t('operation.pausedHint')}</p>}</section>
  </section>;
}

function formatCountdown(totalSeconds: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
