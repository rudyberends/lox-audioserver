import React from 'react';
import { createPortal } from 'react-dom';
import './ZonesView.css';
import { getConfig } from '../services/setupApi';
import { updateZones, purgeZoneFavorites, purgeZoneRecents } from '../services/zonesApi';
import {
  getTransportDefinitions,
  discoverAirplayDevices,
  discoverGoogleCastDevices,
  discoverSendspinClients,
  discoverSnapcastClients,
  discoverSpotifyDevices,
  discoverMusicAssistantPlayers,
  type AirplayDevice,
  type GoogleCastDevice,
  type SendspinClient,
  type SpotifyDevice,
  type MusicAssistantPlayer,
} from '../services/transportsApi';
import type { ZoneInputConfig, ZoneTransportConfig, SpotifyBridgeConfig } from '@/domain/config/types';
import type { TransportConfigDefinition } from '@/modules/audio/outputs/types';
import type { SpotifyAccountConfig } from '@/domain/config/types';

interface Zone {
  id: number;
  name: string;
  source?: string;
  sourceSerial?: string;
  sourceMac?: string;
  inputs?: ZoneInputConfig;
  transport?: ZoneTransportConfig | null;
  transports?: ZoneTransportConfig[];
}

type AudioServerExtension = {
  mac?: string;
  name?: string;
};

type AudioServerConfig = {
  macId?: string;
  name?: string;
  extensions?: AudioServerExtension[];
};

interface ConfigResponse {
  config?: {
    system?: {
      audioserver?: AudioServerConfig;
    };
    content?: {
      spotify?: {
        bridges?: SpotifyBridgeConfig[];
        accounts?: SpotifyAccountConfig[];
      };
    };
    zones?: Zone[];
  };
}

interface ZoneGroup {
  key: string;
  label: string;
  sourceSerial?: string;
  zones: Zone[];
}

interface ExtensionPlaceholder {
  index: number;
  serial: string;
  label: string;
}

