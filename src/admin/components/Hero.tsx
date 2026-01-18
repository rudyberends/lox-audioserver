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
  const firmwareDisplay = firmwareVersion.includes('LWSS V ')
    ? firmwareVersion.split('LWSS V ')[1].trim()
    : firmwareVersion;
  const apiVersionRaw = info?.apiVersion ?? '—';
  const apiDisplay = apiVersionRaw.includes('API:')
    ? apiVersionRaw.split('API:')[1].replace(/[^0-9.]/g, '')
    : apiVersionRaw.replace(/[^0-9.]/g, '');
  const heroMetaLines: Array<{ label: string; value: string }> = [
    { label: 'Name', value: name },
    { label: 'Emulated firmware', value: firmwareDisplay },
    { label: 'API', value: apiDisplay || '—' },
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
            <a
              className="hero-github-badge"
              href="https://github.com/lox-audioserver/lox-audioserver"
              target="_blank"
              rel="noreferrer"
              aria-label="Open GitHub repository"
            >
              <svg className="hero-github-badge__icon" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 2a10 10 0 00-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.18-3.37-1.18a2.65 2.65 0 00-1.11-1.46c-.9-.62.07-.61.07-.61a2.1 2.1 0 011.53 1.03 2.12 2.12 0 002.9.83c.05-.5.27-.96.62-1.3-2.22-.25-4.56-1.11-4.56-4.95a3.88 3.88 0 011.03-2.7 3.6 3.6 0 01.1-2.67s.84-.27 2.75 1.02a9.4 9.4 0 015 0c1.9-1.29 2.74-1.02 2.74-1.02.36.87.4 1.84.1 2.67a3.88 3.88 0 011.03 2.7c0 3.85-2.35 4.7-4.58 4.95.36.32.68.94.68 1.9v2.82c0 .27.18.58.69.48A10 10 0 0012 2z"
                  fill="currentColor"
                />
              </svg>
              <span className="hero-github-badge__label">GitHub</span>
            </a>
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
