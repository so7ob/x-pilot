import type { ReactNode, ButtonHTMLAttributes, HTMLAttributes } from 'react';

export type IconName = 'play' | 'pause' | 'stop' | 'queue' | 'bank' | 'workspace' | 'settings' | 'analytics' | 'activity' | 'diagnostics' | 'search' | 'refresh' | 'more' | 'delete' | 'archive' | 'restore' | 'check' | 'warning' | 'error' | 'calendar' | 'clock' | 'chevron' | 'command' | 'download' | 'filter';

const paths: Record<IconName, string> = {
  play: 'M8 5v14l11-7-11-7Z', pause: 'M6 5h4v14H6zM14 5h4v14h-4z', stop: 'M6 6h12v12H6z',
  queue: 'M5 6h14M5 12h14M5 18h9', bank: 'M4 10 12 5l8 5M6 10v8m4-8v8m4-8v8m4-8v8M4 20h16', workspace: 'M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v6H4zM14 15h6v6h-6z',
  settings: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0-5v2m0 13v2M3.5 12h2m13 0h2M5.8 5.8l1.4 1.4m9.6 9.6 1.4 1.4m0-12.4-1.4 1.4M7.2 16.8l-1.4 1.4', analytics: 'M5 19V9m7 10V5m7 14v-7', activity: 'M4 12h3l2-6 4 12 2-6h5', diagnostics: 'M12 3 4 6v5c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-3Zm0 5v4m0 4h.01', search: 'm20 20-4.5-4.5M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Z', refresh: 'M20 11a8 8 0 0 0-14.7-4L3 10m0 0V5m0 5h5M4 13a8 8 0 0 0 14.7 4L21 14m0 0v5m0-5h-5', more: 'M5 12h.01M12 12h.01M19 12h.01', delete: 'M6 7h12m-9 0v11h6V7m-5-3h4l1 3H7l1-3Z', archive: 'M4 7h16v13H4zM3 4h18v3H3zM9 11h6', restore: 'M5 12a7 7 0 1 0 2-5m-2 0V3m0 4h4', check: 'm5 12 4 4L19 6', warning: 'M12 4 3 20h18L12 4Zm0 5v5m0 3h.01', error: 'M6 6l12 12M18 6 6 18', calendar: 'M6 3v3m12-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z', clock: 'M12 7v5l3 2m5-2a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z', chevron: 'm7 10 5 5 5-5', command: 'M9 9V6a3 3 0 1 0-3 3h3Zm0 0v6m0-6h6m-6 6v3a3 3 0 1 1-3-3h3Zm6-6V6a3 3 0 1 1 3 3h-3Zm0 0v6a3 3 0 1 0 3 3v-3h-3Z', download: 'M12 4v10m0 0 4-4m-4 4-4-4M5 19h14', filter: 'M4 5h16l-6 7v5l-4 2v-7L4 5Z'
};

export function Icon({ name, size = 18, label }: { name: IconName; size?: number; label?: string }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}><path d={paths[name]} /></svg>;
}

export function Button({ tone = 'secondary', size = 'md', icon, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'secondary' | 'danger' | 'ghost'; size?: 'sm' | 'md'; icon?: IconName }) {
  return <button className={`ui-button ui-button-${tone} ui-button-${size}`} {...props}>{icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}{children}</button>;
}

export function StatusBadge({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`ui-status ui-status-${status}`}>{children ?? status}</span>;
}

export function MetricCard({ label, value, hint, tone = 'neutral' }: { label: string; value: string | number; hint?: string; tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' }) {
  return <div className={`metric-card metric-${tone}`}><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>;
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const normalized = Math.max(0, Math.min(100, value));
  return <div className="progress-wrap" role="progressbar" aria-valuenow={normalized} aria-valuemin={0} aria-valuemax={100} aria-label={label}><div className="progress-track"><span style={{ width: `${normalized}%` }} /></div><strong>{Math.round(normalized)}%</strong></div>;
}

export function Card({ children, className = '', ...props }: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return <section className={`ui-card ${className}`} {...props}>{children}</section>;
}

export function EmptyState({ icon = 'queue', title, description, action }: { icon?: IconName; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={24} /></span><strong>{title}</strong><p>{description}</p>{action}</div>;
}