export default function ZonesView(): JSX.Element {
  const [zoneGroups, setZoneGroups] = React.useState<ZoneGroup[]>([]);
  const [baseSerial, setBaseSerial] = React.useState<string>('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [extensionPlaceholders, setExtensionPlaceholders] = React.useState<ExtensionPlaceholder[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [activeZoneModal, setActiveZoneModal] = React.useState<{ zoneId: number; groupLabel?: string; type: 'output' | 'spotify' | 'musicassistant' } | null>(null);
  const [transportDefinitions, setTransportDefinitions] = React.useState<TransportConfigDefinition[]>([]);
  const [musicAssistantAvailable, setMusicAssistantAvailable] = React.useState(false);
  const [hasSpotifyAccounts, setHasSpotifyAccounts] = React.useState(false);
  const [spotifyDiscovery, setSpotifyDiscovery] = React.useState<Record<number, SpotifyDiscoveryState>>({});
  const [musicAssistantDiscovery, setMusicAssistantDiscovery] = React.useState<Record<number, MusicAssistantDiscoveryState>>({});
  const [maintenanceState, setMaintenanceState] = React.useState<Record<number, ZoneMaintenanceIndicator>>({});
  const [outputFilter, setOutputFilter] = React.useState<'all' | 'assigned' | 'unassigned'>('all');
  const modalOpen = Boolean(activeZoneModal);

  React.useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const [cfg, definitions] = await Promise.all([getConfig(), getTransportDefinitions()]);
        if (cancelled) return;
        const data = cfg as ConfigResponse;
        const rawZones = data.config?.zones ?? [];
        const spotifyAccounts = Array.isArray(data.config?.content?.spotify?.accounts)
          ? data.config?.content?.spotify?.accounts
          : [];
        const base = (data.config?.system?.audioserver?.macId ?? '').toUpperCase();
        const hasAccounts = spotifyAccounts.length > 0;
        setHasSpotifyAccounts(hasAccounts);
        setMusicAssistantAvailable(hasMusicAssistantBridge(data.config?.content?.spotify?.bridges ?? []));
        setBaseSerial(base);
        setTransportDefinitions(definitions);
        const sanitizedZones = rawZones.map((zone) => {
          const next: Zone = { ...zone };
          const inputs: ZoneInputConfig = { ...(zone.inputs ?? {}) };
          if (!hasAccounts) {
            inputs.spotify = { ...(inputs.spotify ?? {}), enabled: false, offload: false };
            if (inputs.spotify && 'deviceId' in inputs.spotify) {
              delete (inputs.spotify as any).deviceId;
            }
          }
          next.inputs = inputs;
          return next;
        });
        setZoneGroups(
          groupZones(
            sanitizedZones,
            buildSourceDirectory(data.config?.system?.audioserver),
            base,
          ),
        );
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    return () => {
      cancelled = true;
    };
  }, []);

  const displayGroups = React.useMemo(() => {
    const placeholders: ZoneGroup[] = extensionPlaceholders.map((ph) => ({
      key: `placeholder-${ph.index}`,
      label: ph.label,
      sourceSerial: ph.serial,
      zones: [],
    }));
    return [...zoneGroups, ...placeholders];
  }, [zoneGroups, extensionPlaceholders]);

  const filteredGroups = React.useMemo(() => {
    const groups: ZoneGroup[] = [];
    displayGroups.forEach((group) => {
      const zones = group.zones.filter((zone) => {
        const hasOutput = Boolean(getPrimaryTransport(zone));
        if (outputFilter === 'assigned') return hasOutput;
        if (outputFilter === 'unassigned') return !hasOutput;
        return true;
      });
      if (zones.length > 0 || group.zones.length === 0) {
        groups.push({ ...group, zones });
      }
    });
    return groups;
  }, [displayGroups, outputFilter]);

  const renderModal = React.useCallback(
    (node: React.ReactNode): React.ReactPortal | null => {
      if (typeof document === 'undefined') return null;
      return createPortal(node, document.body);
    },
    [],
  );

  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const className = 'modal-open';
    if (modalOpen) {
      document.body.classList.add(className);
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'auto' });
      }
    } else {
      document.body.classList.remove(className);
    }
    return () => {
      document.body.classList.remove(className);
    };
  }, [modalOpen]);

  const updateZoneMaintenance = React.useCallback((zoneId: number, patch: Partial<ZoneMaintenanceIndicator>) => {
    setMaintenanceState((prev) => ({
      ...prev,
      [zoneId]: {
        ...(prev[zoneId] ?? {}),
        ...patch,
      },
    }));
  }, []);

  const handleZoneFavoritesPurge = React.useCallback(
    async (zoneId: number) => {
      updateZoneMaintenance(zoneId, { favoritesPurge: true });
      try {
        await purgeZoneFavorites(zoneId);
      } catch (err) {
        window.alert?.(`Failed to purge favorites: ${String(err)}`);
      } finally {
        updateZoneMaintenance(zoneId, { favoritesPurge: false });
      }
    },
    [updateZoneMaintenance],
  );

  const handleZoneRecentsPurge = React.useCallback(
    async (zoneId: number) => {
      updateZoneMaintenance(zoneId, { recentsPurge: true });
      try {
        await purgeZoneRecents(zoneId);
      } catch (err) {
        window.alert?.(`Failed to purge recents: ${String(err)}`);
      } finally {
        updateZoneMaintenance(zoneId, { recentsPurge: false });
      }
    },
    [updateZoneMaintenance],
  );

  const totalZones = zoneGroups.reduce((sum, g) => sum + g.zones.length, 0);

  const MAX_EXTENSION_COUNT = 10;

  const extensionCount = React.useMemo(() => {
    const configured = zoneGroups.reduce((count, group) => {
      return extractExtensionIndex(group.label) ? count + 1 : count;
    }, 0);
    return configured + extensionPlaceholders.length;
  }, [zoneGroups, extensionPlaceholders]);

  const canAddExtension = Boolean(baseSerial) && extensionCount < MAX_EXTENSION_COUNT;

  function extractExtensionIndex(label: string | undefined): number | null {
    if (!label) return null;
    const match = label.match(/extension\s*(\d+)/i);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function computeExtensionSerial(base: string, index: number): string {
    if (!base) return '';
    const value = parseInt(base, 16);
    if (!Number.isFinite(value)) return '';
    const hex = (value + index).toString(16).toUpperCase();
    return hex.padStart(base.length, '0');
  }

  function formatSerial(serial?: string): string {
    if (!serial) return '';
    const compact = serial.replace(/[^0-9A-Fa-f]/g, '');
    return compact.replace(/(..)(?=.)/g, '$1:');
  }


  function handleAddExtension(): void {
    if (!canAddExtension) {
      if (!baseSerial) return;
      window.alert?.(`Maximum of ${MAX_EXTENSION_COUNT} extensions reached.`);
      return;
    }
    const indexes = new Set<number>();
    zoneGroups.forEach((g) => {
      const idx = extractExtensionIndex(g.label);
      if (idx && idx > 0) indexes.add(idx);
    });
    extensionPlaceholders.forEach((ph) => {
      if (ph.index && ph.index > 0) indexes.add(ph.index);
    });
    let highest = 0;
    indexes.forEach((v) => {
      if (v > highest) highest = v;
    });
    if (indexes.size >= MAX_EXTENSION_COUNT) {
      window.alert?.(`Maximum of ${MAX_EXTENSION_COUNT} extensions reached.`);
      return;
    }
    const next = highest + 1;
    const serial = computeExtensionSerial(baseSerial, next);
    setExtensionPlaceholders((prev) => [
      ...prev,
      { index: next, serial, label: `Stereo Extension ${next}` },
    ]);
  }

  const definitionMap = React.useMemo(() => {
    const map = new Map<string, TransportConfigDefinition>();
    transportDefinitions.forEach((def) => map.set(def.id, def));
    return map;
  }, [transportDefinitions]);

  const activeZoneInfo = React.useMemo(() => {
    if (!activeZoneModal) return null;
    for (const group of zoneGroups) {
      const zone = group.zones.find((z) => z.id === activeZoneModal.zoneId);
      if (zone) {
        return { zone, groupLabel: activeZoneModal.groupLabel ?? group.label };
      }
    }
    return null;
  }, [activeZoneModal, zoneGroups]);

  React.useEffect(() => {
    if (activeZoneModal && !activeZoneInfo) {
      setActiveZoneModal(null);
    }
  }, [activeZoneModal, activeZoneInfo]);

  function closeZoneModal(): void {
    setActiveZoneModal(null);
  }

  const handleTileInputToggle = React.useCallback(
    (zone: Zone, badge: InputBadge): void => {
      if (!badge.type || badge.disabled) return;
      const current = deriveZoneInputs(zone);
      if (badge.type === 'airplay') {
        current.airplay = { ...(current.airplay ?? {}), enabled: !badge.enabled };
      } else if (badge.type === 'spotify') {
        current.spotify = { ...(current.spotify ?? { publishName: zone.name }), enabled: !badge.enabled };
        if (!current.spotify.enabled) {
          current.spotify.offload = false;
          delete (current.spotify as Record<string, unknown>).deviceId;
        }
      } else if (badge.type === 'musicassistant') {
        current.musicassistant = {
          ...(current.musicassistant ?? { publishName: zone.name }),
          enabled: !badge.enabled,
        };
      }
      void handleInputChange(zone.id, current);
    },
    [handleInputChange],
  );

  async function handleSpotifyDiscovery(zoneId: number): Promise<void> {
    setSpotifyDiscovery((prev) => ({
      ...prev,
      [zoneId]: {
        devices: prev[zoneId]?.devices ?? [],
        loading: true,
        error: null,
      },
    }));
    try {
      const devices = await discoverSpotifyDevices();
      setSpotifyDiscovery((prev) => ({
        ...prev,
        [zoneId]: {
          devices,
          loading: false,
          error: devices.length ? null : 'No Spotify Connect devices found.',
        },
      }));
    } catch (err) {
      setSpotifyDiscovery((prev) => ({
        ...prev,
        [zoneId]: {
          devices: prev[zoneId]?.devices ?? [],
          loading: false,
          error: err instanceof Error ? err.message : 'Discovery failed',
        },
      }));
    }
  }

  function handleSpotifyOffloadToggle(zone: Zone, enabled: boolean): void {
    const next = deriveZoneInputs(zone);
    const base = next.spotify ?? { publishName: zone.name, enabled: true };
    const spotifyState: ZoneInputConfig['spotify'] = {
      ...base,
      enabled: true,
      offload: enabled,
    };
    if (!enabled) {
      delete (spotifyState as Record<string, unknown>).deviceId;
    }
    next.spotify = spotifyState ?? undefined;
    void handleInputChange(zone.id, next);
  }

  function handleSpotifyDeviceApply(zone: Zone, device: SpotifyDevice): void {
    if (!device.deviceId) return;
    const next = deriveZoneInputs(zone);
    next.spotify = {
      ...(next.spotify ?? { publishName: zone.name, enabled: true }),
      enabled: true,
      offload: true,
      deviceId: device.deviceId,
    };
    void handleInputChange(zone.id, next);
  }

  async function handleMusicAssistantDiscovery(zoneId: number): Promise<void> {
    setMusicAssistantDiscovery((prev) => ({
      ...prev,
      [zoneId]: {
        devices: prev[zoneId]?.devices ?? [],
        loading: true,
        error: null,
      },
    }));
    try {
      const devices = await discoverMusicAssistantPlayers();
      setMusicAssistantDiscovery((prev) => ({
        ...prev,
        [zoneId]: {
          devices,
          loading: false,
          error: devices.length ? null : 'No Music Assistant players found.',
        },
      }));
    } catch (err) {
      setMusicAssistantDiscovery((prev) => ({
        ...prev,
        [zoneId]: {
          devices: prev[zoneId]?.devices ?? [],
          loading: false,
          error: err instanceof Error ? err.message : 'Discovery failed',
        },
      }));
    }
  }

  function handleMusicAssistantOffloadToggle(zone: Zone, enabled: boolean): void {
    const next = deriveZoneInputs(zone);
    const base = next.musicassistant ?? { publishName: zone.name, enabled: true };
    next.musicassistant = { ...base, enabled: true, offload: enabled };
    if (!enabled) {
      delete (next.musicassistant as Record<string, unknown>).deviceId;
    }
    void handleInputChange(zone.id, next);
  }

  function handleMusicAssistantDeviceApply(zone: Zone, device: MusicAssistantPlayer): void {
    const deviceId = device.deviceId || device.id;
    if (!deviceId) return;
    const next = deriveZoneInputs(zone);
    next.musicassistant = {
      ...(next.musicassistant ?? { publishName: zone.name, enabled: true }),
      enabled: true,
      offload: true,
      deviceId,
    };
    void handleInputChange(zone.id, next);
  }

  async function handleInputChange(zoneId: number, inputs: ZoneInputConfig): Promise<void> {
    setSaving(true);
    try {
      setZoneGroups((prev) =>
        prev.map((group) => ({
          ...group,
          zones: group.zones.map((z) => (z.id === zoneId ? { ...z, inputs } : z)),
        })),
      );
      await updateZones([{ id: zoneId, inputs }]);
    } catch (err) {
      window.alert?.(`Failed to update inputs: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleTransportChange(zoneId: number, transport: ZoneTransportConfig | null): Promise<void> {
    setSaving(true);
    const transports = transport ? [transport] : [];
    try {
      setZoneGroups((prev) =>
        prev.map((group) => ({
          ...group,
          zones: group.zones.map((z) =>
            z.id === zoneId
              ? {
                  ...z,
                  transport,
                  transports,
                }
              : z,
          ),
        })),
      );
      await updateZones([{ id: zoneId, transports }]);
    } catch (err) {
      window.alert?.(`Failed to update outputs: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="zones-layout">
      <div className="zones-shell">
        <header className="zones-hero">
          <div>
            <p className="zones-hero__eyebrow page-hero__eyebrow">AudioServer zones</p>
            <h1 className="page-hero__title">Zones & outputs</h1>
            <p className="zones-hero__subtitle page-hero__subtitle">
              See every zone per source, toggle inputs, and assign outputs or extensions.
            </p>
          </div>
          <div className="zones-hero__actions">
            <div className="zones-filter-actions zones-filter-actions--hero">
              <button
                type="button"
                className={`chip-button${outputFilter === 'all' ? ' is-active' : ''}`}
                onClick={() => setOutputFilter('all')}
              >
                All
              </button>
              <button
                type="button"
                className={`chip-button${outputFilter === 'assigned' ? ' is-active' : ''}`}
                onClick={() => setOutputFilter('assigned')}
              >
                With output
              </button>
              <button
                type="button"
                className={`chip-button${outputFilter === 'unassigned' ? ' is-active' : ''}`}
                onClick={() => setOutputFilter('unassigned')}
              >
                Needs output
              </button>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={handleAddExtension}
              disabled={!canAddExtension}
            >
              Add extension
            </button>
          </div>
        </header>

        {loading && <p className="zones-loading">Loading zones…</p>}
        {error && <p className="zones-error">{error}</p>}

        {!loading && !error && (
          <div className="zones-grid">
            {filteredGroups.length === 0 && (
              <div className="zones-empty">
                <p className="zones-empty__title">No zones match this filter</p>
                <p className="zones-empty__text">
                  Try switching the output filter to see all zones or a different subset.
                </p>
              </div>
            )}
            {filteredGroups.map((group) => (
              <article key={group.key} className="zone-card">
                <header>
                  <div>
                    <p className="zone-source">{group.label || 'AudioServer'}</p>
                    <p className="zone-serial">{formatSerial(group.sourceSerial ?? baseSerial)}</p>
                  </div>
                  <div className="zone-count">
                    <span className="zone-count__value">{group.zones.length}</span>
                    <span className="zone-count__label">zones</span>
                  </div>
                </header>
                <ul>
                  {group.zones.length === 0 && (
                    <li className="zone-empty">No zones assigned yet</li>
                  )}
                  {group.zones.map((zone) => {
                    const zoneInputs = deriveZoneInputs(zone);
                    const inputBadges = buildInputBadges(zoneInputs, musicAssistantAvailable, hasSpotifyAccounts);
                    const primaryTransport = getPrimaryTransport(zone);
                    const outputsLabel = primaryTransport ? describeTransport(primaryTransport) : 'No output';
                    const outputType = primaryTransport
                      ? primaryTransport.id === 'googleCast' && (primaryTransport as any).useSendspin
                        ? 'Sendspin over Google Cast'
                      : definitionMap.get(primaryTransport.id ?? '')?.label ?? primaryTransport.id ?? 'Custom'
                      : 'Offload only';
                  const chips =
                    inputBadges.length > 0 ? inputBadges : [{ key: 'none', label: 'No inputs', muted: true, subtle: true }];
                  const spotifyConfig = zoneInputs.spotify ?? { publishName: zone.name, enabled: true };
                  const spotifyEnabled = spotifyConfig.enabled ?? false;
                  const spotifyOffloadEnabled = spotifyConfig.offload === true;
                  const selectedSpotifyDeviceId = spotifyConfig.deviceId ?? '';
                  const discoveryState = spotifyDiscovery[zone.id];
                  const spotifyDevices = discoveryState?.devices ?? [];
                  const selectedSpotifyDevice =
                    selectedSpotifyDeviceId && spotifyDevices.find((device) => device.deviceId === selectedSpotifyDeviceId);
                  const maConfig = zoneInputs.musicassistant ?? { enabled: true, publishName: zone.name, offload: false };
                  const maEnabled = maConfig.enabled ?? false;
                  const maOffloadEnabled = maConfig.offload === true;
                  const selectedMaDeviceId = maConfig.deviceId ?? '';
                  const maDiscovery = musicAssistantDiscovery[zone.id];
                  const maDevices = maDiscovery?.devices ?? [];
                  const selectedMaDevice =
                    selectedMaDeviceId &&
                    maDevices.find((device) => (device.deviceId || device.id) === selectedMaDeviceId);
                  let spotifyStatusLabel = hasSpotifyAccounts ? 'Spotify Connect disabled' : 'Spotify account required';
                  let spotifyStatusHint = hasSpotifyAccounts
                    ? 'Enable to publish this room as a Spotify client'
                    : 'Add a Spotify account first';
                  if (hasSpotifyAccounts && spotifyEnabled) {
                    if (spotifyOffloadEnabled) {
                      spotifyStatusLabel = selectedSpotifyDevice?.name ?? selectedSpotifyDeviceId ?? 'Select device';
                      spotifyStatusHint = 'Offloaded player';
                    } else {
                      spotifyStatusLabel = 'Internal player';
                      spotifyStatusHint = 'Internal player';
                    }
                  }
                  let maStatusLabel = 'Music Assistant disabled';
                  let maStatusHint = 'Not registered as a Music Assistant player';
                  if (maEnabled) {
                    if (maOffloadEnabled) {
                      maStatusLabel = selectedMaDevice?.name ?? selectedMaDeviceId ?? 'Select device';
                      maStatusHint = 'Offloaded player';
                    } else {
                      maStatusLabel = 'Internal player';
                      maStatusHint = 'Internal player';
                    }
                  }

                  const zoneOrigin = zone.source || group.label || 'AudioServer';
                  const maintenance = maintenanceState[zone.id] ?? {};
                  const hasWebPlayer =
                    Array.isArray(zone.transports) &&
                    zone.transports.some((transport) => {
                      const id = (transport?.id || '').toLowerCase();
                      const castSendspin = id === 'googlecast' && (transport as any)?.useSendspin;
                      const castSnapcast = id === 'googlecast' && (transport as any)?.useSnapcast;
                      return (
                        id === 'snapcast' ||
                        id === 'snapcast-cast' ||
                        id === 'sendspin' ||
                        id === 'sendspin-cast' ||
                        castSendspin ||
                        castSnapcast
                      );
                    });
                  return (
                    <li key={zone.id} className="zone-row">
                      <div className="zone-row__header">
                        <div className="zone-row__identity">
                          <div className="zone-title-stack">
                            <span className="zone-name">{zone.name}</span>
                            {zone.sourceSerial && (
                              <span className="zone-meta">{formatSerial(zone.sourceSerial)}</span>
                            )}
                          </div>
                        </div>
                        <span className="zone-id-plain">#{zone.id}</span>
                      </div>

                      <div className="zone-tile__split">
                        <div className="zone-section">
                          <div className="zone-section-head">
                            <p className="zone-section-label">Inputs</p>
                          </div>
                          <div className="zone-input-switches">
                            {chips.map((badge, index) => (
                              <div
                                key={badge.key}
                                className={`zone-input-switch${badge.disabled ? ' is-disabled' : ''}${
                                  index === chips.length - 1 ? ' zone-input-switch--last' : ''
                                }`}
                              >
                                <div className="zone-input-switch__row">
                                    <span className="zone-input-switch__label">{badge.label}</span>
                                    {badge.type ? (
                                      <label className="zone-switch zone-switch--compact">
                                        <input
                                          type="checkbox"
                                        checked={badge.enabled}
                                        disabled={saving || badge.disabled}
                                        onChange={() => handleTileInputToggle(zone, badge)}
                                        aria-label={`Toggle ${badge.label}`}
                                      />
                                      <span className="zone-switch-slider" />
                                    </label>
                                  ) : (
                                    <span className="zone-input-switch__status">{badge.label}</span>
                                  )}
                                </div>
                                {badge.type === 'spotify' && (
                                  <div className="zone-input-hint">
                                    <span>{spotifyStatusHint}</span>
                                    <button
                                      type="button"
                                      className="zone-link-button"
                                      onClick={() =>
                                        setActiveZoneModal({ zoneId: zone.id, groupLabel: group.label, type: 'spotify' })
                                      }
                                      disabled={badge.disabled || !badge.enabled}
                                    >
                                      Configure
                                    </button>
                                  </div>
                                )}
                                {badge.type === 'musicassistant' && (
                                  <div className="zone-input-hint">
                                    <span>{maStatusHint}</span>
                                    <button
                                      type="button"
                                      className="zone-link-button"
                                      onClick={() =>
                                        setActiveZoneModal({ zoneId: zone.id, groupLabel: group.label, type: 'musicassistant' })
                                      }
                                      disabled={!badge.enabled}
                                    >
                                      Configure
                                    </button>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="zone-divider" />
                        <div className="zone-section">
                          <div className="zone-section-head">
                            <p className="zone-section-label">Controller</p>
                          </div>
                          <div className="zone-output-row">
                            <div className="zone-controller-chip" title="Built-in controller manages volume and metadata">
                              <span className="zone-output-name">Internal Controller</span>
                            </div>
                          </div>
                        </div>
                        <div className="zone-divider" />
                        <div className="zone-section">
                          <div className="zone-section-head">
                            <p className="zone-section-label">Output</p>
                          </div>
                          <div className="zone-output-row">
                            <button
                              type="button"
                            className={`zone-output-chip${primaryTransport ? ' is-active' : ''}`}
                            onClick={() => setActiveZoneModal({ zoneId: zone.id, groupLabel: group.label, type: 'output' })}
                          >
                            <span className="zone-output-name">{outputsLabel}</span>
                            <span className="zone-output-type">{outputType}</span>
                          </button>
                            {hasWebPlayer && (
                              <a
                                className="zone-link-button"
                                href={`/zoneplayer/?zone=${zone.id}&autoconnect=1`}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ marginLeft: '8px' }}
                              >
                                Open web player
                              </a>
                            )}
                        </div>
                        </div>
                        <div className="zone-divider" />
                        <div className="zone-maintenance zone-maintenance--inline">
                          <div className="zone-maintenance-row">
                            <div>
                              <p className="zone-maintenance-label">Favorites</p>
                            </div>
                            <div className="zone-maintenance-controls">
                              <button
                                type="button"
                                className="button-compact"
                                onClick={() => void handleZoneFavoritesPurge(zone.id)}
                                disabled={maintenance.favoritesPurge}
                              >
                                {maintenance.favoritesPurge ? 'Purging…' : 'Clear'}
                              </button>
                            </div>
                          </div>
                          <div className="zone-maintenance-divider" />
                          <div className="zone-maintenance-row">
                            <div>
                              <p className="zone-maintenance-label">Recently played</p>
                            </div>
                            <div className="zone-maintenance-controls">
                              <button
                                type="button"
                                className="button-compact"
                                onClick={() => void handleZoneRecentsPurge(zone.id)}
                                disabled={maintenance.recentsPurge}
                              >
                                {maintenance.recentsPurge ? 'Purging…' : 'Clear'}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </article>
            ))}
          </div>
        )}
        {activeZoneInfo?.zone &&
          activeZoneModal?.type === 'output' &&
          renderModal(
            <div className="zones-modal-backdrop" onClick={closeZoneModal} role="dialog" aria-modal="true">
              <div className="zones-modal zones-modal--output" onClick={(event) => event.stopPropagation()}>
                <div className="zones-modal__body">
                  {(() => {
                    const activeTransport = getPrimaryTransport(activeZoneInfo.zone);
                    const activeLabel = activeTransport ? describeTransport(activeTransport) : 'No output';
                    const activeType =
                      activeTransport && activeTransport.id
                        ? activeTransport.id === 'googleCast' && (activeTransport as any)?.useSendspin
                          ? 'Sendspin over Cast'
                          : definitionMap.get(activeTransport.id)?.label ?? activeTransport.id
                        : 'Offload only';
                    return (
                      <section className="zone-detail-block">
                        <div className="zone-detail-row">
                          <p className="zone-section-title">Output routing</p>
                          <button type="button" className="zones-modal-close" onClick={closeZoneModal} aria-label="Close zone configuration">
                            ×
                          </button>
                        </div>
                        <div className="zone-detail-explainer zone-output-modal__summary">
                          <p className="zone-detail-text muted">
                            Outputs define where the audio signal is routed. Each protocol exposes a different feature set, so availability
                            and capabilities can vary.
                          </p>
                          <ul className="zone-detail-list">
                            <li>You can run without an output, but only sources that support offload will play.</li>
                            <li>When an output is selected, offload is still honored for sources that support it.</li>
                            <li>
                              Sendspin/Snapcast are the preferred protocols for best compatibility. You can also run Sendspin and Snapcast
                              over Google Cast, so it works with any player that supports Cast.
                            </li>
                          </ul>
                          <p className="zone-detail-text zone-detail-note">
                            Offload can break sync. Because lox-audioserver does not control the stream or clock drift, it cannot guarantee
                            perfectly synced playback across zones.
                          </p>
                        </div>
                        <div className="zone-output-modal__layout">
                          <aside className="zone-output-modal__summary-card">
                            <div className="zone-output-modal__summary-card__badge">Active</div>
                            <p className="zone-output-modal__summary-card__title">{activeLabel}</p>
                            <p className="zone-output-modal__summary-card__meta">{activeType}</p>
                          </aside>
                          <ZoneOutputEditor
                            zone={activeZoneInfo.zone}
                            definitions={transportDefinitions}
                            onChange={(config) => handleTransportChange(activeZoneInfo.zone.id, config)}
                            saving={saving}
                            describe={describeTransport}
                          />
                        </div>
                      </section>
                    );
                  })()}
                </div>
              </div>
            </div>,
          )}
        {activeZoneInfo?.zone &&
          activeZoneModal?.type === 'spotify' &&
          renderModal(
            <div className="zones-modal-backdrop" onClick={closeZoneModal} role="dialog" aria-modal="true">
              <div className="zones-modal" onClick={(event) => event.stopPropagation()}>
                <div className="zones-modal__body">
                  <section className="zone-detail-block">
                    <div className="zone-detail-row">
                      <p className="zone-section-title">Spotify Connect routing</p>
                      <button type="button" className="zones-modal-close" onClick={closeZoneModal} aria-label="Close Spotify settings">
                        ×
                      </button>
                    </div>
                    <div className="zone-detail-stack">
                      <div className="zone-detail-explainer">
                        <p className="zone-detail-text muted">
                          Spotify does not expose direct stream URLs, so lox-audioserver needs a player instance to resolve the Spotify URI
                          and decode the audio.
                        </p>
                        <ul className="zone-detail-list">
                          <li>
                            Default: lox-audioserver runs a built-in player per zone. It appears as a Spotify Connect device, so you can
                            target the zone from Spotify apps, and audio routes through the zone output.
                          </li>
                          <li>
                            Offload: play on an external Spotify Connect device. Loxone playback routes directly to that device and bypasses
                            lox-audioserver processing, while state/control still syncs back.
                          </li>
                        </ul>
                        <p className="zone-detail-text zone-detail-note">
                          When input is disabled, lox-audioserver will still spin up the built-in player on demand, but it is not published
                          as a Spotify Connect device.
                        </p>
                      </div>
                    </div>
                    <ZoneSpotifyOffloadSection
                      zone={activeZoneInfo.zone}
                      config={deriveZoneInputs(activeZoneInfo.zone).spotify ?? { enabled: true, publishName: activeZoneInfo.zone.name }}
                      discovery={spotifyDiscovery[activeZoneInfo.zone.id]}
                      saving={saving}
                      onToggle={(enabled) => handleSpotifyOffloadToggle(activeZoneInfo.zone, enabled)}
                      onDiscover={() => handleSpotifyDiscovery(activeZoneInfo.zone.id)}
                      onApply={(device) => handleSpotifyDeviceApply(activeZoneInfo.zone, device)}
                    />
                  </section>
                </div>
              </div>
            </div>,
          )}
        {activeZoneInfo?.zone &&
          activeZoneModal?.type === 'musicassistant' &&
          renderModal(
            <div className="zones-modal-backdrop" onClick={closeZoneModal} role="dialog" aria-modal="true">
              <div className="zones-modal" onClick={(event) => event.stopPropagation()}>
                <div className="zones-modal__body">
                  <section className="zone-detail-block">
                    <div className="zone-detail-row">
                      <p className="zone-section-title">Music Assistant routing</p>
                      <button type="button" className="zones-modal-close" onClick={closeZoneModal} aria-label="Close Music Assistant settings">
                        ×
                      </button>
                    </div>
                    <div className="zone-detail-stack">
                      <div className="zone-detail-explainer">
                        <p className="zone-detail-text muted">
                          Music Assistant does not provide direct stream URLs, so playback always goes through a player controlled via the
                          Music Assistant API.
                        </p>
                        <ul className="zone-detail-list">
                          <li>
                            Default: lox-audioserver registers a Sendspin player per zone. These players are visible in Music Assistant.
                            Music Assistant can play to these players, and the zone output handles the audio.
                          </li>
                          <li>
                            Offload: play directly on an existing Music Assistant player; audio bypasses lox-audioserver outputs while
                            state/control still sync to Loxone.
                          </li>
                        </ul>
                        <p className="zone-detail-text zone-detail-note">
                          When input is disabled, no visible players appear in Music Assistant; a hidden player is created on demand when
                          content is selected.
                        </p>
                      </div>
                    </div>
                    <ZoneMusicAssistantOffloadSection
                      zone={activeZoneInfo.zone}
                      config={deriveZoneInputs(activeZoneInfo.zone).musicassistant ?? { enabled: true, publishName: activeZoneInfo.zone.name }}
                      discovery={musicAssistantDiscovery[activeZoneInfo.zone.id]}
                      saving={saving}
                      onToggle={(enabled) => handleMusicAssistantOffloadToggle(activeZoneInfo.zone, enabled)}
                      onDiscover={() => handleMusicAssistantDiscovery(activeZoneInfo.zone.id)}
                      onApply={(device) => handleMusicAssistantDeviceApply(activeZoneInfo.zone, device)}
                    />
                  </section>
                </div>
              </div>
            </div>,
          )}
      </div>
    </div>
  );
}

interface SourceDescriptor {
  serial: string;
  label: string;
}

function groupZones(
  zones: Zone[],
  sources: Record<string, SourceDescriptor>,
  fallbackSerial?: string,
): ZoneGroup[] {
  const groups = new Map<string, ZoneGroup>();
  zones.forEach((zone) => {
    const sourceMac = zone.sourceMac?.toUpperCase() ?? fallbackSerial;
    const descriptor = (sourceMac && sources[sourceMac]) || null;
    const label = descriptor?.label || zone.source?.trim() || 'AudioServer';
    const serial = descriptor?.serial || sourceMac || zone.sourceSerial || label;
    const key = serial.toLowerCase();
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        label,
        sourceSerial: serial,
        zones: [zone],
      });
    } else {
      existing.zones.push(zone);
    }
  });
  return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function buildSourceDirectory(audioServer?: AudioServerConfig): Record<string, SourceDescriptor> {
  const directory: Record<string, SourceDescriptor> = {};
  if (!audioServer) return directory;

  const baseSerial = audioServer.macId?.toUpperCase() ?? null;
  if (baseSerial) {
    directory[baseSerial] = {
      serial: baseSerial,
      label: audioServer.name?.trim() || 'AudioServer',
    };
  }

  audioServer.extensions?.forEach((extension, index) => {
    const serial = extension.mac?.toUpperCase();
    if (!serial) return;
    directory[serial] = {
      serial,
      label: extension.name?.trim() || `Stereo Extension ${index + 1}`,
    };
  });

  return directory;
}

function hasMusicAssistantBridge(bridges: SpotifyBridgeConfig[] | undefined | null): boolean {
  if (!bridges || !Array.isArray(bridges)) return false;
  return bridges.some((bridge) => {
    if (!bridge) return false;
    const provider = (bridge.provider || '').toLowerCase();
    const id = (bridge.id || '').toLowerCase();
    const label = (bridge.label || '').toLowerCase();
    if (bridge.enabled === false) return false;
    return (
      provider === 'musicassistant' ||
      id === 'musicassistant' ||
      label.includes('music assistant')
    );
  });
}

type InputBadge = {
  key: string;
  label: string;
  enabled: boolean;
  type?: 'airplay' | 'spotify' | 'musicassistant';
  muted?: boolean;
  subtle?: boolean;
  disabled?: boolean;
};

type SpotifyDiscoveryState = {
  loading: boolean;
  error: string | null;
  devices: SpotifyDevice[];
};

type MusicAssistantDiscoveryState = {
  loading: boolean;
  error: string | null;
  devices: MusicAssistantPlayer[];
};

type ZoneMaintenanceIndicator = {
  favoritesPurge?: boolean;
  recentsPurge?: boolean;
};

type ZoneOutputEditorProps = {
  zone: Zone;
  saving: boolean;
  definitions: TransportConfigDefinition[];
  onChange: (transport: ZoneTransportConfig | null) => void;
  describe: (config: ZoneTransportConfig | null) => string;
};

type ZoneSpotifyOffloadProps = {
  zone: Zone;
  config: ZoneInputConfig['spotify'] | null | undefined;
  discovery?: SpotifyDiscoveryState;
  saving: boolean;
  onToggle: (enabled: boolean) => void;
  onDiscover: () => void;
  onApply: (device: SpotifyDevice) => void;
};

type ZoneMusicAssistantOffloadProps = {
  zone: Zone;
  config: ZoneInputConfig['musicassistant'] | null | undefined;
  discovery?: MusicAssistantDiscoveryState;
  saving: boolean;
  onToggle: (enabled: boolean) => void;
  onDiscover: () => void;
  onApply: (device: MusicAssistantPlayer) => void;
};

function ZoneOutputEditor({
  zone,
  saving,
  definitions,
  onChange,
  describe,
}: ZoneOutputEditorProps): JSX.Element {
  const primary = React.useMemo(() => getPrimaryTransport(zone), [zone]);
  const [selectedId, setSelectedId] = React.useState<string>(primary?.id ?? '');
  const [fieldValues, setFieldValues] = React.useState<Record<string, string>>(
    () => extractTransportFields(primary),
  );
  const [airplayDevices, setAirplayDevices] = React.useState<AirplayDevice[] | null>(null);
  const [discoveringAirplay, setDiscoveringAirplay] = React.useState(false);
  const [airplayError, setAirplayError] = React.useState<string | null>(null);
  const [castDevices, setCastDevices] = React.useState<GoogleCastDevice[] | null>(null);
  const [discoveringCast, setDiscoveringCast] = React.useState(false);
  const [castError, setCastError] = React.useState<string | null>(null);
  const [sendspinClients, setSendspinClients] = React.useState<SendspinClient[] | null>(null);
  const [discoveringSendspin, setDiscoveringSendspin] = React.useState(false);
  const [sendspinError, setSendspinError] = React.useState<string | null>(null);
  const [snapcastClients, setSnapcastClients] = React.useState<{ clientId: string; streamId?: string; connected?: boolean; connectedAt?: number }[] | null>(null);
  const [discoveringSnapcast, setDiscoveringSnapcast] = React.useState(false);
  const [snapcastError, setSnapcastError] = React.useState<string | null>(null);
  const activeAirplayHost =
    selectedId === 'airplay'
      ? fieldValues.host || (primary as any)?.host || ''
      : primary?.id === 'airplay'
        ? (primary as any)?.host ?? ''
        : '';
  const activeCastHost =
    selectedId === 'googleCast'
      ? fieldValues.host || (primary as any)?.host || ''
      : primary?.id === 'googleCast'
        ? (primary as any)?.host ?? ''
        : '';
  const activeSendspinId =
    selectedId === 'sendspin'
      ? fieldValues.clientId || (primary as any)?.clientId || ''
      : primary?.id === 'sendspin'
        ? (primary as any)?.clientId ?? ''
        : '';
  const activeSendspinCastHost =
    selectedId === 'sendspin'
      ? fieldValues.host || ''
      : primary?.id === 'googleCast' && (primary as any)?.useSendspin
        ? (primary as any)?.host ?? ''
        : '';

  const parseFriendlyName = (
    value: string | undefined,
  ): { primary: string; secondary?: string } => {
    if (!value) return { primary: '' };
    const atParts = value.split('@');
    const base = atParts.length > 1 ? atParts[atParts.length - 1] : value;
    const dashParts = base.split('-').map((part) => part.trim()).filter(Boolean);
    if (dashParts.length > 1) {
      return { primary: dashParts[dashParts.length - 1] };
    }
    return { primary: base.trim() };
  };

  const tailLabel = (value: string | undefined): string => {
    if (!value) return '';
    const tokens = value.split(/[-.]/).map((part) => part.trim()).filter(Boolean);
    return tokens.length ? tokens[tokens.length - 1] : value.trim();
  };
  const activeSendspinCastLabel =
    (selectedId === 'sendspin' ? fieldValues.name : undefined) ||
    ((primary as any)?.name as string | undefined) ||
    tailLabel(activeSendspinCastHost);
  const definitionMap = React.useMemo(() => {
    const map = new Map<string, TransportConfigDefinition>();
    definitions.forEach((def) => map.set(def.id, def));
    return map;
  }, [definitions]);

  React.useEffect(() => {
    setSelectedId(primary?.id ?? '');
    setFieldValues(extractTransportFields(primary));
  }, [primary]);

  const selectedDefinition = selectedId ? definitionMap.get(selectedId) ?? null : null;
  const hasFallbackOption = Boolean(selectedId && !selectedDefinition && primary);
  const isAirplay = selectedDefinition?.id === 'airplay';
  const isGoogleCast = selectedDefinition?.id === 'googleCast';
  const isSendspin = selectedDefinition?.id === 'sendspin';
  const isSnapcast = selectedDefinition?.id === 'snapcast';

  React.useEffect(() => {
    if (!isAirplay) {
      setAirplayDevices(null);
      setAirplayError(null);
      setDiscoveringAirplay(false);
    }
    if (!isGoogleCast && !isSendspin) {
      setCastDevices(null);
      setCastError(null);
      setDiscoveringCast(false);
    }
    if (!isSendspin) {
      setSendspinClients(null);
      setSendspinError(null);
      setDiscoveringSendspin(false);
    }
  }, [isAirplay, isGoogleCast, isSendspin]);

  React.useEffect(() => {
    if (isAirplay && !airplayDevices && !discoveringAirplay) {
      void handleAirplayDiscovery();
    }
  }, [isAirplay, airplayDevices, discoveringAirplay]);

  React.useEffect(() => {
    if (isGoogleCast && !castDevices && !discoveringCast) {
      void handleGoogleCastDiscovery();
    }
  }, [isGoogleCast, castDevices, discoveringCast]);

  React.useEffect(() => {
    if (isSendspin && !castDevices && !discoveringCast) {
      void handleGoogleCastDiscovery();
    }
  }, [isSendspin, castDevices, discoveringCast]);

  React.useEffect(() => {
    if (isSendspin && !sendspinClients && !discoveringSendspin) {
      void handleSendspinDiscovery();
    }
  }, [isSendspin, sendspinClients, discoveringSendspin]);

  function persist(transportId: string, values: Record<string, string>): void {
    if (!transportId) {
      onChange(null);
      return;
    }
    const definition = definitionMap.get(transportId);
    if (!definition) return;
    const payload: ZoneTransportConfig = { id: transportId };
    definition.fields.forEach((field) => {
      const value = values[field.id];
      if (value && value.trim()) {
        payload[field.id] = value.trim();
      }
    });
    onChange(payload);
  }

  function handleModuleSelect(nextId: string): void {
    setSelectedId(nextId);
    const nextValues = nextId === '' ? {} : extractDefaultFieldValues(nextId, definitionMap);
    setFieldValues(nextValues);
    if (nextId === 'airplay') {
      onChange(null);
      setAirplayDevices(null);
      setAirplayError(null);
      setDiscoveringAirplay(false);
      void handleAirplayDiscovery();
      return;
    }
    if (nextId === 'googleCast') {
      onChange(null);
      setCastDevices(null);
      setCastError(null);
      setDiscoveringCast(false);
      void handleGoogleCastDiscovery();
      return;
    }
    if (nextId === 'sendspin') {
      onChange(null);
      setSendspinClients(null);
      setSendspinError(null);
      setDiscoveringSendspin(false);
      void handleSendspinDiscovery();
      return;
    }
    persist(nextId, nextValues);
  }

  function handleFieldChange(fieldId: string, value: string): void {
    setFieldValues((prev) => ({ ...prev, [fieldId]: value }));
  }

  function handleFieldBlur(): void {
    if (!selectedId) {
      onChange(null);
      return;
    }
    if (selectedId === 'airplay' || selectedId === 'googleCast' || selectedId === 'sendspin') return;
    persist(selectedId, fieldValues);
  }

  async function handleAirplayDiscovery(): Promise<void> {
    if (!isAirplay || discoveringAirplay) return;
    setDiscoveringAirplay(true);
    setAirplayError(null);
    try {
      const devices = await discoverAirplayDevices();
      setAirplayDevices(devices);
      if (!devices.length) {
        setAirplayError('No AirPlay devices found.');
      }
    } catch (err) {
      setAirplayDevices([]);
      setAirplayError(
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Discovery failed',
      );
    } finally {
      setDiscoveringAirplay(false);
    }
  }

  function applyAirplayDevice(device: AirplayDevice): void {
    if (!selectedId) {
      setSelectedId('airplay');
    }
    const host = device.address || device.host || '';
    const payload: ZoneTransportConfig = {
      id: 'airplay',
      host,
      port: device.port,
      name: device.name,
      forceAp2: device.protocol === 'airplay',
    };
    onChange(payload);
  }

  async function handleGoogleCastDiscovery(): Promise<void> {
    if (!(isGoogleCast || isSendspin) || discoveringCast) return;
    setDiscoveringCast(true);
    setCastError(null);
    try {
      const devices = await discoverGoogleCastDevices();
      setCastDevices(devices);
      if (!devices.length) {
        setCastError(null);
      }
    } catch (err) {
      setCastDevices([]);
      setCastError(
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Discovery failed',
      );
    } finally {
      setDiscoveringCast(false);
    }
  }

  function applyGoogleCastDevice(device: GoogleCastDevice): void {
    if (!selectedId) {
      setSelectedId('googleCast');
    }
    const host = device.address || device.host || '';
    const payload: ZoneTransportConfig = {
      id: 'googleCast',
      host,
      name: device.name,
      useSendspin: undefined,
    };
    setFieldValues({
      host,
      name: device.name || '',
    });
    onChange(payload);
  }

  async function applyGoogleCastManual(): Promise<void> {
    const hostInput = (fieldValues.host ?? '').trim();
    const ipPattern = /^\d{1,3}(\.\d{1,3}){3}$/;
    if (!hostInput) {
      setCastError('Enter a Cast IP address to continue.');
      return;
    }
    if (!ipPattern.test(hostInput)) {
      setCastError('Use a numeric IP address, e.g. 192.168.1.50');
      return;
    }
    setCastError(null);
    setDiscoveringCast(true);
    try {
      const devices = await discoverGoogleCastDevices(hostInput);
      setCastDevices(devices);
      const match =
        devices.find((device) => device.address === hostInput || device.host === hostInput) ||
        devices[0];
      const resolvedHost = match?.address || match?.host || hostInput;
      const resolvedName = match?.name || tailLabel(resolvedHost) || 'Google Cast';
      const payload: ZoneTransportConfig = {
        id: 'googleCast',
        host: resolvedHost,
        name: resolvedName,
        useSendspin: undefined,
      };
      setFieldValues({
        host: resolvedHost,
        name: resolvedName,
      });
      onChange(payload);
      return;
    } catch (err) {
      setCastDevices([]);
      setCastError(
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Manual probe failed',
      );
    } finally {
      setDiscoveringCast(false);
    }
  }

  async function handleSendspinDiscovery(): Promise<void> {
    if (!isSendspin || discoveringSendspin) return;
    setDiscoveringSendspin(true);
    setSendspinError(null);
    try {
      const clients = await discoverSendspinClients();
      setSendspinClients(clients);
      if (!clients.length) {
        setSendspinError('No Sendspin clients found.');
      }
    } catch (err) {
      setSendspinClients([]);
      setSendspinError(
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Discovery failed',
      );
    } finally {
      setDiscoveringSendspin(false);
    }
  }

  function applySendspinClient(client: SendspinClient): void {
    if (!selectedId) {
      setSelectedId('sendspin');
    }
    const payload: ZoneTransportConfig = {
      id: 'sendspin',
      clientId: client.clientId,
    };
    setFieldValues({ clientId: client.clientId });
    onChange(payload);
  }

  function applySendspinCastDevice(device: GoogleCastDevice): void {
    if (!selectedId) {
      setSelectedId('sendspin');
    }
    const host = device.address || device.host || '';
    const payload: ZoneTransportConfig = {
      id: 'googleCast',
      host,
      name: device.name,
      useSendspin: true,
    };
    setFieldValues({
      host,
      name: device.name || '',
    });
    onChange(payload);
  }

  const summary = primary ? describe(primary) : 'No output';

  async function handleSnapcastDiscovery(): Promise<void> {
    if (!isSnapcast || discoveringSnapcast) return;
    setDiscoveringSnapcast(true);
    setSnapcastError(null);
    try {
      const clients = await discoverSnapcastClients();
      setSnapcastClients(clients);
      if (!clients.length) {
        setSnapcastError('No Snapclient connections yet.');
      }
    } catch (err) {
      setSnapcastClients([]);
      setSnapcastError(
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Discovery failed',
      );
    } finally {
      setDiscoveringSnapcast(false);
    }
  }

  function applySnapcastClient(clientId: string): void {
    setSelectedId('snapcast');
    const payload: ZoneTransportConfig = {
      id: 'snapcast',
      clientIds: clientId,
    } as any;
    setFieldValues({ clientIds: clientId });
    onChange(payload);
  }

  const moduleOptions = definitions.map((definition) => ({
    id: definition.id,
    label: definition.label,
    description: definition.description ?? '',
    active: definition.id === selectedId,
  }));
  const moduleIcons: Record<string, string> = {
    airplay: '/providers/airplay.svg',
    googleCast: '/providers/cast.svg',
    sendspin: '/providers/sendspin.svg',
    snapcast: '/providers/snapcast.svg',
  };
  const airplayLoaded = airplayDevices !== null;
  const airplayDeviceItems = airplayDevices ?? [];
  const activeAirplayMatch =
    activeAirplayHost &&
    airplayDeviceItems.find((device) => (device.address || device.host) === activeAirplayHost);
  const activeAirplayLabel =
    activeAirplayMatch?.name ||
    fieldValues.name ||
    ((primary as any)?.name as string | undefined) ||
    tailLabel(activeAirplayHost);
  const airplayTiles = airplayLoaded
    ? [
        ...airplayDeviceItems.map((device) => ({
          device,
          host: device.address || device.host,
          active: activeAirplayHost && (device.address || device.host) === activeAirplayHost,
        })),
        ...(!activeAirplayMatch && activeAirplayHost
          ? [{ device: activeAirplayMatch, host: activeAirplayHost, active: true }]
          : []),
      ]
    : activeAirplayHost
      ? [{ device: activeAirplayMatch, host: activeAirplayHost, active: true }]
      : [];
  const castLoaded = castDevices !== null;
  const castDeviceItems = castDevices ?? [];
  const activeCastMatch =
    activeCastHost &&
    castDeviceItems.find((device) => (device.address || device.host) === activeCastHost);
  const activeCastLabel =
    activeCastMatch?.name ||
    fieldValues.name ||
    ((primary as any)?.name as string | undefined) ||
    tailLabel(activeCastHost);
  const castTiles = castLoaded
    ? [
        ...castDeviceItems.map((device) => ({
          device,
          host: device.address || device.host,
          active: activeCastHost && (device.address || device.host) === activeCastHost,
        })),
        ...(!activeCastMatch && activeCastHost
          ? [{ device: activeCastMatch, host: activeCastHost, active: true }]
          : []),
      ]
    : activeCastHost
      ? [{ device: activeCastMatch, host: activeCastHost, active: true }]
      : [];
  const sendspinLoaded = sendspinClients !== null;
  const sendspinDeviceItems = sendspinClients ?? [];
  const activeSendspinMatch =
    activeSendspinId && sendspinDeviceItems.find((client) => client.clientId === activeSendspinId);
  const activeSendspinLabel =
    activeSendspinMatch?.name || tailLabel(activeSendspinId);
  const snapcastLoaded = snapcastClients !== null;
  const snapcastDeviceItems = snapcastClients ?? [];
  const activeSnapcastIds = (fieldValues.clientIds ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const sendspinTiles = sendspinLoaded
    ? [
        ...sendspinDeviceItems.map((client) => ({
          device: client,
          host: client.clientId,
          active: activeSendspinId === client.clientId,
        })),
        ...(!activeSendspinMatch && activeSendspinId
          ? [{ device: activeSendspinMatch, host: activeSendspinId, active: true }]
          : []),
      ]
    : activeSendspinId
      ? [{ device: activeSendspinMatch, host: activeSendspinId, active: true }]
      : [];

  return (
    <div className="zone-output-config">
      <div className="zone-output-config__editor">
        <div className="zone-output-editor">
          <div className="zone-output-selector">
            {moduleOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`zone-output-module${option.active ? ' zone-output-module--active' : ''}`}
                onClick={() => handleModuleSelect(option.id)}
                disabled={saving}
                aria-pressed={option.active}
              >
                <span className="zone-output-module__icon">
                  {moduleIcons[option.id] ? (
                    <img src={moduleIcons[option.id]} alt="" aria-hidden="true" />
                  ) : (
                    option.label
                      .split(' ')
                      .map((word) => word.charAt(0))
                      .slice(0, 2)
                      .join('')
                      .toUpperCase()
                  )}
                </span>
                <span className="zone-output-module__body">
                  <span className="zone-output-module__label">{option.label}</span>
                </span>
                {option.active && <span className="zone-output-module__status">Active</span>}
              </button>
            ))}
            {!definitions.length && (
              <p className="zone-detail-text muted">No transports available for this build.</p>
            )}
          </div>
          {definitions.length === 0 && (
            <p className="zone-detail-text muted">No transports are available for this build.</p>
          )}
          {selectedDefinition && !isAirplay && !isGoogleCast && !isSendspin && !isSnapcast && (
            <div className="zone-output-fields">
              {selectedDefinition.fields.map((field) => (
                <label key={field.id} className="zone-output-field">
                  <span>{field.label}</span>
                  <input
                    type="text"
                    value={fieldValues[field.id] ?? ''}
                    onChange={(event) => handleFieldChange(field.id, event.target.value)}
                    onBlur={handleFieldBlur}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        handleFieldBlur();
                      }
                    }}
                    placeholder={field.placeholder}
                    disabled={saving}
                  />
                  {field.description && <p className="zone-output-help">{field.description}</p>}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="zone-output-config__devices">
        {isAirplay && (
          <div className="zone-output-discovery">
            {airplayError && <p className="zone-output-error">{airplayError}</p>}
            <div className="zone-output-discovery-panel zone-output-discovery-panel--visible">
              <div className="zone-output-discovery-panel__header">
                <p className="zone-output-discovery-panel__title">Devices</p>
                <p className="zone-output-discovery-panel__copy">Tap a device to route audio instantly.</p>
              </div>
              <div className="zone-output-device-grid">
                {airplayTiles.map((item, index) => {
                  const device = item.device;
                  if (!device) {
                    return (
                      <div
                        key={`airplay-active-${item.host || index}`}
                        className="zone-output-device is-active"
                      >
                        <span className="zone-output-device__badge">Active</span>
                        <span className="zone-output-device__name">{activeAirplayLabel}</span>
                        <span className="zone-output-device__type">AirPlay</span>
                      </div>
                    );
                  }
                  const friendly = parseFriendlyName(device.name);
                  return (
                    <button
                      key={device.id}
                      type="button"
                      className={`zone-output-device${item.active ? ' is-active' : ''}`}
                      onClick={() => applyAirplayDevice(device)}
                      disabled={saving}
                    >
                      {item.active && <span className="zone-output-device__badge">Active</span>}
                      <span className="zone-output-device__name">{friendly.primary}</span>
                      <span className="zone-output-device__type">
                        {friendly.secondary || (device.protocol === 'airplay' ? 'AirPlay 2' : 'AirPlay')}
                      </span>
                    </button>
                  );
                })}
                {(!airplayLoaded || airplayDeviceItems.length === 0) &&
                  Array.from({ length: 3 }).map((_, idx) => (
                    <div key={`airplay-placeholder-${idx}`} className="zone-output-device zone-output-device--placeholder">
                      <span className="zone-output-device__name">AirPlay device</span>
                      <span className="zone-output-device__type">Discovering…</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}
        {isGoogleCast && (
          <div className="zone-output-discovery">
            {castError && <p className="zone-output-error">{castError}</p>}
            <div className="zone-output-discovery-panel zone-output-discovery-panel--visible">
              <div className="zone-output-discovery-panel__header">
                <p className="zone-output-discovery-panel__title">Devices</p>
                <p className="zone-output-discovery-panel__copy">Tap a device to route audio instantly.</p>
              </div>
              <div className="zone-output-device-grid">
                {castTiles.map((item, index) => {
                  const device = item.device;
                  if (!device) {
                    return (
                      <div
                        key={`cast-active-${item.host || index}`}
                        className="zone-output-device is-active"
                      >
                        <span className="zone-output-device__badge">Active</span>
                        <span className="zone-output-device__name">{activeCastLabel}</span>
                        <span className="zone-output-device__type">Google Cast</span>
                      </div>
                    );
                  }
                  const friendly = parseFriendlyName(device.name);
                  return (
                    <button
                      key={device.id}
                      type="button"
                      className={`zone-output-device${item.active ? ' is-active' : ''}`}
                      onClick={() => applyGoogleCastDevice(device)}
                      disabled={saving}
                    >
                      {item.active && <span className="zone-output-device__badge">Active</span>}
                      <span className="zone-output-device__name">{friendly.primary}</span>
                      <span className="zone-output-device__type">
                        {friendly.secondary || tailLabel(device.manufacturer || device.model || 'Cast')}
                      </span>
                    </button>
                  );
                })}
                {(!castLoaded || castDeviceItems.length === 0) &&
                  Array.from({ length: 3 }).map((_, idx) => (
                    <div key={`cast-placeholder-${idx}`} className="zone-output-device zone-output-device--placeholder">
                      <span className="zone-output-device__name">Cast device</span>
                      <span className="zone-output-device__type">Discovering…</span>
                    </div>
                  ))}
              </div>
            </div>
            {(!castDevices || castDevices.length === 0) && !discoveringCast && (
              <>
              <p className="zone-output-status">No Google Cast devices found yet.</p>
                <div className="zone-output-manual">
                  <p className="zone-output-manual__eyebrow">Manual Cast target</p>
                  <p className="zone-output-manual__title">Probe a Cast device by IP</p>
                  <div className="zone-output-manual__row">
                    <label className="zone-output-manual__field">
                      <span>Cast IP</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        pattern="[0-9.]*"
                        placeholder="192.168.1.50"
                        value={fieldValues.host ?? ''}
                        onChange={(event) => handleFieldChange('host', event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void applyGoogleCastManual();
                          }
                        }}
                        disabled={saving}
                      />
                    </label>
                    <button
                      type="button"
                      className="button-compact"
                      onClick={() => void applyGoogleCastManual()}
                      disabled={saving || !fieldValues.host?.trim()}
                    >
                      Discover
                    </button>
                  </div>
                  <p className="zone-output-manual__hint">
                    Uses the Cast setup endpoint on this IP and fills details automatically.
                  </p>
                </div>
              </>
            )}
        </div>
      )}
          {isSendspin && (
            <div className="zone-output-discovery">
              {sendspinError && <p className="zone-output-error">{sendspinError}</p>}
              <div className="zone-output-discovery-panel zone-output-discovery-panel--visible">
              <div className="zone-output-discovery-panel__header">
                <p className="zone-output-discovery-panel__title">Devices</p>
                <p className="zone-output-discovery-panel__copy">Tap a client to route audio.</p>
              </div>
              <div className="zone-output-device-grid">
                {sendspinTiles.map((item, index) => {
                  const client = item.device;
                  if (!client) {
                    return (
                      <div
                        key={`sendspin-active-${item.host || index}`}
                        className="zone-output-device is-active"
                      >
                        <span className="zone-output-device__badge">Active</span>
                        <span className="zone-output-device__name">{activeSendspinLabel}</span>
                        <span className="zone-output-device__type">Sendspin</span>
                      </div>
                    );
                  }
                  const friendly = parseFriendlyName(client.name || client.clientId);
                  return (
                    <button
                      key={client.id}
                      type="button"
                      className={`zone-output-device${item.active ? ' is-active' : ''}`}
                      onClick={() => applySendspinClient(client)}
                      disabled={saving}
                    >
                      {item.active && <span className="zone-output-device__badge">Active</span>}
                      <span className="zone-output-device__name">{friendly.primary}</span>
                      <span className="zone-output-device__type">{friendly.secondary || 'Sendspin'}</span>
                    </button>
                  );
                })}
                {activeSendspinCastHost &&
                  !castDeviceItems.some(
                    (device) => (device.address || device.host) === activeSendspinCastHost,
                  ) && (
                    <div className="zone-output-device is-active">
                      <span className="zone-output-device__badge">Active</span>
                      <span className="zone-output-device__name">{activeSendspinCastLabel}</span>
                      <span className="zone-output-device__type">Cast (Sendspin)</span>
                    </div>
                  )}
                {castDeviceItems.map((device) => {
                  const friendly = parseFriendlyName(device.name);
                  const isActive =
                    activeSendspinCastHost &&
                    (device.address || device.host) === activeSendspinCastHost;
                  return (
                    <button
                      key={`sendspin-cast-${device.id}`}
                      type="button"
                      className={`zone-output-device${isActive ? ' is-active' : ''}`}
                      onClick={() => applySendspinCastDevice(device)}
                      disabled={saving}
                    >
                      {isActive && <span className="zone-output-device__badge">Active</span>}
                      <span className="zone-output-device__name">{friendly.primary}</span>
                      <span className="zone-output-device__type">Cast (Sendspin)</span>
                    </button>
                  );
                })}
                {(!sendspinLoaded || sendspinDeviceItems.length === 0) &&
                  Array.from({ length: 3 }).map((_, idx) => (
                    <div key={`sendspin-placeholder-${idx}`} className="zone-output-device zone-output-device--placeholder">
                      <span className="zone-output-device__name">Sendspin client</span>
                      <span className="zone-output-device__type">Discovering…</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}
        {isSnapcast && (
          <div className="zone-output-discovery">
            {snapcastError && <p className="zone-output-error">{snapcastError}</p>}
            <div className="zone-output-discovery-panel zone-output-discovery-panel--visible">
              <div className="zone-output-discovery-panel__header">
                <p className="zone-output-discovery-panel__title">Connected Snapclients</p>
                <p className="zone-output-discovery-panel__copy">Tap a client to map it to this zone.</p>
              </div>
              <div className="zone-output-device-grid">
                {snapcastDeviceItems.map((client, index) => {
                  const label = client.clientId || client.id || `client-${index}`;
                  const active = activeSnapcastIds.includes(label);
                  return (
                    <button
                      key={`snapcast-${label}-${index}`}
                      type="button"
                      className={`zone-output-device${active ? ' is-active' : ''}`}
                      onClick={() => applySnapcastClient(label)}
                      disabled={saving}
                    >
                      {active && <span className="zone-output-device__badge">Active</span>}
                      <span className="zone-output-device__name">{label || 'Unknown client'}</span>
                      <span className="zone-output-device__type">
                        {client.streamId ? `Stream: ${client.streamId}` : 'Snapcast'}
                      </span>
                    </button>
                  );
                })}
                {(!snapcastLoaded || snapcastDeviceItems.length === 0) &&
                  Array.from({ length: 2 }).map((_, idx) => (
                    <div key={`snapcast-placeholder-${idx}`} className="zone-output-device zone-output-device--placeholder">
                      <span className="zone-output-device__name">Snapclient</span>
                      <span className="zone-output-device__type">
                        {discoveringSnapcast ? 'Discovering…' : 'No clients connected'}
                      </span>
                    </div>
                  ))}
              </div>
              <div className="zone-output-discovery-actions">
                <button
                  type="button"
                  className="button-compact"
                  onClick={() => void handleSnapcastDiscovery()}
                  disabled={saving || discoveringSnapcast}
                >
                  {discoveringSnapcast ? 'Refreshing…' : 'Refresh list'}
                </button>
                <p className="zone-output-help">
                  Current mapping: {fieldValues.clientIds?.trim() || 'None set'}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ZoneSpotifyOffloadSection({
  zone,
  config,
  discovery,
  saving,
  onToggle,
  onDiscover,
  onApply,
}: ZoneSpotifyOffloadProps): JSX.Element {
  const effectiveConfig = config ?? { enabled: true, publishName: zone.name };
  const offloadEnabled = effectiveConfig.offload === true;
  const selectedDeviceId = effectiveConfig.deviceId ?? '';
  const selectedDevice =
    selectedDeviceId && discovery?.devices
      ? discovery.devices.find((device) => device.deviceId === selectedDeviceId)
      : null;

  React.useEffect(() => {
    if (!offloadEnabled || discovery?.loading || (discovery?.devices?.length ?? 0) > 0) return;
    onDiscover();
  }, [offloadEnabled, discovery?.loading, discovery?.devices, onDiscover]);

  return (
    <div className="zone-spotify-offload">
      <div className="zone-spotify-offload__header">
        <div>
          <p className="zone-spotify-offload__title">Hardware player</p>
          <p className="zone-spotify-offload__copy">
            Let a Spotify Connect device handle playback instead of the built-in client.
          </p>
        </div>
        <label className="zone-switch">
          <input
            type="checkbox"
            checked={offloadEnabled}
            disabled={saving}
            onChange={(event) => onToggle(event.target.checked)}
          />
          <span className="zone-switch-slider" />
        </label>
      </div>
      {offloadEnabled && (
        <>
          {discovery?.error && <p className="zone-spotify-error">{discovery.error}</p>}
          {discovery?.devices && discovery.devices.length > 0 && (
            <div className="zone-spotify-device-grid">
              {discovery.devices.map((device) => (
                <button
                  key={device.deviceId ?? device.id}
                  type="button"
                  className={`zone-spotify-device${device.deviceId === selectedDeviceId ? ' zone-spotify-device--selected' : ''}`}
                  onClick={() => onApply(device)}
                  disabled={saving}
                >
                  <span className="zone-spotify-device__name">{device.name ?? device.deviceId ?? 'Device'}</span>
                  <span className="zone-spotify-device__meta">
                    {device.accountLabel
                      ? `${device.accountLabel} • ${device.deviceId ?? device.id ?? 'id'}`
                      : `ID: ${device.deviceId ?? device.id ?? 'n/a'}`}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="zone-spotify-offload__actions">
            <button type="button" className="secondary" onClick={onDiscover} disabled={discovery?.loading || saving}>
              {discovery?.loading ? 'Scanning…' : 'Rescan'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ZoneMusicAssistantOffloadSection({
  zone,
  config,
  discovery,
  saving,
  onToggle,
  onDiscover,
  onApply,
}: ZoneMusicAssistantOffloadProps): JSX.Element {
  const effectiveConfig = config ?? { enabled: true, publishName: zone.name, offload: false };
  const inputEnabled = effectiveConfig.enabled !== false;
  const offloadEnabled = effectiveConfig.offload === true;
  const selectedDeviceId = effectiveConfig.deviceId ?? '';
  const selectedDevice =
    selectedDeviceId && discovery?.devices
      ? discovery.devices.find((device) => (device.deviceId || device.id) === selectedDeviceId)
      : null;
  const routingLabel = offloadEnabled ? 'Offload to existing player' : 'Sendspin player (default)';
  const inputLabel = inputEnabled ? 'Enabled' : 'Disabled';
  const inputMeta = inputEnabled
    ? 'Visible in Music Assistant'
    : 'Hidden in Music Assistant; created on demand';
  const playerLabel = inputEnabled
    ? offloadEnabled
      ? selectedDevice?.name ?? (selectedDeviceId || 'Select a player')
      : 'Sendspin player for this zone'
    : 'Hidden player on demand';

  React.useEffect(() => {
    if (!offloadEnabled || discovery?.loading || (discovery?.devices?.length ?? 0) > 0) return;
    onDiscover();
  }, [offloadEnabled, discovery?.loading, discovery?.devices, onDiscover]);

  return (
    <div className="zone-spotify-offload">
      <div className="zone-spotify-offload__summary">
        <div className="zone-spotify-offload__summary-item">
          <span className="zone-spotify-offload__summary-label">Input</span>
          <span className="zone-spotify-offload__summary-value">{inputLabel}</span>
          <span className="zone-spotify-offload__summary-meta">{inputMeta}</span>
        </div>
        <div className="zone-spotify-offload__summary-item">
          <span className="zone-spotify-offload__summary-label">Routing</span>
          <span className="zone-spotify-offload__summary-value">{routingLabel}</span>
        </div>
        <div className="zone-spotify-offload__summary-item">
          <span className="zone-spotify-offload__summary-label">Player</span>
          <span className="zone-spotify-offload__summary-value">{playerLabel}</span>
        </div>
      </div>
      <div className="zone-spotify-offload__header">
        <div>
          <p className="zone-spotify-offload__title">Use offload</p>
        </div>
        <label className="zone-switch">
          <input
            type="checkbox"
            checked={offloadEnabled}
            disabled={saving}
            onChange={(event) => onToggle(event.target.checked)}
          />
          <span className="zone-switch-slider" />
        </label>
      </div>
      {offloadEnabled && (
        <>
          {discovery?.error && <p className="zone-spotify-error">{discovery.error}</p>}
          {discovery?.devices && discovery.devices.length > 0 && (
            <div className="zone-spotify-device-grid">
              {discovery.devices.map((device) => {
                const id = device.deviceId || device.id || 'unknown';
                const isSelected = id === selectedDeviceId;
                return (
                  <button
                    key={id}
                    type="button"
                    className={`zone-spotify-device${isSelected ? ' zone-spotify-device--selected' : ''}`}
                    onClick={() => onApply(device)}
                    disabled={saving}
                  >
                    <span className="zone-spotify-device__name">{device.name ?? id}</span>
                    <span className="zone-spotify-device__meta">ID: {id}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="zone-spotify-offload__actions">
            <button type="button" className="secondary" onClick={onDiscover} disabled={discovery?.loading || saving}>
              {discovery?.loading ? 'Scanning…' : 'Rescan'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function deriveZoneInputs(zone: Zone): ZoneInputConfig {
  return zone.inputs ? { ...buildDefaultInputs(zone), ...zone.inputs } : buildDefaultInputs(zone);
}

function buildDefaultInputs(zone: Zone): ZoneInputConfig {
  return {
    airplay: {
      enabled: true,
      model: 'generic',
    },
    spotify: {
      enabled: false,
      publishName: zone.name,
      offload: false,
    },
    musicassistant: {
      enabled: true,
      publishName: zone.name,
      offload: false,
    },
    lineIn: null,
  };
}

function buildInputBadges(inputs: ZoneInputConfig, includeMusicAssistant?: boolean, spotifyAllowed?: boolean): InputBadge[] {
  const badges: InputBadge[] = [
    {
      key: 'airplay',
      label: 'AirPlay',
      enabled: inputs.airplay?.enabled ?? false,
      type: 'airplay',
    },
    {
      key: 'spotify',
      label: 'Spotify Connect',
      enabled: spotifyAllowed ? inputs.spotify?.enabled ?? false : false,
      disabled: spotifyAllowed !== true,
      type: 'spotify',
    },
  ];

  if (includeMusicAssistant) {
    badges.push({
      key: 'musicassistant',
      label: 'Music Assistant',
      enabled: inputs.musicassistant?.enabled ?? false,
      type: 'musicassistant',
    });
  }

  return badges;
}

function getPrimaryTransport(zone: Zone): ZoneTransportConfig | null {
  if (zone.transport) return zone.transport;
  if (Array.isArray(zone.transports) && zone.transports.length > 0) {
    return zone.transports[0] ?? null;
  }
  return null;
}

function describeTransport(config: ZoneTransportConfig | null): string {
  if (!config) return '';
  const record = config as Record<string, unknown>;
  const id = (config.id ?? '').toLowerCase();
  if (id === 'sendspin') {
    const clientId = readStringField(record, 'clientId');
    if (clientId) return clientId;
  }
  if (id === 'snapcast') {
    const clientIds = readStringField(record, 'clientIds');
    if (clientIds) {
      const first = clientIds.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  if (id === 'dlna') {
    const host = readStringField(record, 'host');
    if (host) return host;
    const controlUrl = readStringField(record, 'controlUrl');
    if (controlUrl) return controlUrl;
  }
  const name = readStringField(record, 'name');
  if (name) return name;
  const label = readStringField(record, 'label');
  if (label) return label;
  return config.id ?? 'Output';
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const raw = record[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractTransportFields(config: ZoneTransportConfig | null): Record<string, string> {
  if (!config) return {};
  const record = config as Record<string, unknown>;
  return Object.entries(record).reduce<Record<string, string>>((acc, [key, value]) => {
    if (key === 'id') return acc;
    if (typeof value === 'string') {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function extractDefaultFieldValues(
  transportId: string,
  definitions: Map<string, TransportConfigDefinition>,
): Record<string, string> {
  const definition = definitions.get(transportId);
  if (!definition) return {};
  return definition.fields.reduce<Record<string, string>>((acc, field) => {
    acc[field.id] = '';
    return acc;
  }, {});
}
