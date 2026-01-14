import React, { JSX } from 'react';
import './Hero.css';
import { fetchStatus, StatusResponse } from '../services/statusApi';

type StatusTone = 'success' | 'warn' | 'error' | 'muted';
const APP_TITLE = 'lox-audioserver';

export default function Hero(): JSX.Element {
  const [info, setInfo] = React.useState<StatusResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const controller = new AbortController();

    const load = async () => {
      try {
        const status = await fetchStatus(controller.signal);
        if (cancelled) return;
        setInfo(status);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled && typeof window !== 'undefined') {
          timer = window.setTimeout(load, 5000);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const status = React.useMemo((): { label: string; tone: StatusTone } => {
    if (error) return { label: 'Unavailable', tone: 'error' };
    if (!info) return { label: 'Connecting…', tone: 'warn' };
    if (info.paired) return { label: 'Paired', tone: 'success' };
    return { label: 'Awaiting pairing', tone: 'warn' };
  }, [error, info]);

  const version = info?.version ?? null;
  const uptime = formatUptime(info?.uptime);
  const name = info?.name ?? 'Unconfigured';
  const zoneCount = typeof info?.zones === 'number' ? info.zones : null;
  const firmwareVersion = info?.firmwareVersion ?? '—';
  const heroMetaLines: Array<{ label: string; value: string }> = [
    { label: 'Name', value: name },
    { label: 'Emulated firmware', value: firmwareVersion },
  ];
  if (uptime) heroMetaLines.push({ label: 'Uptime', value: uptime });
  if (zoneCount !== null) {
    heroMetaLines.push({ label: 'Zones', value: `${zoneCount}` });
  }

  return (
    <div className="hero-content">
      <div className="hero-info">
        <div className="hero-heading">
          <h1>
            {APP_TITLE}
            <span className="hero-version">{version ? `v${version}` : 'Development build'}</span>
          </h1>
        </div>

        <div className="hero-meta-grid">
          {heroMetaLines.map((item, index) => (
            <div className="hero-meta-block" key={`${item.label}-${index}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
          <div className={`hero-meta-block hero-meta-block--status hero-meta-block--${status.tone}`}>
            <dt>Status</dt>
            <dd>{status.label}</dd>
          </div>
        </div>

        {error && <div className="hero-error">Status error: {error}</div>}
      </div>

    </div>
  );
}

function formatUptime(seconds?: number): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const totalSeconds = Math.floor(seconds);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

  return parts.slice(0, 2).join(' ');
}
