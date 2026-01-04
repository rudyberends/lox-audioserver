import React from 'react';
import './SetupView.css';
import { fetchStatus, StatusResponse } from '../services/statusApi';
import { clearServerConfig, getConfig, importServerConfig, reinitializeServer } from '../services/setupApi';

interface SetupConfig {
  config: {
    miniserver?: {
      ip?: string;
      serial?: string;
    };
    audioserver?: {
      paired?: boolean;
    };
    zones?: unknown[];
    adapters?: unknown[];
  };
}

export default function SetupView(): JSX.Element {
  const [data, setData] = React.useState<SetupConfig | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = React.useState(true);
  const [restarting, setRestarting] = React.useState(false);

  React.useEffect(() => {
    getConfig()
      .then((cfg) => setData(cfg as SetupConfig))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const load = async () => {
      try {
        const info = await fetchStatus(controller.signal);
        if (!cancelled) setStatus(info);
      } catch {
        // ignore; setup tab can still show config data
      } finally {
        if (!cancelled) {
          setStatusLoading(false);
          if (typeof window !== 'undefined') {
            timer = window.setTimeout(load, 5000);
          }
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

  // Keep polling pairing state until paired (mirrors legacy behaviour).
  React.useEffect(() => {
    if (!data || typeof window === 'undefined') return;
    const isPaired = Boolean(data.config?.audioserver?.paired);
    if (isPaired) return;

    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      if (cancelled) return;
      try {
        const cfg = (await getConfig()) as SetupConfig;
        if (cancelled) return;
        setData(cfg);
        const nowPaired = Boolean(cfg.config?.audioserver?.paired);
        if (!nowPaired) {
          timer = window.setTimeout(poll, 5000);
        }
      } catch {
        if (!cancelled) {
          timer = window.setTimeout(poll, 10000);
        }
      }
    };

    timer = window.setTimeout(poll, 5000);

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [data]);

  // Sync config when pairing state changes (from status endpoint)
  React.useEffect(() => {
    if (!status) return;
    const statusPaired = Boolean(status.paired);
    const configPaired = Boolean((data as any)?.config?.audioserver?.paired);
    if (statusPaired === configPaired) return;

    let cancelled = false;
    const refresh = async () => {
      try {
        const fresh = (await getConfig()) as SetupConfig;
        if (!cancelled) setData(fresh);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [status, data]);

  if (loading) {
    return (
      <div className="setup-layout">
        <div className="setup-shell setup-shell--placeholder">
          <p className="setup-loading">Loading configuration…</p>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="setup-layout">
        <div className="setup-shell setup-shell--placeholder">
          <p className="setup-error">{error}</p>
        </div>
      </div>
    );
  }

  const cfg = data?.config ?? {};
  const system = (cfg as any).system ?? {};
  const miniserver = system.miniserver ?? {};
  const audioserver = system.audioserver ?? {};
  const zones = Array.isArray((cfg as any).zones) ? (cfg as any).zones : [];
  const miniserverIp = miniserver.ip ?? '—';
  const miniserverSerial = miniserver.serial ?? '—';
  const audioServerSerial = audioserver.macId ?? status?.serial ?? '—';
  const lastUpdatedRaw = (cfg as any).updatedAt ?? status?.timestamp ?? null;
  const lastUpdated = formatTimestamp(lastUpdatedRaw);
  const configCrc =
    (cfg as any).crc32 ??
    (cfg as any).rawAudioConfig?.crc32 ??
    null;

  const isPaired = Boolean(status?.paired);
  const zoneCount = zones.length;

  const getPrimaryTransport = (zone: any): any => {
    if (!zone) return null;
    if (zone.transport) return zone.transport;
    if (Array.isArray(zone.transports) && zone.transports.length > 0) {
      return zone.transports[0];
    }
    return null;
  };

  const hasAdapters = zones.some((zone: any) => Boolean(getPrimaryTransport(zone)));
  const hasUnassignedZones = zones.some((zone: any) => !getPrimaryTransport(zone));
  const unassignedCount = zones.filter((zone: any) => !getPrimaryTransport(zone)).length;
  const configuredCount = zones.filter((zone: any) => Boolean(getPrimaryTransport(zone))).length;

  function formatTimestamp(value: string | null | undefined): string | null {
    if (!value || typeof value !== 'string') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString();
  }

  return (
    <div className="setup-layout">
      <section className="setup-shell">
            <header className="setup-header">
              <div>
                <p className="page-hero__eyebrow">AudioServer setup</p>
                <h1 className="page-hero__title">Setup</h1>
                <p className="page-hero__subtitle">
                  {isPaired
                    ? 'Paired and ready — review the checklist to confirm zones and adapters are mapped.'
                    : 'Follow these steps to get paired and start using the AudioServer.'}
                </p>
              </div>
          <div className="setup-metrics setup-metrics--hero">
            <div className="setup-metric">
              <p className="setup-metric__label">Miniserver IP</p>
              <p className="setup-metric__value">{miniserverIp}</p>
              <p className="setup-metric__hint">Detected during pairing</p>
            </div>
            <div className="setup-metric">
              <p className="setup-metric__label">Miniserver serial</p>
              <p className="setup-metric__value">{miniserverSerial}</p>
              <p className="setup-metric__hint">Synced from project</p>
            </div>
            <div className="setup-metric">
              <p className="setup-metric__label">Zones</p>
              <p className="setup-metric__value">{zoneCount}</p>
              <p className="setup-metric__hint">Configured in Loxone</p>
            </div>
            <div className="setup-metric">
              <p className="setup-metric__label">Assigned outputs</p>
              <p className="setup-metric__value">{configuredCount}</p>
              <p className="setup-metric__hint">{unassignedCount > 0 ? `${unassignedCount} need outputs` : 'All routed'}</p>
            </div>
          </div>
        </header>

        <div className="setup-grid">
          <div className="setup-column">
            <article className="setup-card">
              <header>
                <div>
                  <h3>Last config update</h3>
                  <p>Most recent config payload pushed by the Miniserver.</p>
                </div>
                <div className="setup-pill">
                  <span className="pill-label">Pairing state</span>
                  {statusLoading ? (
                    <span className="pill pill-warn">Loading…</span>
                  ) : (
                    <span className={`pill ${isPaired ? 'pill-success' : 'pill-warn'}`}>
                      {isPaired ? 'Paired' : 'Awaiting pairing'}
                    </span>
                  )}
                </div>
              </header>
              <div className="setup-detail">
                <span className="setup-detail__label">Updated</span>
                <span className="setup-detail__value">{lastUpdated ?? 'Not available'}</span>
              </div>
              <div className="setup-detail">
                <span className="setup-detail__label">Config CRC</span>
                <span className="setup-detail__value">{configCrc ?? 'Not available'}</span>
              </div>
            </article>

            <article className="setup-card">
              <header>
                <h3>AudioServer config</h3>
              </header>
              <div className="setup-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    try {
                      const fresh = (await getConfig()) as SetupConfig;
                      const payload = fresh.config ?? {};
                      const json = JSON.stringify(payload, null, 2);
                      const blob = new Blob([json], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement('a');
                      link.href = url;
                      link.download = 'lox-audioserver-config.json';
                      document.body.appendChild(link);
                      link.click();
                      document.body.removeChild(link);
                      URL.revokeObjectURL(url);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                >
                  Export
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={async () => {
                    const ok = window.confirm?.(
                      'This will reset the configuration to defaults. Continue?',
                    );
                    if (ok === false) return;
                    try {
                      await clearServerConfig();
                      const fresh = (await getConfig()) as SetupConfig;
                      setData(fresh);
                    } catch (err) {
                      setError(String(err));
                    }
                  }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={async () => {
                    try {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = 'application/json,.json';
                      input.onchange = async () => {
                        const file = input.files && input.files[0];
                        if (!file) return;
                        try {
                          const text = await file.text();
                          const json = JSON.parse(text);
                          await importServerConfig(json);
                          const fresh = (await getConfig()) as SetupConfig;
                          setData(fresh);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err));
                        }
                      };
                      input.click();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                >
                  Import
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={restarting}
                  onClick={async () => {
                    setRestarting(true);
                    try {
                      await reinitializeServer();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setRestarting(false);
                    }
                  }}
                >
                  {restarting ? 'Reinitializing…' : 'Reinitialize services'}
                </button>
              </div>
            </article>
          </div>

          <article className="setup-card pairing">
            {isPaired ? (
              <div className="paired-tiles">
                <div className="paired-tile">
                  <h3>Paired and ready</h3>
                  <p>Your AudioServer is paired. Use the tabs above to configure adapters, zones, and content.</p>
                </div>
              </div>
            ) : (
              <>
                <header>
                  <h3>Pairing setup</h3>
                  <p>
                    The Miniserver will initiate pairing automatically after rebooting with your updated project.
                  </p>
                </header>
                <ol className="pairing-steps">
                  <RequiredStep
                    title="Add an Audio Server in Loxone Config"
                    description={
                      <>
                        Use this AudioServer serial: {audioServerSerial}.
                      </>
                    }
                  />
                  <RequiredStep
                    title="Configure audio zones"
                    description="Drop the AudioServer outputs into your project. You start with two stereo outputs but can split them for more zones."
                  />
                  <RequiredStep
                    title="Deploy changes"
                    description="Save changes and let the Miniserver reboot. Pairing starts automatically once it boots with the updated project."
                  />
                </ol>
                <footer className="setup-footer">
                </footer>
              </>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}

function PairingStep({
  title,
  description,
  complete,
  pendingLabel = 'Pending',
}: {
  title: string;
  description: React.ReactNode;
  complete: boolean;
  pendingLabel?: string;
}): JSX.Element {
  return (
    <li className={complete ? 'pairing-step-complete' : 'pairing-step-pending'}>
      <span className="pairing-step-indicator" aria-hidden="true" />
      <div className="pairing-step-content">
        <div className="pairing-step-heading">
          <strong>{title}</strong>
          <span className={`pairing-step-status ${complete ? 'complete' : 'pending'}`}>
            {complete ? 'Complete' : pendingLabel}
          </span>
        </div>
        <span className="pairing-step-description">{description}</span>
      </div>
    </li>
  );
}

function RequiredStep({
  title,
  description,
}: {
  title: string;
  description: React.ReactNode;
}): JSX.Element {
  return (
    <li className="pairing-step-required">
      <span className="pairing-step-indicator" aria-hidden="true" />
      <div className="pairing-step-content">
        <div className="pairing-step-heading">
          <strong>{title}</strong>
          <span className="pairing-step-status required">Required</span>
        </div>
        <span className="pairing-step-description">{description}</span>
      </div>
    </li>
  );
}
