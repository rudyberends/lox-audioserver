import React from 'react';
import { createPortal } from 'react-dom';
import './ContentView.css';
import { getConfig } from '../services/setupApi';
import {
  updateContentConfig,
  fetchLibraryStatus,
  fetchLibraryStorageCovers,
  fetchLibraryStorageStatus,
  uploadLibraryAudio,
  triggerLibraryRescan,
  deleteSpotifyAccount,
  fetchSpotifyAuthLink,
  fetchLibraryStorages,
  createLibraryStorage,
  deleteLibraryStorage,
  fetchCustomRadioStations,
  createCustomRadioStation,
  deleteCustomRadioStation,
  validateTuneInUsername,
  createSpotifyBridge,
  deleteSpotifyBridge,
  updateInputsConfig,
} from '../services/contentApi';
import type {
  LibraryStorage,
  CustomRadioEntry,
  LibraryCoverSample,
  SpotifyBridgeConfig,
  CreateSpotifyBridgePayload,
} from '../services/contentApi';
import { fetchAlertFiles, revertAlertFile as revertAlertFileApi, uploadAlertFile } from '../services/alertsApi';
import type { AlertFile } from '../services/alertsApi';
import { purgeFavorites, purgeRecents } from '../services/zonesApi';
import { API_BASE } from '../config/apiConfig';
import { useGlobalAlert } from '../components/GlobalAlert';
import { discoverSendspinClients, type SendspinClient } from '../services/transportsApi';

type ContentConfigResponse = {
  config?: {
    content?: {
      radio?: {
        tuneInUsername?: string | null;
      };
      spotify?: {
        clientId?: string | null;
        accounts?: SpotifyAccountConfig[];
      };
      library?: {
        enabled?: boolean;
        autoScan?: boolean;
      };
    };
    inputs?: {
      lineIn?: {
        inputs?: LineInInputConfig[] | null;
      };
    };
    system?: {
      audioserver?: {
        ip?: string | null;
      };
    };
  };
};

type SpotifyAccountConfig = {
  id?: string;
  displayName?: string;
  name?: string;
  user?: string;
  email?: string;
  product?: string;
};

type SpotifyBridgeConfig = {
};
type ScanStatus = 0 | 1 | 2;

type StorageLibraryStats = {
  tracks: number;
  albums: number;
  artists: number;
};

type LineInInputConfig = {
  id?: string;
  name?: string;
  iconType?: LineInIconType;
  metadataEnabled?: boolean;
  source?: {
    type?: LineInSourceType;
    [key: string]: unknown;
  } | null;
};

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav']);

type StorageFormState = {
  name: string;
  server: string;
  folder: string;
  type: string;
  username: string;
  password: string;
  guest: boolean;
};

type CustomRadioFormState = {
  name: string;
  stream: string;
  coverurl: string;
};

type BridgeFormState = {
  provider: 'musicassistant' | 'applemusic' | 'deezer' | 'tidal';
  host: string;
  port: number;
  apiKey: string;
  userToken: string;
  deezerArl: string;
  tidalAccessToken: string;
  tidalCountryCode: string;
};

type LineInFormState = {
  name: string;
  iconType: LineInIconType;
  sourceType: LineInSourceType;
  metadataEnabled: boolean;
  draftId: string;
  sendspinClientId: string;
  bridgeId: string;
  captureDeviceId: string;
  ingestSampleRate: string;
  ingestResampler: string;
  vadThresholdDb: string;
  vadHoldMs: string;
};

enum LineInIconType {
  LineIn = 0,
  CdPlayer = 1,
  Computer = 2,
  IMac = 3,
  IPod = 4,
  Mobile = 5,
  Radio = 6,
  Screen = 7,
  TurnTable = 8,
}

const LINEIN_ICON_OPTIONS: Array<{ value: LineInIconType; label: string }> = [
  { value: LineInIconType.LineIn, label: 'Line in' },
  { value: LineInIconType.CdPlayer, label: 'CD player' },
  { value: LineInIconType.IMac, label: 'iMac' },
  { value: LineInIconType.IPod, label: 'iPod' },
  { value: LineInIconType.Mobile, label: 'Mobile' },
  { value: LineInIconType.Radio, label: 'Radio' },
  { value: LineInIconType.Screen, label: 'Screen' },
  { value: LineInIconType.TurnTable, label: 'Turntable' },
];

type LineInSourceType = 'bridge' | 'ingest' | 'sendspin' | 'lox-beolink';

function describeLineInIcon(iconType: LineInIconType): string {
  switch (iconType) {
    case LineInIconType.LineIn:
      return 'Line in';
    case LineInIconType.CdPlayer:
      return 'CD player';
    case LineInIconType.Computer:
      return 'Computer';
    case LineInIconType.IMac:
      return 'iMac';
    case LineInIconType.IPod:
      return 'iPod';
    case LineInIconType.Mobile:
      return 'Mobile';
    case LineInIconType.Radio:
      return 'Radio';
    case LineInIconType.Screen:
      return 'Screen';
    case LineInIconType.TurnTable:
      return 'Turntable';
    default:
      return 'Line in';
  }
}

function describeLineInSource(sourceType: LineInSourceType): string {
  if (sourceType === 'bridge') return 'Lox-linein-bridge';
  if (sourceType === 'ingest') return 'Ingest (streamed input)';
  if (sourceType === 'sendspin') return 'Sendspin';
  if (sourceType === 'lox-beolink') return 'Lox BeoLink';
  return sourceType;
}

type LineInBridgeStatus = {
  linein_id: string;
  bridge_id?: string | null;
  connected: boolean;
  state: string | null;
  received_at: string | null;
  device?: string | null;
};

type LineInBridgeSummary = {
  bridge_id: string;
  hostname?: string;
  version?: string;
  ip?: string;
  mac?: string;
  assigned_input_id?: string | null;
  last_seen?: string | null;
  capture_devices?: Array<{ id: string; name?: string }>;
};

const LINEIN_STATUS_POLL_MS = 5000;
const SENDSPIN_STATUS_POLL_MS = 5000;

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNumberOrDefault(value: string, fallback: number): number {
  const parsed = parseOptionalNumber(value);
  return typeof parsed === 'number' ? parsed : fallback;
}

function formatLineInState(state?: string | null): string | null {
  if (!state) return null;
  return state
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function fetchLineInBridgeStatus(inputId: string): Promise<LineInBridgeStatus | null> {
  try {
    const res = await fetch(`/api/linein/${encodeURIComponent(inputId)}/bridge-status`);
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as LineInBridgeStatus;
  } catch {
    return null;
  }
}

async function fetchLineInBridges(signal?: AbortSignal): Promise<LineInBridgeSummary[]> {
  const res = await fetch('/api/linein/bridges', { signal });
  if (!res.ok) {
    throw new Error('Failed to load line-in bridges.');
  }
  const payload = (await res.json()) as LineInBridgeSummary[];
  return Array.isArray(payload) ? payload : [];
}

async function deleteLineInBridge(bridgeId: string): Promise<void> {
  const res = await fetch(`/api/linein/bridges/${encodeURIComponent(bridgeId)}`, {
    method: 'DELETE',
  });
  if (res.status === 409) {
    throw new Error('Bridge is still assigned.');
  }
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to delete bridge.');
  }
}

function resolveLineInIconUrl(iconType: LineInIconType): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const toUrl = (file: string) => `${prefix}linein/${file}`;
  switch (iconType) {
    case LineInIconType.LineIn:
      return toUrl('line-in.svg');
    case LineInIconType.CdPlayer:
      return toUrl('cd-player.svg');
    case LineInIconType.Computer:
      return toUrl('computer.svg');
    case LineInIconType.IMac:
      return toUrl('imac.svg');
    case LineInIconType.IPod:
      return toUrl('ipod.svg');
    case LineInIconType.Mobile:
      return toUrl('mobile.svg');
    case LineInIconType.Radio:
      return toUrl('radio-1.svg');
    case LineInIconType.Screen:
      return toUrl('screen.svg');
    case LineInIconType.TurnTable:
      return toUrl('turntable.svg');
    default:
      return toUrl('line-in.svg');
  }
}

function createLineInId(): string {
  return `linein-${Date.now().toString(36)}`;
}

function getLineInIngestBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://<audioserver-host>';
  return window.location.origin || 'http://<audioserver-host>';
}

function getLineInIngestWsUrl(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) return baseUrl.replace('https://', 'wss://');
  if (baseUrl.startsWith('http://')) return baseUrl.replace('http://', 'ws://');
  return baseUrl;
}

function getLineInIngestTcpHost(): string {
  if (typeof window === 'undefined') return '<audioserver-host>';
  return window.location.hostname || '<audioserver-host>';
}

function getLineInBridgeServerUrl(configuredIp?: string | null): string {
  const host = configuredIp?.trim();
  if (host) {
    return `http://${host}:7090`;
  }
  if (typeof window === 'undefined') return 'http://<lox-host>:7090';
  return `http://${window.location.hostname || '<lox-host>'}:7090`;
}

type FileSystemEntry = {
  isFile: boolean;
  isDirectory: boolean;
  fullPath?: string;
};

type FileSystemFileEntry = FileSystemEntry & {
  file: (success: (file: File) => void, error?: () => void) => void;
};

type FileSystemDirectoryEntry = FileSystemEntry & {
  createReader: () => FileSystemDirectoryReader;
};

type FileSystemDirectoryReader = {
  readEntries: (success: (entries: FileSystemEntry[]) => void, error?: () => void) => void;
};

type DroppedUpload = {
  file: File;
  relativePath?: string;
};

type AlertPlaybackRowProps = {
  alert: AlertFile;
  alertsSaving: boolean;
  isActive: boolean;
  onActivate: (alertId: string) => void;
  onDeactivate: (alertId: string) => void;
  onUpload: (alertId: string, file: File | null) => Promise<void>;
  onRevert: (alertId: string) => Promise<void>;
};

type ContentFilterKey = 'radio' | 'library' | 'spotify' | 'linein' | 'custom' | 'system' | 'alerts';

function formatScanStatus(status: ScanStatus | null): { label: string; tone: 'idle' | 'active' | 'error' } {
  if (status === 1) return { label: 'Scanning', tone: 'active' };
  if (status === 2) return { label: 'Error', tone: 'error' };
  return { label: 'Idle', tone: 'idle' };
}

function getAlertFriendlyName(alertId: string): string {
  if (alertId === 'firealarm') return 'Fire alarm';
  return alertId.charAt(0).toUpperCase() + alertId.slice(1);
}

function isAudioFilename(name: string): boolean {
  const parts = name.toLowerCase().split('.');
  if (parts.length < 2) return false;
  return AUDIO_EXTENSIONS.has(`.${parts.pop()}`);
}

function normalizeRelativePath(pathValue: string | undefined | null): string | undefined {
  if (!pathValue) return undefined;
  const cleaned = pathValue.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = cleaned.split('/').filter((part) => part && part !== '.' && part !== '..');
  if (parts.length === 0) return undefined;
  return parts.map((part) => part.replace(/[^A-Za-z0-9._-]/g, '_')).join('/');
}

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = [];
  return new Promise((resolve) => {
    const readBatch = (): void => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(entries);
            return;
          }
          entries.push(...batch);
          readBatch();
        },
        () => resolve(entries),
      );
    };
    readBatch();
  });
}

async function collectFilesFromEntry(entry: FileSystemEntry | null, out: DroppedUpload[]): Promise<void> {
  if (!entry) return;
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(
        (value) => resolve(value),
        () => resolve(null),
      );
    });
    if (file) {
      const relativePath = normalizeRelativePath(entry.fullPath);
      out.push({ file, relativePath });
    }
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children = await readAllEntries(reader);
    for (const child of children) {
      await collectFilesFromEntry(child, out);
    }
  }
}

async function collectFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<DroppedUpload[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const files: DroppedUpload[] = [];
  if (items.length > 0) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = (item as any).webkitGetAsEntry?.() as FileSystemEntry | null;
      if (entry) {
        await collectFilesFromEntry(entry, files);
      } else {
        const file = item.getAsFile();
        if (file) files.push({ file, relativePath: normalizeRelativePath(file.webkitRelativePath) });
      }
    }
  }
  if (files.length === 0) {
    files.push(
      ...Array.from(dataTransfer.files ?? []).map((file) => ({
        file,
        relativePath: normalizeRelativePath(file.webkitRelativePath),
      })),
    );
  }
  return files;
}

function AlertPlaybackRow({
  alert,
  alertsSaving,
  isActive,
  onActivate,
  onDeactivate,
  onUpload,
  onRevert,
}: AlertPlaybackRowProps): JSX.Element {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const pendingSeekRef = React.useRef<number | null>(null);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [dragActive, setDragActive] = React.useState(false);

  const resolveDuration = (audio: HTMLAudioElement): number => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      return audio.duration;
    }
    if (audio.seekable?.length) {
      const end = audio.seekable.end(audio.seekable.length - 1);
      if (Number.isFinite(end) && end > 0) return end;
    }
    if (audio.buffered?.length) {
      const end = audio.buffered.end(audio.buffered.length - 1);
      if (Number.isFinite(end) && end > 0) return end;
    }
    return 0;
  };

  React.useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const syncTime = (): void => {
      setDuration(resolveDuration(audio));
      setCurrentTime(audio.currentTime);
    };
    const applyPendingSeek = (): void => {
      const pending = pendingSeekRef.current;
      if (pending === null) return;
      const resolvedDuration = resolveDuration(audio);
      if (!resolvedDuration) return;
      const newTime = (pending / 100) * resolvedDuration;
      audio.currentTime = newTime;
      setCurrentTime(newTime);
      pendingSeekRef.current = null;
    };
    const handleLoadedMetadata = (): void => {
      syncTime();
      applyPendingSeek();
    };
    const handlePlay = (): void => {
      setPlaying(true);
      onActivate(alert.id);
    };
    const handlePause = (): void => {
      setPlaying(false);
    };
    const handleEnded = (): void => {
      setPlaying(false);
      setCurrentTime(0);
      onDeactivate(alert.id);
    };
    audio.addEventListener('timeupdate', syncTime);
    audio.addEventListener('durationchange', syncTime);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    if (audio.readyState >= 1) {
      handleLoadedMetadata();
    }
    return () => {
      audio.removeEventListener('timeupdate', syncTime);
      audio.removeEventListener('durationchange', syncTime);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [alert.id, onActivate, onDeactivate]);

  React.useEffect(() => {
    if (!isActive && playing) {
      const audio = audioRef.current;
      audio?.pause();
    }
  }, [isActive, playing]);

  React.useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);
    pendingSeekRef.current = null;
    audioRef.current?.load();
  }, [alert.url]);

  React.useEffect(() => {
    if (!playing) return undefined;
    let raf: number;
    const tick = (): void => {
      const audio = audioRef.current;
      if (audio) {
        setCurrentTime(audio.currentTime);
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          setDuration(audio.duration);
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [playing]);

  const togglePlayback = (): void => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      onDeactivate(alert.id);
      return;
    }
    onActivate(alert.id);
    void audio.play();
  };

  const handleSeek = (value: number): void => {
    const audio = audioRef.current;
    if (!audio) return;
    const resolvedDuration = resolveDuration(audio);
    if (!resolvedDuration) {
      pendingSeekRef.current = value;
      audio.load();
      return;
    }
    const newTime = (value / 100) * resolvedDuration;
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const fallbackDuration =
    duration > 0
      ? duration
      : audioRef.current && Number.isFinite(audioRef.current.duration) && audioRef.current.duration > 0
        ? audioRef.current.duration
        : 0;
  const sliderValue = fallbackDuration > 0 ? Math.min((currentTime / fallbackDuration) * 100, 100) : 0;

  return (
    <div className="content-alerts-item">
      <div className="content-alerts-item__header">
        <span className="content-alerts-item__title">{getAlertFriendlyName(alert.id)}</span>
        <span className="content-alerts-item__filename">{alert.filename}</span>
      </div>
      <div className="content-alerts-player">
        <button type="button" className={`content-alerts-playbutton ${playing ? 'is-playing' : ''}`} onClick={togglePlayback}>
          {playing ? (
            <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true" focusable="false">
              <rect x="0" y="0" width="4" height="16" rx="1.5" fill="#ffffff" />
              <rect x="10" y="0" width="4" height="16" rx="1.5" fill="#ffffff" />
            </svg>
          ) : (
            <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true" focusable="false">
              <path d="M2 1L15 9L2 17V1Z" fill="#ffffff" />
            </svg>
          )}
          <span className="sr-only">
            {playing ? 'Pause' : 'Play'} {getAlertFriendlyName(alert.id)}
          </span>
        </button>
        <div className="content-alerts-track">
          <input
            type="range"
            min={0}
            max={100}
            step={0.5}
            value={sliderValue}
            onChange={(e) => handleSeek(Number(e.target.value))}
            aria-label={`${getAlertFriendlyName(alert.id)} playback position`}
          />
        </div>
      </div>
      <audio ref={audioRef} src={alert.url} preload="auto" className="content-alerts-hidden-audio">
        Your browser does not support the audio element.
      </audio>
      <div
        className={`content-alerts-dropzone ${dragActive ? 'is-active' : ''} ${alertsSaving ? 'is-disabled' : ''}`}
        onDragEnter={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!alertsSaving) setDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragActive(false);
          if (alertsSaving) return;
          const file = event.dataTransfer.files?.[0] ?? null;
          void onUpload(alert.id, file);
        }}
      >
        <div className="content-alerts-dropzone__title">
          {alertsSaving ? 'Uploading…' : 'Drop MP3 here'}
        </div>
        <div className="content-alerts-dropzone__meta">or click to upload</div>
        <input
          type="file"
          accept="audio/mpeg,audio/mp3"
          disabled={alertsSaving}
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            void onUpload(alert.id, file);
            e.target.value = '';
          }}
        />
      </div>
      <div className="content-alerts-actions">
        <button
          type="button"
          className="secondary"
          disabled={!alert.hasBackup || alertsSaving}
          onClick={() => {
            void onRevert(alert.id);
          }}
        >
          Revert to original
        </button>
      </div>
    </div>
  );
}

function resolveAccountKey(account: SpotifyAccountConfig | undefined | null): string | null {
  if (!account) return null;
  return account.id ?? account.user ?? account.email ?? account.displayName ?? account.name ?? null;
}

const createEmptyStorageForm = (): StorageFormState => ({
  name: '',
  server: '',
  folder: '',
  type: 'cifs',
  username: '',
  password: '',
  guest: false,
});

const createEmptyCustomRadioForm = (): CustomRadioFormState => ({
  name: '',
  stream: '',
  coverurl: '',
});

const createEmptyBridgeForm = (): BridgeFormState => ({
  provider: 'musicassistant',
  host: '127.0.0.1',
  port: 8095,
  apiKey: '',
  userToken: '',
  deezerArl: '',
  tidalAccessToken: '',
  tidalCountryCode: 'US',
});

const createEmptyLineInForm = (): LineInFormState => ({
  name: '',
  iconType: LineInIconType.CdPlayer,
  sourceType: 'bridge',
  metadataEnabled: true,
  draftId: createLineInId(),
  sendspinClientId: '',
  bridgeId: '',
  captureDeviceId: '',
  ingestSampleRate: '',
  ingestResampler: 'sinc-fast',
  vadThresholdDb: '-45',
  vadHoldMs: '2000',
});

const normalizeLineInInputs = (inputs: LineInInputConfig[]): LineInInputConfig[] => {
  return inputs.map((entry, index) => ({
    id: entry.id ?? `linein-${index}-${entry.name ?? 'input'}`,
    name: entry.name,
    iconType: typeof entry.iconType === 'number' ? entry.iconType : LineInIconType.CdPlayer,
    metadataEnabled: typeof entry.metadataEnabled === 'boolean' ? entry.metadataEnabled : true,
    source: {
      type: entry.source?.type ?? 'bridge',
      ...(entry.source ?? {}),
    },
  }));
};

function normalizeBridge(bridge: SpotifyBridgeConfig): SpotifyBridgeConfig {
  const provider = (bridge.provider || '').toLowerCase();
  if (provider === 'musicassistant') {
    return { ...bridge, provider: 'musicassistant' };
  }
  return bridge;
}

function resolveBridgeLogoUrl(provider?: string | null): string | null {
  const normalized = provider?.toLowerCase();
  switch (normalized) {
    case 'musicassistant':
      return '/providers/music-assistant.png';
    case 'applemusic':
      return '/providers/apple-music.svg';
    case 'deezer':
      return '/providers/deezer.svg';
    case 'tidal':
      return '/providers/tidal.svg';
    default:
      return null;
  }
}

function sortStorages(entries: LibraryStorage[]): LibraryStorage[] {
  return [...entries].sort((a, b) => {
    const left = (a.name || `${a.server}/${a.folder}` || '').toLowerCase();
    const right = (b.name || `${b.server}/${b.folder}` || '').toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

export default function ContentView(): JSX.Element {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [radioUsername, setRadioUsername] = React.useState('');
  const [initialRadioUsername, setInitialRadioUsername] = React.useState('');
  const [radioSaving, setRadioSaving] = React.useState(false);
  const [radioFeedback, setRadioFeedback] = React.useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );
  const [radioPresetCount, setRadioPresetCount] = React.useState<number | null>(null);
  const [radioValidationMessage, setRadioValidationMessage] = React.useState<string | null>(null);
  const [radioValidationStatus, setRadioValidationStatus] = React.useState<'idle' | 'checking' | 'valid' | 'invalid' | 'error'>(
    'idle',
  );

  const [spotifyClientId, setSpotifyClientId] = React.useState('');
  const [initialSpotifyClientId, setInitialSpotifyClientId] = React.useState('');
  const [spotifySaving, setSpotifySaving] = React.useState(false);
  const [spotifyFeedback, setSpotifyFeedback] = React.useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );
  const [spotifyAccounts, setSpotifyAccounts] = React.useState<SpotifyAccountConfig[]>([]);
  const [deletingAccountId, setDeletingAccountId] = React.useState<string | null>(null);
  const [addingSpotifyAccount, setAddingSpotifyAccount] = React.useState(false);
  const [spotifyRefreshPending, setSpotifyRefreshPending] = React.useState(false);
  const [spotifyBridges, setSpotifyBridges] = React.useState<SpotifyBridgeConfig[]>([]);
  const [bridgeModalOpen, setBridgeModalOpen] = React.useState(false);
  const [bridgeEditingId, setBridgeEditingId] = React.useState<string | null>(null);
  const [bridgeEditingLabel, setBridgeEditingLabel] = React.useState<string | null>(null);
  const [bridgeForm, setBridgeForm] = React.useState<BridgeFormState>(() => createEmptyBridgeForm());
  const [bridgeSubmitting, setBridgeSubmitting] = React.useState(false);
  const [bridgeFeedback, setBridgeFeedback] = React.useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [bridgeDeletingId, setBridgeDeletingId] = React.useState<string | null>(null);

  const [libraryStatus, setLibraryStatus] = React.useState<ScanStatus | null>(null);
  const [libraryTrackCount, setLibraryTrackCount] = React.useState<number | null>(null);
  const [libraryAlbumCount, setLibraryAlbumCount] = React.useState<number | null>(null);
  const [libraryArtistCount, setLibraryArtistCount] = React.useState<number | null>(null);
  const [libraryLoading, setLibraryLoading] = React.useState(true);
  const [libraryError, setLibraryError] = React.useState<string | null>(null);
  const [libraryMessage, setLibraryMessage] = React.useState<string | null>(null);
  const [libraryActionPending, setLibraryActionPending] = React.useState(false);
  const [libraryCovers, setLibraryCovers] = React.useState<LibraryCoverSample[]>([]);
  const [libraryCoversLoading, setLibraryCoversLoading] = React.useState(true);
  const [libraryCoversError, setLibraryCoversError] = React.useState<string | null>(null);
  const libraryStatusRef = React.useRef<ScanStatus | null>(null);
  const [libraryUploading, setLibraryUploading] = React.useState(false);
  const [libraryUploadFeedback, setLibraryUploadFeedback] = React.useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );
  const [libraryDragActive, setLibraryDragActive] = React.useState(false);
  const libraryFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [libraryStorages, setLibraryStorages] = React.useState<LibraryStorage[]>([]);
  const [libraryStorageStats, setLibraryStorageStats] = React.useState<Record<string, StorageLibraryStats>>({});
  const [libraryStorageCovers, setLibraryStorageCovers] = React.useState<Record<string, LibraryCoverSample[]>>({});
  const [storageLoading, setStorageLoading] = React.useState(true);
  const [storageError, setStorageError] = React.useState<string | null>(null);
  const [deletingStorageId, setDeletingStorageId] = React.useState<string | null>(null);
  const [storageFeedback, setStorageFeedback] = React.useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );
  const [storageSubmitting, setStorageSubmitting] = React.useState(false);
  const [storageForm, setStorageForm] = React.useState<StorageFormState>(() => createEmptyStorageForm());
  const [storageModalOpen, setStorageModalOpen] = React.useState(false);
  const [lineInInputs, setLineInInputs] = React.useState<LineInInputConfig[]>([]);
  const [lineInModalOpen, setLineInModalOpen] = React.useState(false);
  const [lineInSubmitting, setLineInSubmitting] = React.useState(false);
  const [lineInEditingId, setLineInEditingId] = React.useState<string | null>(null);
  const [lineInForm, setLineInForm] = React.useState<LineInFormState>(() => createEmptyLineInForm());
  const [lineInStatuses, setLineInStatuses] = React.useState<Record<string, LineInBridgeStatus>>({});
  const [lineInBridges, setLineInBridges] = React.useState<LineInBridgeSummary[]>([]);
  const [lineInBridgesLoading, setLineInBridgesLoading] = React.useState(false);
  const [lineInBridgesError, setLineInBridgesError] = React.useState<string | null>(null);
  const [lineInBridgeDeletingId, setLineInBridgeDeletingId] = React.useState<string | null>(null);
  const [audioServerIp, setAudioServerIp] = React.useState<string>('');
  const [sendspinClients, setSendspinClients] = React.useState<SendspinClient[]>([]);
  const [sendspinLoading, setSendspinLoading] = React.useState(false);
  const [sendspinError, setSendspinError] = React.useState<string | null>(null);
  const [customRadios, setCustomRadios] = React.useState<CustomRadioEntry[]>([]);
  const [customRadioLoading, setCustomRadioLoading] = React.useState(true);
  const [customRadioError, setCustomRadioError] = React.useState<string | null>(null);
  const [customRadioSubmitting, setCustomRadioSubmitting] = React.useState(false);
  const [customRadioFeedback, setCustomRadioFeedback] = React.useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );
  const [customRadioForm, setCustomRadioForm] = React.useState<CustomRadioFormState>(() => createEmptyCustomRadioForm());
  const [customRadioModalOpen, setCustomRadioModalOpen] = React.useState(false);
  const [alerts, setAlerts] = React.useState<AlertFile[]>([]);
  const [alertsLoading, setAlertsLoading] = React.useState(true);
  const [alertsError, setAlertsError] = React.useState<string | null>(null);
  const [alertsSaving, setAlertsSaving] = React.useState(false);
  const [alertsMessage, setAlertsMessage] = React.useState<string | null>(null);
  const [activeAlertId, setActiveAlertId] = React.useState<string | null>(null);
  const [favoritesPurging, setFavoritesPurging] = React.useState(false);
  const [recentsPurging, setRecentsPurging] = React.useState(false);
  const [favoritesPurgeFeedback, setFavoritesPurgeFeedback] = React.useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [recentsPurgeFeedback, setRecentsPurgeFeedback] = React.useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [contentFilter, setContentFilter] = React.useState<ContentFilterKey>(() => {
    if (typeof window === 'undefined') return 'radio';
    const stored = window.localStorage.getItem('admin-content-filter') as ContentFilterKey | null;
    if (!stored) return 'radio';
    const allowed: ContentFilterKey[] = ['radio', 'library', 'spotify', 'linein', 'custom', 'system', 'alerts'];
    return allowed.includes(stored) ? stored : 'radio';
  });
  const spotifyAccountBaselineRef = React.useRef(0);
  const { push: pushAlert } = useGlobalAlert();
  const modalOpen = customRadioModalOpen || bridgeModalOpen || storageModalOpen || lineInModalOpen;
  const libraryCoverSlots = 6;
  const shareCoverSlots = 6;

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('admin-content-filter', contentFilter);
  }, [contentFilter]);

  const renderModal = React.useCallback(
    (node: React.ReactNode): React.ReactPortal | null => {
      if (typeof document === 'undefined') return null;
      return createPortal(node, document.body);
    },
    [],
  );

  const radioDirty = radioUsername !== initialRadioUsername;
  const spotifyDirty = spotifyClientId !== initialSpotifyClientId;
  const storageFormValid = React.useMemo(() => {
    return (
      storageForm.name.trim().length > 0 &&
      storageForm.server.trim().length > 0 &&
      storageForm.folder.trim().length > 0
    );
  }, [storageForm]);
  const customRadioFormValid = React.useMemo(() => {
    return customRadioForm.name.trim().length > 0 && customRadioForm.stream.trim().length > 0;
  }, [customRadioForm]);
  const bridgeFormValid = React.useMemo(() => {
    if (!bridgeForm.provider.trim()) return false;
    if (bridgeForm.provider === 'musicassistant') {
      return bridgeForm.host.trim().length > 0 && bridgeForm.apiKey.trim().length > 0;
    }
    if (bridgeForm.provider === 'applemusic') {
      return bridgeForm.userToken.trim().length > 0;
    }
    if (bridgeForm.provider === 'tidal') {
      return bridgeForm.tidalAccessToken.trim().length > 0;
    }
    return true;
  }, [bridgeForm]);
  const bridgeProviderLogoUrl = React.useMemo(
    () => resolveBridgeLogoUrl(bridgeForm.provider),
    [bridgeForm.provider],
  );
  const availableLineInBridges = React.useMemo(() => {
    return lineInBridges.filter((bridge) => {
      const assigned = bridge.assigned_input_id ?? null;
      if (!assigned) return true;
      return assigned === lineInEditingId;
    });
  }, [lineInBridges, lineInEditingId]);
  const activeLineInBridge = React.useMemo(() => {
    if (!lineInForm.bridgeId) return null;
    return lineInBridges.find((bridge) => bridge.bridge_id === lineInForm.bridgeId) ?? null;
  }, [lineInBridges, lineInForm.bridgeId]);
  const activeLineInBridgeDevices = activeLineInBridge?.capture_devices ?? [];
  const sendspinClientMap = React.useMemo(() => {
    const map = new Map<string, SendspinClient>();
    for (const client of sendspinClients) {
      if (client.clientId) {
        map.set(client.clientId, client);
      }
    }
    return map;
  }, [sendspinClients]);
  const sendspinAssignedMap = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const input of lineInInputs) {
      if (input.source?.type !== 'sendspin') continue;
      const clientId = typeof input.source?.clientId === 'string' ? input.source.clientId : '';
      if (!clientId) continue;
      const label = input.name || input.id || clientId;
      const list = map.get(clientId) ?? [];
      list.push(label);
      map.set(clientId, list);
    }
    return map;
  }, [lineInInputs]);

  const validateTuneIn = React.useCallback(
    async (value: string): Promise<{ ok: boolean; message?: string }> => {
      const trimmed = value.trim();
      if (!trimmed) {
        setRadioPresetCount(null);
        setRadioValidationMessage(null);
        setRadioValidationStatus('idle');
        return { ok: true };
      }
      setRadioValidationStatus('checking');
      setRadioValidationMessage(null);
      try {
        const result = await validateTuneInUsername(trimmed);
        if (result.valid) {
          const count = Number.isFinite(result.presetCount) ? Number(result.presetCount) : null;
          setRadioPresetCount(count);
          setRadioValidationStatus('valid');
          const message =
            count !== null
              ? `${count} preset${count === 1 ? '' : 's'} found.`
            : 'TuneIn username verified.';
          setRadioValidationMessage(message);
          return { ok: true, message };
        }
        setRadioPresetCount(null);
        setRadioValidationStatus('invalid');
        const message = result.message ?? 'TuneIn username not found.';
        setRadioValidationMessage(message);
        return { ok: false, message };
      } catch (err) {
        setRadioPresetCount(null);
        setRadioValidationStatus('error');
        const message = 'Unable to verify the TuneIn username right now.';
        setRadioValidationMessage(message);
        return { ok: false, message };
      }
    },
    [],
  );

  React.useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const cfg = (await getConfig()) as ContentConfigResponse;
        if (cancelled) return;
        const content = cfg.config?.content ?? {};
        const lineIn = cfg.config?.inputs?.lineIn?.inputs ?? [];
        const currentRadio = content.radio?.tuneInUsername ?? '';
        const currentSpotify = content.spotify?.clientId ?? '';
        const currentAudioServerIp = cfg.config?.system?.audioserver?.ip ?? '';
        setRadioUsername(currentRadio);
        setInitialRadioUsername(currentRadio);
        setSpotifyClientId(currentSpotify);
        setInitialSpotifyClientId(currentSpotify);
        setSpotifyAccounts(Array.isArray(content.spotify?.accounts) ? content.spotify!.accounts! : []);
        setSpotifyBridges(
          Array.isArray(content.spotify?.bridges)
            ? content.spotify!.bridges!.map((bridge) => normalizeBridge(bridge))
            : [],
        );
        setAudioServerIp(typeof currentAudioServerIp === 'string' ? currentAudioServerIp : '');
        setLineInInputs(Array.isArray(lineIn) ? normalizeLineInInputs(lineIn) : []);
        if (currentRadio.trim()) {
          void validateTuneIn(currentRadio);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load content configuration');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [validateTuneIn]);

  const refreshSpotifyAccounts = React.useCallback(async (): Promise<number | null> => {
    try {
      const cfg = (await getConfig()) as ContentConfigResponse;
      const accounts = Array.isArray(cfg.config?.content?.spotify?.accounts)
        ? cfg.config!.content!.spotify!.accounts!
        : [];
      setSpotifyAccounts(accounts);
      return accounts.length;
    } catch {
      return null;
    }
  }, []);

  const scheduleSpotifyAccountRefresh = React.useCallback((): void => {
    spotifyAccountBaselineRef.current = spotifyAccounts.length;
    setSpotifyRefreshPending(true);
  }, [spotifyAccounts.length]);

  React.useEffect(() => {
    if (!spotifyRefreshPending) return undefined;
    let cancelled = false;
    let attempts = 0;
    const tick = async (): Promise<void> => {
      const count = await refreshSpotifyAccounts();
      if (cancelled) return;
      attempts += 1;
      if (count !== null && count !== spotifyAccountBaselineRef.current) {
        setSpotifyRefreshPending(false);
        return;
      }
      if (attempts >= 6) {
        setSpotifyRefreshPending(false);
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshSpotifyAccounts, spotifyRefreshPending]);

  const refreshLibraryStatus = React.useCallback(
    async (withLoading = false): Promise<void> => {
      if (withLoading) {
        setLibraryLoading(true);
        setLibraryError(null);
      }
      try {
        const [statusPayload, localPayload] = await Promise.all([
          fetchLibraryStatus(),
          fetchLibraryStorageStatus('local'),
        ]);
        setLibraryStatus(statusPayload.status ?? 0);
        setLibraryTrackCount(localPayload.trackCount ?? null);
        setLibraryAlbumCount(localPayload.albumCount ?? null);
        setLibraryArtistCount(localPayload.artistCount ?? null);
      } catch (err) {
        setLibraryError(err instanceof Error ? err.message : 'Failed to load library status');
      } finally {
        setLibraryLoading(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    void refreshLibraryStatus(true);
  }, [refreshLibraryStatus]);

  React.useEffect(() => {
    const feeds = [
      radioFeedback,
      spotifyFeedback,
      bridgeFeedback,
      libraryUploadFeedback,
      storageFeedback,
      customRadioFeedback,
      favoritesPurgeFeedback,
      recentsPurgeFeedback,
      libraryMessage ? { type: 'success' as const, message: libraryMessage } : null,
      alertsMessage ? { type: 'success' as const, message: alertsMessage } : null,
      libraryError ? { type: 'error' as const, message: libraryError } : null,
      storageError ? { type: 'error' as const, message: storageError } : null,
      customRadioError ? { type: 'error' as const, message: customRadioError } : null,
      alertsError ? { type: 'error' as const, message: alertsError } : null,
      libraryCoversError ? { type: 'error' as const, message: libraryCoversError } : null,
    ].filter(Boolean) as { type: 'success' | 'error'; message: string }[];

    const latest = feeds[feeds.length - 1];
    if (latest) {
      pushAlert(latest);
    }
  }, [
    alertsError,
    alertsMessage,
    bridgeFeedback,
    customRadioError,
    customRadioFeedback,
    favoritesPurgeFeedback,
    libraryCoversError,
    libraryError,
    libraryMessage,
    libraryUploadFeedback,
    pushAlert,
    radioFeedback,
    recentsPurgeFeedback,
    spotifyFeedback,
    storageError,
    storageFeedback,
  ]);

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

  const refreshLibraryCovers = React.useCallback(async (withLoading = false): Promise<void> => {
    if (withLoading) {
      setLibraryCoversLoading(true);
      setLibraryCoversError(null);
    }
    try {
      const payload = await fetchLibraryStorageCovers('local', libraryCoverSlots);
      setLibraryCovers(Array.isArray(payload.covers) ? payload.covers : []);
    } catch (err) {
      setLibraryCovers([]);
      setLibraryCoversError(err instanceof Error ? err.message : 'Failed to load library covers');
    } finally {
      setLibraryCoversLoading(false);
    }
  }, [libraryCoverSlots]);

  React.useEffect(() => {
    void refreshLibraryCovers(true);
  }, [refreshLibraryCovers]);

  const refreshLibraryStorages = React.useCallback(async (): Promise<void> => {
    setStorageLoading(true);
    setStorageError(null);
    try {
      const payload = await fetchLibraryStorages();
      setLibraryStorages(sortStorages(Array.isArray(payload.storages) ? payload.storages : []));
    } catch (err) {
      setLibraryStorages([]);
      setStorageError(err instanceof Error ? err.message : 'Failed to load shares');
    } finally {
      setStorageLoading(false);
    }
  }, []);

  const handleDeleteLibraryStorage = React.useCallback(
    async (storageId: string): Promise<void> => {
      if (!storageId || deletingStorageId) return;
      const confirmDelete = window.confirm('Remove this library share?');
      if (!confirmDelete) return;
      setDeletingStorageId(storageId);
      try {
        await deleteLibraryStorage(storageId);
        await refreshLibraryStorages();
      } catch (err) {
        pushAlert({
          tone: 'error',
          title: 'Share removal failed',
          message: err instanceof Error ? err.message : 'Unable to remove library share.',
        });
      } finally {
        setDeletingStorageId(null);
      }
    },
    [deletingStorageId, pushAlert, refreshLibraryStorages],
  );

  React.useEffect(() => {
    void refreshLibraryStorages();
  }, [refreshLibraryStorages]);

  const refreshLibraryStorageDetails = React.useCallback(
    async (storages: LibraryStorage[]): Promise<void> => {
      if (storages.length === 0) {
        setLibraryStorageStats({});
        setLibraryStorageCovers({});
        return;
      }
      const statsMap: Record<string, StorageLibraryStats> = {};
      const coversMap: Record<string, LibraryCoverSample[]> = {};
      await Promise.all(
        storages.map(async (storage) => {
          try {
            const [status, covers] = await Promise.all([
              fetchLibraryStorageStatus(storage.id),
              fetchLibraryStorageCovers(storage.id, shareCoverSlots),
            ]);
            statsMap[storage.id] = {
              tracks: Number.isFinite(status.trackCount) ? Number(status.trackCount) : 0,
              albums: Number.isFinite(status.albumCount) ? Number(status.albumCount) : 0,
              artists: Number.isFinite(status.artistCount) ? Number(status.artistCount) : 0,
            };
            coversMap[storage.id] = Array.isArray(covers.covers) ? covers.covers : [];
          } catch {
            statsMap[storage.id] = { tracks: 0, albums: 0, artists: 0 };
            coversMap[storage.id] = [];
          }
        }),
      );
      setLibraryStorageStats(statsMap);
      setLibraryStorageCovers(coversMap);
    },
    [shareCoverSlots],
  );

  React.useEffect(() => {
    if (libraryStorages.length === 0) {
      setLibraryStorageStats({});
      setLibraryStorageCovers({});
      return;
    }
    void refreshLibraryStorageDetails(libraryStorages);
  }, [libraryStorages, refreshLibraryStorageDetails]);

  const refreshCustomRadios = React.useCallback(async (): Promise<void> => {
    setCustomRadioLoading(true);
    setCustomRadioError(null);
    try {
      const payload = await fetchCustomRadioStations();
      setCustomRadios(Array.isArray(payload.stations) ? payload.stations : []);
    } catch (err) {
      setCustomRadios([]);
      setCustomRadioError(err instanceof Error ? err.message : 'Failed to load custom streams');
    } finally {
      setCustomRadioLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshCustomRadios();
  }, [refreshCustomRadios]);

  const refreshAlerts = React.useCallback(async (): Promise<void> => {
    setAlertsLoading(true);
    setAlertsError(null);
    try {
      const payload = await fetchAlertFiles();
      setAlerts(Array.isArray(payload.alerts) ? payload.alerts : []);
    } catch (err) {
      setAlerts([]);
      setAlertsError(err instanceof Error ? err.message : 'Failed to load alerts');
    } finally {
      setAlertsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshAlerts();
  }, [refreshAlerts]);

  const openStorageModal = (): void => {
    setStorageModalOpen(true);
    setStorageFeedback(null);
  };

  const closeStorageModal = (resetFeedback = true): void => {
    setStorageModalOpen(false);
    if (resetFeedback) {
      setStorageFeedback(null);
    }
    setStorageForm(createEmptyStorageForm());
  };

  const openCustomRadioModal = (): void => {
    setCustomRadioModalOpen(true);
    setCustomRadioFeedback(null);
  };

  const closeCustomRadioModal = (resetFeedback = true): void => {
    setCustomRadioModalOpen(false);
    if (resetFeedback) {
      setCustomRadioFeedback(null);
    }
    setCustomRadioForm(createEmptyCustomRadioForm());
  };

  const openBridgeModal = (): void => {
    setBridgeModalOpen(true);
    setBridgeFeedback(null);
    setBridgeEditingId(null);
    setBridgeEditingLabel(null);
  };

  const openLineInModal = (input?: LineInInputConfig): void => {
    if (input) {
      const rawSource = input.source ?? {};
      const sourceRecord = rawSource as Record<string, unknown>;
      const sendspinClientId = typeof sourceRecord.clientId === 'string' ? sourceRecord.clientId : '';
      const bridgeId = typeof sourceRecord.bridge_id === 'string' ? sourceRecord.bridge_id : '';
      const captureDeviceId = typeof sourceRecord.capture_device === 'string' ? sourceRecord.capture_device : '';
      const ingestSampleRate =
        typeof sourceRecord.ingest_sample_rate === 'number'
          ? String(sourceRecord.ingest_sample_rate)
          : typeof sourceRecord.ingest_sample_rate === 'string'
            ? sourceRecord.ingest_sample_rate
            : '';
      const ingestResampler =
        typeof sourceRecord.ingest_resampler === 'string' ? sourceRecord.ingest_resampler : 'sinc-fast';
      const vadThresholdDb =
        typeof sourceRecord.vad_threshold_db === 'number' ? String(sourceRecord.vad_threshold_db) : '';
      const vadHoldMs =
        typeof sourceRecord.vad_hold_ms === 'number' ? String(sourceRecord.vad_hold_ms) : '';
      setLineInEditingId(input.id ?? null);
      setLineInForm({
        name: input.name ?? '',
        iconType: typeof input.iconType === 'number' ? input.iconType : LineInIconType.CdPlayer,
        sourceType: input.source?.type ?? 'bridge',
        metadataEnabled: typeof input.metadataEnabled === 'boolean' ? input.metadataEnabled : true,
        draftId: input.id ?? createLineInId(),
        sendspinClientId,
        bridgeId,
        captureDeviceId,
        ingestSampleRate,
        ingestResampler,
        vadThresholdDb,
        vadHoldMs,
      });
    } else {
      setLineInEditingId(null);
      setLineInForm(createEmptyLineInForm());
    }
    setLineInModalOpen(true);
  };

  const openBridgeEditModal = (bridge: SpotifyBridgeConfig): void => {
    setBridgeEditingId(bridge.id);
    setBridgeEditingLabel(bridge.label ?? bridge.id);
    setBridgeForm({
      provider: (bridge.provider?.toLowerCase() as BridgeFormState['provider']) || 'musicassistant',
      host: bridge.host ?? '127.0.0.1',
      port: bridge.port ?? 8095,
      apiKey: bridge.apiKey ?? '',
      userToken: bridge.userToken ?? '',
      deezerArl: bridge.deezerArl ?? '',
      tidalAccessToken: bridge.tidalAccessToken ?? '',
      tidalCountryCode: bridge.tidalCountryCode ?? 'US',
    });
    setBridgeFeedback(null);
    setBridgeModalOpen(true);
  };

  const closeBridgeModal = (resetFeedback = true): void => {
    setBridgeModalOpen(false);
    if (resetFeedback) {
      setBridgeFeedback(null);
    }
    setBridgeForm(createEmptyBridgeForm());
    setBridgeEditingId(null);
    setBridgeEditingLabel(null);
  };

  const closeLineInModal = (): void => {
    setLineInModalOpen(false);
    setLineInEditingId(null);
    setLineInForm(createEmptyLineInForm());
  };

  React.useEffect(() => {
    if (libraryStatus !== 1) return undefined;
    const timer = window.setInterval(() => {
      void refreshLibraryStatus(false);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [libraryStatus, refreshLibraryStatus]);

  React.useEffect(() => {
    const prev = libraryStatusRef.current;
    libraryStatusRef.current = libraryStatus;
    if (prev === 1 && libraryStatus === 0) {
      void refreshLibraryCovers(false);
    }
  }, [libraryStatus, refreshLibraryCovers]);

  const handleSaveRadio = async (): Promise<void> => {
    if (radioSaving) return;
    setRadioSaving(true);
    setRadioFeedback(null);
    try {
      const trimmed = radioUsername.trim();
      await updateContentConfig({
        radio: { tuneInUsername: trimmed || null },
      });
      setRadioUsername(trimmed);
      setInitialRadioUsername(trimmed);
      setRadioFeedback({ type: 'success', message: 'Radio content saved' });
      await validateTuneIn(trimmed);
    } catch (err) {
      setRadioFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save radio content',
      });
    } finally {
      setRadioSaving(false);
    }
  };

  const handleSaveSpotify = async (): Promise<void> => {
    if (!spotifyDirty || spotifySaving) return;
    setSpotifySaving(true);
    setSpotifyFeedback(null);
    try {
      await updateContentConfig({
        spotify: { clientId: spotifyClientId.trim() || null },
      });
      setInitialSpotifyClientId(spotifyClientId);
      setSpotifyFeedback({ type: 'success', message: 'Spotify content saved' });
    } catch (err) {
      setSpotifyFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save Spotify content',
      });
    } finally {
      setSpotifySaving(false);
    }
  };

  const handleDeleteSpotifyAccount = async (accountKey: string): Promise<void> => {
    if (!accountKey || deletingAccountId === accountKey) return;
    setDeletingAccountId(accountKey);
    setSpotifyFeedback(null);
    try {
      await deleteSpotifyAccount(accountKey);
      setSpotifyAccounts((prev) =>
        prev.filter((account) => resolveAccountKey(account) !== accountKey),
      );
      setSpotifyFeedback({ type: 'success', message: 'Spotify account removed' });
    } catch (err) {
      setSpotifyFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to remove Spotify account',
      });
    } finally {
      setDeletingAccountId(null);
    }
  };

  const handleAddSpotifyAccount = async (): Promise<void> => {
    if (addingSpotifyAccount) return;
    setAddingSpotifyAccount(true);
    setSpotifyFeedback(null);
    try {
      const { link } = await fetchSpotifyAuthLink();
      if (!link) {
        throw new Error('No auth link available');
      }
      window.open(link, '_blank', 'noopener,noreferrer');
      setSpotifyFeedback({
        type: 'success',
        message: 'Follow the Spotify login flow to complete account linking.',
      });
      scheduleSpotifyAccountRefresh();
    } catch (err) {
      setSpotifyFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to start Spotify login',
      });
    } finally {
      setAddingSpotifyAccount(false);
    }
  };

  const handleLibraryRescan = async (): Promise<void> => {
    setLibraryActionPending(true);
    setLibraryMessage(null);
    setLibraryError(null);
    try {
      await triggerLibraryRescan();
      setLibraryMessage('Library rescan started');
      await refreshLibraryStatus(false);
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : 'Failed to trigger rescan');
    } finally {
      setLibraryActionPending(false);
    }
  };

  const handleLibraryUploadFiles = async (files: DroppedUpload[]): Promise<void> => {
    if (libraryUploading) return;
    const audioFiles = files.filter((entry) => isAudioFilename(entry.file.name));
    if (audioFiles.length === 0) {
      setLibraryUploadFeedback({
        type: 'error',
        message: 'No supported audio files found.',
      });
      return;
    }
    setLibraryUploading(true);
    setLibraryUploadFeedback(null);
    setLibraryError(null);
    try {
      for (const entry of audioFiles) {
        const base64 = await fileToBase64(entry.file);
        const relativePath = normalizeRelativePath(
          entry.relativePath ?? entry.file.webkitRelativePath,
        );
        await uploadLibraryAudio(entry.file.name, base64, relativePath);
      }
      const skipped = files.length - audioFiles.length;
      const suffix = skipped > 0 ? ` (${skipped} skipped)` : '';
      setLibraryUploadFeedback({
        type: 'success',
        message: `Uploaded ${audioFiles.length} file${audioFiles.length === 1 ? '' : 's'}${suffix}. Library rescan started.`,
      });
      void refreshLibraryStatus(true);
    } catch (err) {
      setLibraryUploadFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to upload audio',
      });
    } finally {
      setLibraryUploading(false);
    }
  };

  const handleAddLibraryStorage = async (): Promise<void> => {
    if (storageSubmitting || !storageFormValid) return;
    setStorageSubmitting(true);
    setStorageFeedback(null);
    try {
      const payload = await createLibraryStorage({
        name: storageForm.name.trim(),
        server: storageForm.server.trim(),
        folder: storageForm.folder.trim(),
        type: 'cifs',
        guest: storageForm.guest,
        username: storageForm.guest ? undefined : storageForm.username.trim() || undefined,
        password: storageForm.guest ? undefined : storageForm.password.trim() || undefined,
      });
      setLibraryStorages((prev) => {
        const filtered = prev.filter((entry) => entry.id !== payload.storage.id);
        return sortStorages([...filtered, payload.storage]);
      });
      setStorageFeedback({ type: 'success', message: 'Share added successfully' });
      setStorageError(null);
      closeStorageModal(false);
    } catch (err) {
      setStorageFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to add share',
      });
    } finally {
      setStorageSubmitting(false);
    }
  };

  const updateStorageForm = (patch: Partial<StorageFormState>): void => {
    setStorageForm((prev) => ({ ...prev, ...patch }));
  };
  const updateCustomRadioForm = (patch: Partial<CustomRadioFormState>): void => {
    setCustomRadioForm((prev) => ({ ...prev, ...patch }));
  };
  const updateBridgeForm = (patch: Partial<BridgeFormState>): void => {
    setBridgeForm((prev) => ({ ...prev, ...patch }));
  };

  const fileToBase64 = async (file: File): Promise<string> => {
    const buffer = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return window.btoa(binary);
  };

  const handleDropFiles = async (dataTransfer: DataTransfer): Promise<void> => {
    const files = await collectFilesFromDataTransfer(dataTransfer);
    if (files.length === 0) {
      setLibraryUploadFeedback({ type: 'error', message: 'No files detected in drop.' });
      return;
    }
    await handleLibraryUploadFiles(files);
  };

  const handleAlertUpload = async (alertId: string, file: File | null): Promise<void> => {
    if (!file) return;
    setAlertsSaving(true);
    setAlertsMessage(null);
    setAlertsError(null);
    try {
      const base64 = await fileToBase64(file);
      await uploadAlertFile(alertId, base64);
      await refreshAlerts();
      setAlertsMessage('Alert updated successfully');
    } catch (err) {
      setAlertsError(err instanceof Error ? err.message : 'Failed to update alert');
    } finally {
      setAlertsSaving(false);
    }
  };

  const handleAlertRevert = async (alertId: string): Promise<void> => {
    setAlertsSaving(true);
    setAlertsMessage(null);
    setAlertsError(null);
    try {
      await revertAlertFileApi(alertId);
      await refreshAlerts();
      setAlertsMessage('Alert restored to original');
    } catch (err) {
      setAlertsError(err instanceof Error ? err.message : 'Failed to revert alert');
    } finally {
      setAlertsSaving(false);
    }
  };

  const handleFavoritesPurge = async (): Promise<void> => {
    if (favoritesPurging) return;
    setFavoritesPurging(true);
    setFavoritesPurgeFeedback(null);
    try {
      await purgeFavorites();
      setFavoritesPurgeFeedback({ type: 'success', message: 'Favorites purged for all zones' });
    } catch (err) {
      setFavoritesPurgeFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to purge favorites',
      });
    } finally {
      setFavoritesPurging(false);
    }
  };

  const handleRecentsPurge = async (): Promise<void> => {
    if (recentsPurging) return;
    setRecentsPurging(true);
    setRecentsPurgeFeedback(null);
    try {
      await purgeRecents();
      setRecentsPurgeFeedback({ type: 'success', message: 'Recently played entries purged' });
    } catch (err) {
      setRecentsPurgeFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to purge recently played history',
      });
    } finally {
      setRecentsPurging(false);
    }
  };

  const handleCustomRadioAdd = async (): Promise<void> => {
    if (customRadioSubmitting || !customRadioFormValid) return;
    setCustomRadioSubmitting(true);
    setCustomRadioFeedback(null);
    try {
      const station = await createCustomRadioStation({
        name: customRadioForm.name.trim(),
        stream: customRadioForm.stream.trim(),
        coverurl: customRadioForm.coverurl.trim() || undefined,
      });
      setCustomRadios((prev) => [...prev, station]);
      setCustomRadioFeedback({ type: 'success', message: 'Station added' });
      setCustomRadioForm(createEmptyCustomRadioForm());
      closeCustomRadioModal(false);
    } catch (err) {
      setCustomRadioFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to add stream',
      });
    } finally {
      setCustomRadioSubmitting(false);
    }
  };

  const handleCustomRadioDelete = async (id: string): Promise<void> => {
    if (!id) return;
    setCustomRadioFeedback(null);
    try {
      await deleteCustomRadioStation(id);
      setCustomRadios((prev) => prev.filter((station) => station.id !== id));
      setCustomRadioFeedback({ type: 'success', message: 'Station removed' });
    } catch (err) {
      setCustomRadioFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to remove stream',
      });
    }
  };

  const handleBridgeAdd = async (): Promise<void> => {
    if (bridgeSubmitting || !bridgeFormValid) return;
    setBridgeSubmitting(true);
    setBridgeFeedback(null);
    const provider = bridgeForm.provider.toLowerCase() as BridgeFormState['provider'];
    const payload: CreateSpotifyBridgePayload = {
      provider,
    };
    if (bridgeEditingId) {
      payload.id = bridgeEditingId;
      if (bridgeEditingLabel) payload.label = bridgeEditingLabel;
    }
    if (provider === 'musicassistant') {
      payload.host = bridgeForm.host.trim() || '127.0.0.1';
      payload.port =
        typeof bridgeForm.port === 'number' && Number.isFinite(bridgeForm.port) && bridgeForm.port > 0
          ? Math.round(bridgeForm.port)
          : 8095;
      payload.apiKey = bridgeForm.apiKey.trim();
    }
    if (provider === 'applemusic') {
      if (bridgeForm.userToken.trim()) payload.userToken = bridgeForm.userToken.trim();
    }
    if (provider === 'deezer') {
      if (bridgeForm.deezerArl.trim()) payload.deezerArl = bridgeForm.deezerArl.trim();
    }
    if (provider === 'tidal') {
      if (bridgeForm.tidalAccessToken.trim()) {
        payload.tidalAccessToken = bridgeForm.tidalAccessToken.trim();
      }
      if (bridgeForm.tidalCountryCode.trim()) {
        payload.tidalCountryCode = bridgeForm.tidalCountryCode.trim().toUpperCase();
      }
    }
    try {
      const { bridge } = await createSpotifyBridge(payload);
      setSpotifyBridges((prev) => {
        const normalized = normalizeBridge(bridge);
        const filtered = prev.filter((b) => (b.id || '').toLowerCase() !== normalized.id.toLowerCase());
        return [...filtered, normalized];
      });
      setBridgeFeedback({ type: 'success', message: bridgeEditingId ? 'Bridge updated' : 'Bridge added' });
      closeBridgeModal(false);
    } catch (err) {
      setBridgeFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : bridgeEditingId ? 'Failed to update bridge' : 'Failed to add bridge',
      });
    } finally {
      setBridgeSubmitting(false);
    }
  };

  const handleBridgeDelete = async (id: string): Promise<void> => {
    if (!id || bridgeDeletingId === id) return;
    setBridgeDeletingId(id);
    setBridgeFeedback(null);
    try {
      await deleteSpotifyBridge(id);
      setSpotifyBridges((prev) => prev.filter((bridge) => bridge.id !== id));
      setBridgeFeedback({ type: 'success', message: 'Bridge removed' });
    } catch (err) {
      setBridgeFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to remove bridge',
      });
    } finally {
      setBridgeDeletingId(null);
    }
  };

  const persistLineInInputs = React.useCallback(
    async (inputs: LineInInputConfig[]): Promise<void> => {
      await updateInputsConfig({
        lineIn: {
          inputs: inputs.map((entry) => ({
            id: entry.id,
            name: entry.name,
            iconType: entry.iconType,
            metadataEnabled: entry.metadataEnabled,
            source: entry.source ?? {},
          })),
        },
      });
    },
    [],
  );

  const lineInBridgeRefreshInFlight = React.useRef(false);

  const refreshLineInBridges = React.useCallback(async (): Promise<void> => {
    if (lineInBridgeRefreshInFlight.current) return;
    lineInBridgeRefreshInFlight.current = true;
    setLineInBridgesLoading(true);
    setLineInBridgesError(null);
    const controller = new AbortController();
    let timedOut = false;
    const watchdog = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
      lineInBridgeRefreshInFlight.current = false;
      setLineInBridgesLoading(false);
      setLineInBridgesError('Bridge refresh timed out.');
    }, 5000);
    try {
      const bridges = await fetchLineInBridges(controller.signal);
      if (!timedOut) {
        setLineInBridges(bridges);
      }
    } catch (err) {
      if (!timedOut) {
        setLineInBridges([]);
        if (err instanceof Error && err.name === 'AbortError') {
          setLineInBridgesError('Bridge refresh timed out.');
        } else {
          setLineInBridgesError(err instanceof Error ? err.message : 'Unable to load bridges.');
        }
      }
    } finally {
      if (!timedOut) {
        window.clearTimeout(watchdog);
        lineInBridgeRefreshInFlight.current = false;
        setLineInBridgesLoading(false);
      }
    }
  }, []);

  const handleLineInBridgeDelete = React.useCallback(
    async (bridgeId: string): Promise<void> => {
      if (!bridgeId || lineInBridgeDeletingId === bridgeId) return;
      setLineInBridgeDeletingId(bridgeId);
      try {
        await deleteLineInBridge(bridgeId);
        setLineInBridges((prev) => prev.filter((bridge) => bridge.bridge_id !== bridgeId));
      } catch (err) {
        setLineInBridgesError(err instanceof Error ? err.message : 'Unable to delete bridge.');
      } finally {
        setLineInBridgeDeletingId(null);
      }
    },
    [lineInBridgeDeletingId],
  );

  const handleLineInSave = React.useCallback(async (): Promise<void> => {
    if (lineInSubmitting) return;
    const name = lineInForm.name.trim();
    if (!name) return;
    if (lineInForm.sourceType === 'sendspin' && !lineInForm.sendspinClientId.trim()) return;
    if (lineInForm.sourceType === 'bridge' && !lineInForm.bridgeId.trim()) {
      pushAlert({
        tone: 'error',
        title: 'Line-in update failed',
        message: 'Select a bridge before saving this line-in input.',
      });
      return;
    }
    setLineInSubmitting(true);
    try {
      const nextInputs = [...lineInInputs];
      if (lineInEditingId) {
        const idx = nextInputs.findIndex((entry) => entry.id === lineInEditingId);
        const nextSource: Record<string, unknown> = {
          ...(nextInputs[idx]?.source ?? {}),
          type: lineInForm.sourceType,
        };
        if (lineInForm.sourceType === 'sendspin' && lineInForm.sendspinClientId.trim()) {
          nextSource.clientId = lineInForm.sendspinClientId.trim();
        } else if ('clientId' in nextSource) {
          delete nextSource.clientId;
        }
        if (lineInForm.sourceType === 'bridge') {
          const threshold = parseNumberOrDefault(lineInForm.vadThresholdDb, -45);
          const holdMs = parseNumberOrDefault(lineInForm.vadHoldMs, 2000);
          const ingestSampleRate = parseNumberOrDefault(lineInForm.ingestSampleRate, 0);
          nextSource.bridge_id = lineInForm.bridgeId.trim();
          if (lineInForm.captureDeviceId.trim()) {
            nextSource.capture_device = lineInForm.captureDeviceId.trim();
          } else {
            delete nextSource.capture_device;
          }
          if (ingestSampleRate > 0) {
            nextSource.ingest_sample_rate = ingestSampleRate;
          } else {
            delete nextSource.ingest_sample_rate;
          }
          if (lineInForm.ingestResampler.trim()) {
            nextSource.ingest_resampler = lineInForm.ingestResampler.trim();
          } else {
            delete nextSource.ingest_resampler;
          }
          nextSource.vad_threshold_db = threshold;
          nextSource.vad_hold_ms = holdMs;
        } else {
          delete nextSource.vad_threshold_db;
          delete nextSource.vad_hold_ms;
          delete nextSource.bridge_id;
          delete nextSource.capture_device;
          delete nextSource.ingest_sample_rate;
          delete nextSource.ingest_resampler;
        }
        const nextEntry: LineInInputConfig = {
          id: lineInEditingId,
          name,
          iconType: lineInForm.iconType ?? LineInIconType.CdPlayer,
          metadataEnabled: lineInForm.metadataEnabled,
          source: nextSource,
        };
        if (idx >= 0) {
          nextInputs[idx] = nextEntry;
        } else {
          nextInputs.push(nextEntry);
        }
      } else {
        const nextId = lineInForm.draftId || createLineInId();
        const nextSource: Record<string, unknown> = { type: lineInForm.sourceType };
        if (lineInForm.sourceType === 'sendspin' && lineInForm.sendspinClientId.trim()) {
          nextSource.clientId = lineInForm.sendspinClientId.trim();
        }
        if (lineInForm.sourceType === 'bridge') {
          const threshold = parseNumberOrDefault(lineInForm.vadThresholdDb, -45);
          const holdMs = parseNumberOrDefault(lineInForm.vadHoldMs, 2000);
          const ingestSampleRate = parseNumberOrDefault(lineInForm.ingestSampleRate, 0);
          nextSource.bridge_id = lineInForm.bridgeId.trim();
          if (lineInForm.captureDeviceId.trim()) {
            nextSource.capture_device = lineInForm.captureDeviceId.trim();
          }
          if (ingestSampleRate > 0) {
            nextSource.ingest_sample_rate = ingestSampleRate;
          }
          if (lineInForm.ingestResampler.trim()) {
            nextSource.ingest_resampler = lineInForm.ingestResampler.trim();
          }
          nextSource.vad_threshold_db = threshold;
          nextSource.vad_hold_ms = holdMs;
        }
        nextInputs.push({
          id: nextId,
          name,
          iconType: lineInForm.iconType ?? LineInIconType.CdPlayer,
          metadataEnabled: lineInForm.metadataEnabled,
          source: nextSource,
        });
      }
      await persistLineInInputs(nextInputs);
      setLineInInputs(nextInputs);
      closeLineInModal();
    } catch (err) {
      pushAlert({
        tone: 'error',
        title: 'Line-in update failed',
        message: err instanceof Error ? err.message : 'Unable to update line-in inputs.',
      });
    } finally {
      setLineInSubmitting(false);
    }
  }, [closeLineInModal, lineInEditingId, lineInForm, lineInInputs, lineInSubmitting, persistLineInInputs, pushAlert]);

  const handleSendspinDiscovery = React.useCallback(async (): Promise<void> => {
    if (sendspinLoading) return;
    setSendspinLoading(true);
    setSendspinError(null);
    try {
      const clients = await discoverSendspinClients();
      setSendspinClients(clients);
      if (!clients.length) {
        setSendspinError('No Sendspin clients found.');
      }
    } catch (err) {
      setSendspinClients([]);
      setSendspinError(err instanceof Error ? err.message : 'Discovery failed');
    } finally {
      setSendspinLoading(false);
    }
  }, [sendspinLoading]);

  React.useEffect(() => {
    const needsSendspin = contentFilter === 'linein' || (lineInModalOpen && lineInForm.sourceType === 'sendspin');
    if (!needsSendspin) return;
    void handleSendspinDiscovery();
    const timer = window.setInterval(() => {
      void handleSendspinDiscovery();
    }, SENDSPIN_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [contentFilter, lineInModalOpen, lineInForm.sourceType, lineInInputs, handleSendspinDiscovery]);

  React.useEffect(() => {
    if (contentFilter !== 'linein' && !lineInModalOpen) return;
    void refreshLineInBridges();
    const timer = window.setInterval(() => {
      void refreshLineInBridges();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [contentFilter, lineInModalOpen, refreshLineInBridges]);

  React.useEffect(() => {
    if (contentFilter !== 'linein' || !lineInInputs.length) {
      return;
    }
    let isActive = true;
    const pollStatus = async () => {
      const results = await Promise.all(
        lineInInputs.map(async (input) => {
          const inputId = input.id ?? '';
          if (!inputId) return null;
          return await fetchLineInBridgeStatus(inputId);
        }),
      );
      if (!isActive) return;
      setLineInStatuses((prev) => {
        const next = { ...prev };
        for (const item of results) {
          if (item?.linein_id) {
            next[item.linein_id] = item;
          }
        }
        return next;
      });
    };
    void pollStatus();
    const timer = window.setInterval(pollStatus, LINEIN_STATUS_POLL_MS);
    return () => {
      isActive = false;
      window.clearInterval(timer);
    };
  }, [contentFilter, lineInInputs]);

  const handleLineInRemove = React.useCallback(
    async (inputId: string, inputName?: string): Promise<void> => {
      if (!inputId && !inputName) return;
      const nextInputs = lineInInputs.filter((entry) => {
        if (inputId) return entry.id !== inputId;
        return entry.name !== inputName;
      });
      try {
        await persistLineInInputs(nextInputs);
        setLineInInputs(nextInputs);
      } catch (err) {
        pushAlert({
          tone: 'error',
          title: 'Line-in update failed',
          message: err instanceof Error ? err.message : 'Unable to remove line-in input.',
        });
      }
    },
    [lineInInputs, persistLineInInputs, pushAlert],
  );

  if (loading) {
    return (
      <div className="content-layout">
        <div className="content-shell">
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="content-layout">
        <div className="content-shell">
          <p className="content-error">{error}</p>
        </div>
      </div>
    );
  }

  const statusMeta = formatScanStatus(libraryStatus);
  const renderHeroStatValue = (value: number | null, loadingState: boolean): string => {
    if (loadingState) return '…';
    if (value == null) return '–';
    return value.toString();
  };
  const heroStats = [
    { label: 'Custom streams', value: customRadios.length, loading: customRadioLoading },
    {
      label: 'Library tracks',
      value: libraryTrackCount ?? 0,
      loading: libraryLoading || libraryTrackCount == null,
    },
    { label: 'Spotify accounts', value: spotifyAccounts.length, loading: false },
    {
      label: 'Active bridges',
      value: spotifyBridges.filter((bridge) => bridge.enabled !== false).length,
      loading: false,
    },
  ];
  const hasSpotifyClientId = spotifyClientId.trim().length > 0;
  const clientIdStatusLabel = hasSpotifyClientId ? 'Client ID set' : 'Client ID required';
  const tuneInStatusLabel = (() => {
    switch (radioValidationStatus) {
      case 'checking':
        return 'Checking';
      case 'valid':
        return 'Verified';
      case 'invalid':
        return 'Not found';
      case 'error':
        return 'Error';
      default:
        return '';
    }
  })();
  const tuneInStatusTone =
    radioValidationStatus === 'valid' || radioValidationStatus === 'checking'
      ? 'active'
      : radioValidationStatus === 'invalid'
        ? 'warn'
        : radioValidationStatus === 'error'
          ? 'error'
          : 'idle';
  const visibleSpotifyAccounts = spotifyAccounts.filter(
    (account) =>
      resolveAccountKey(account) ||
      account.displayName ||
      account.name ||
      account.user ||
      account.email,
  );
  const visibleLibraryCovers = libraryCovers.slice(0, libraryCoverSlots);
  const libraryCoverPlaceholderCount = Math.max(libraryCoverSlots - visibleLibraryCovers.length, 0);

  return (
    <div className="content-layout">
      <div className="content-shell">
        <div className="content-hero">
          <div className="content-hero__copy">
            <p className="page-hero__eyebrow">AudioServer sources</p>
            <h1 className="page-hero__title">Content</h1>
            <p className="page-hero__subtitle">
              A consolidated view of AudioServer content: built-in Loxone services, external bridges, and alerts for your installation.
            </p>
          </div>
          <ul className="content-hero__stats">
            {heroStats.map((stat) => (
              <li key={stat.label}>
                <span className="content-hero__stat-label">{stat.label}</span>
                <span className="content-hero__stat-value">{renderHeroStatValue(stat.value, stat.loading)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="content-filter-bar">
          <div className="content-filter-actions" role="tablist" aria-label="Content sections">
            <button
              type="button"
              className={`content-filter-chip${contentFilter === 'radio' ? ' is-active' : ''}`}
              onClick={() => setContentFilter('radio')}
              role="tab"
              aria-selected={contentFilter === 'radio'}
            >
              Radio
            </button>
            <button
              type="button"
              className={`content-filter-chip${contentFilter === 'library' ? ' is-active' : ''}`}
              onClick={() => setContentFilter('library')}
              role="tab"
              aria-selected={contentFilter === 'library'}
            >
              Library
            </button>
            <button
              type="button"
              className={`content-filter-chip${contentFilter === 'linein' ? ' is-active' : ''}`}
              onClick={() => setContentFilter('linein')}
              role="tab"
              aria-selected={contentFilter === 'linein'}
            >
              Line-in
            </button>
            <button
              type="button"
              className={`content-filter-chip${contentFilter === 'spotify' ? ' is-active' : ''}`}
              onClick={() => setContentFilter('spotify')}
              role="tab"
              aria-selected={contentFilter === 'spotify'}
            >
              Spotify
            </button>
            <button
              type="button"
              className={`content-filter-chip${contentFilter === 'custom' ? ' is-active' : ''}`}
              onClick={() => setContentFilter('custom')}
              role="tab"
              aria-selected={contentFilter === 'custom'}
            >
              Custom services
            </button>
            <button
              type="button"
              className={`content-filter-chip${contentFilter === 'system' ? ' is-active' : ''}`}
              onClick={() => setContentFilter('system')}
              role="tab"
              aria-selected={contentFilter === 'system'}
            >
              System services
            </button>
            <button
              type="button"
              className={`content-filter-chip${contentFilter === 'alerts' ? ' is-active' : ''}`}
              onClick={() => setContentFilter('alerts')}
              role="tab"
              aria-selected={contentFilter === 'alerts'}
            >
              Alerts
            </button>
          </div>
        </div>
      {contentFilter === 'radio' && (
        <section className="content-section">
          <header className="content-section__header">
            <div>
              <p className="content-section__eyebrow">Music sources</p>
              <h2>Radio content</h2>
              <p>
                TuneIn powers the radio catalog—adding a TuneIn username exposes your personal presets, while search scans the
                full TuneIn service. Custom streams are also supported.
              </p>
            </div>
          </header>
          <div className="content-section__body">
            <div className="content-grid content-grid--radio">
              <article className="content-card content-card--radio">
                <header>
                  <div>
                    <h3>TuneIn</h3>
                    <p>Add your TuneIn username to expose your personal presets. If left empty, demo presets will be shown.</p>
                  </div>
                </header>
                <div className="content-pane__section">
                  <div className="content-radio-body">
                    <div className="content-radio-main">
                      <div className="content-form">
                        <label htmlFor="tunein-username">TuneIn username</label>
                        <input
                          id="tunein-username"
                          type="text"
                          autoComplete="off"
                          value={radioUsername}
                          onChange={(e) => {
                            setRadioUsername(e.target.value);
                            setRadioPresetCount(null);
                            setRadioValidationMessage(null);
                            setRadioValidationStatus('idle');
                            setRadioFeedback(null);
                          }}
                          onBlur={() => {
                            void validateTuneIn(radioUsername);
                          }}
                          placeholder="e.g. mytuneinaccount"
                        />
                      </div>
                    </div>
                    {(radioValidationStatus !== 'idle' || radioValidationMessage) && (
                      <div className="content-radio-meta">
                        <div className="content-tunein-status">
                          {radioValidationStatus !== 'idle' && (
                            <span className={`content-status-pill tone-${tuneInStatusTone}`}>
                              {tuneInStatusLabel}
                            </span>
                          )}
                          {radioValidationStatus === 'valid' && typeof radioPresetCount === 'number' && (
                            <span className="content-tunein-count">
                              {radioPresetCount} preset{radioPresetCount === 1 ? '' : 's'}
                            </span>
                          )}
                          {radioValidationStatus === 'checking' && (
                            <span className="content-tunein-message">Checking presets…</span>
                          )}
                          {radioValidationStatus !== 'checking' &&
                            radioValidationMessage &&
                            (radioValidationStatus !== 'valid' || radioPresetCount == null) && (
                            <span
                              className={
                                radioValidationStatus === 'invalid' || radioValidationStatus === 'error'
                                  ? 'content-tunein-message is-error'
                                  : 'content-tunein-message'
                              }
                            >
                              {radioValidationMessage}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="content-actions">
                    <button
                      type="button"
                      className="secondary"
                      onPointerDown={() => {
                        void handleSaveRadio();
                      }}
                      onClick={() => {
                        void handleSaveRadio();
                      }}
                      disabled={radioSaving}
                    >
                        {radioSaving ? 'Saving…' : 'Save'}
                    </button>
                    {/* feedback routed to global alert */}
                  </div>
                </div>
              </article>
              <article className="content-card content-card--radio">
                <header>
                  <div>
                    <h3>Custom streams</h3>
                    <p>Configure custom streams here or using the Loxone app.</p>
                  </div>
                </header>
                <div className="content-pane__section">
                  <div className="content-radio-body">
                    <div className="content-radio-main">
                      {!customRadioModalOpen && customRadioFeedback && (
                        <></>
                      )}
                      {customRadioLoading ? (
                        <p className="content-body-copy content-body-copy--muted">Loading custom streams…</p>
                      ) : customRadioError ? (
                        <></>
                      ) : customRadios.length > 0 ? (
                        <ul className="content-custom-radio-list">
                          {customRadios.map((station) => (
                            <li key={station.id}>
                              <div className="content-custom-radio-item">
                                {station.coverurl && (
                                  <div className="content-custom-radio-coverart">
                                    <img src={station.coverurl} alt={`${station.name} cover`} />
                                  </div>
                                )}
                                <div className="content-custom-radio-info">
                                  <span className="content-custom-radio-name">{station.name}</span>
                                  <a
                                    className="content-custom-radio-stream"
                                    href={station.stream}
                                    target="_blank"
                                    rel="noreferrer"
                                    title={station.stream}
                                  >
                                    {station.stream}
                                  </a>
                                  {station.coverurl && (
                                    <a
                                      className="content-custom-radio-cover"
                                      href={station.coverurl}
                                      target="_blank"
                                      rel="noreferrer"
                                      title={station.coverurl}
                                    >
                                      {station.coverurl}
                                    </a>
                                  )}
                                </div>
                                <button type="button" className="danger-link" onClick={() => handleCustomRadioDelete(station.id)}>
                                  Remove
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <ul className="content-custom-radio-list">
                          <li>
                            <div className="content-custom-radio-item content-custom-radio-item--empty">
                              <div className="content-custom-radio-info">
                                <span className="content-custom-radio-name">No custom streams yet</span>
                                <span className="content-custom-radio-stream">Add one to make it available in Loxone.</span>
                              </div>
                            </div>
                          </li>
                        </ul>
                      )}
                    </div>
                    <div className="content-radio-meta">
                      <div className="content-tunein-status content-custom-radio-status content-custom-radio-status--bottom">
                        <span className="content-tunein-count">
                          {customRadioLoading
                          ? 'Loading…'
                          : `${customRadios.length} stream${customRadios.length === 1 ? '' : 's'} configured`}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="content-actions">
                    <button type="button" className="secondary" onClick={openCustomRadioModal}>
                      Add custom stream
                    </button>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </section>
      )}

      {contentFilter === 'spotify' && (
        <section className="content-section">
          <header className="content-section__header">
            <div>
              <p className="content-section__eyebrow">Music sources</p>
              <h2>Spotify</h2>
              <p>
                Multi-account Spotify is supported out of the box. Create a Spotify app, copy the Client ID, and paste it here.
                No client secret is needed. You can link accounts here or in the Loxone app after the Client ID is set.
              </p>
            </div>
          </header>
          <div className="content-section__body">
            <div className="content-grid content-grid--spotify">
              <article className="content-card">
                <header>
                  <div>
                    <h3>Client ID</h3>
                    <p className="content-body-copy content-body-copy--muted">
                      Configure the Spotify app details and paste the Client ID below.
                    </p>
                  </div>
                </header>
                <div className="content-pane__section content-spotify-card">
                  <div className="content-spotify-body">
                    <div className="content-form">
                      <div className="content-input-hint">
                        Create a new app at{' '}
                        <a href="https://developer.spotify.com/dashboard/create" target="_blank" rel="noreferrer">
                          developer.spotify.com/dashboard/create
                        </a>
                        .
                      </div>
                      <table className="content-input-table">
                        <tbody>
                          <tr>
                            <th scope="row">App name</th>
                            <td><code>lox-audioserver</code></td>
                          </tr>
                          <tr>
                            <th scope="row">Redirect URI</th>
                            <td><code>https://rudyberends.github.io/lox-audioserver/spotify-callback</code></td>
                          </tr>
                          <tr>
                            <th scope="row">Enable APIs</th>
                            <td>Web API, Web Playback SDK</td>
                          </tr>
                        </tbody>
                      </table>
                      <label htmlFor="spotify-client-id">Input your client id here</label>
                      <input
                        id="spotify-client-id"
                        type="text"
                        autoComplete="off"
                        value={spotifyClientId}
                        onChange={(e) => setSpotifyClientId(e.target.value)}
                        placeholder="26faeb2006ba44ed89ac34f9344670e2"
                      />
                    </div>
                  </div>
                  <div className="content-actions content-actions--spaced">
                    <button type="button" className="primary" onClick={handleSaveSpotify} disabled={!spotifyDirty || spotifySaving}>
                      {spotifySaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              </article>
              <article className="content-card">
                <header>
                  <div>
                    <h3>Accounts</h3>
                    <p className="content-body-copy content-body-copy--muted">
                      Link Spotify accounts here or in the Loxone app.
                    </p>
                  </div>
                </header>
                <div className="content-pane__section content-spotify-card">
                  <div className="content-spotify-body">
                    {visibleSpotifyAccounts.length > 0 ? (
                      <div className="content-account-list">
                        <span className="content-account-list__label">Configured accounts</span>
                        <ul>
                          {visibleSpotifyAccounts.map((account, index) => {
                            const accountKey = resolveAccountKey(account) ?? `account-${index}`;
                            const removableKey = resolveAccountKey(account);
                            return (
                              <li key={accountKey}>
                                <div className="content-account-details">
                                  <span className="content-account-name">{account.displayName ?? account.name ?? account.user}</span>
                                  {account.email && <span className="content-account-meta">{account.email}</span>}
                                </div>
                                {removableKey && (
                                  <button
                                    type="button"
                                    className="content-account-remove"
                                    onClick={() => handleDeleteSpotifyAccount(removableKey)}
                                    disabled={deletingAccountId === removableKey}
                                  >
                                    {deletingAccountId === removableKey ? 'Removing…' : 'Remove'}
                                  </button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : (
                      <div className="content-empty-panel">
                        <span className="content-empty-title">No Spotify accounts linked yet.</span>
                        <span className="content-empty-note">Add one to enable Spotify sources in Loxone.</span>
                      </div>
                    )}
                  </div>
                  <div className="content-actions content-actions--spotify">
                    <span className="content-note content-note--spotify">
                      Spotify login may be blocked by popup blockers; allow popups to complete linking.
                    </span>
                    <button
                      type="button"
                      className="secondary"
                      onClick={handleAddSpotifyAccount}
                      disabled={addingSpotifyAccount || !hasSpotifyClientId}
                    >
                      {addingSpotifyAccount ? 'Opening…' : 'Add Spotify account'}
                    </button>
                  </div>
                </div>
                {/* feedback routed to global alert */}
              </article>
            </div>
          </div>
        </section>
      )}

      {contentFilter === 'library' && (
        <section className="content-section">
          <header className="content-section__header">
            <div>
              <p className="content-section__eyebrow">Music sources</p>
              <h2>Library</h2>
              <p>
                Loxone supports local and network libraries—we emulate the same experience. Drop files under
                <code>data/music/local</code>, upload audio here, or add network shares here or in the Loxone app.
              </p>
              <div className="content-section__actions">
                <button type="button" className="secondary" onClick={openStorageModal}>
                  Add share
                </button>
              </div>
            </div>
          </header>
          <div className="content-section__body">
            <div className="content-grid">
              <article className="content-card content-card--library">
                <header className="content-card__header content-card__header--stacked">
                  <div className="content-card__header-row">
                    <h3>Local library</h3>
                    <button
                      type="button"
                      className="content-library-rescan content-library-rescan--header"
                      onClick={handleLibraryRescan}
                      disabled={libraryActionPending}
                    >
                      <span className="content-library-rescan__label">
                        {libraryActionPending ? 'Rescanning…' : 'Rescan'}
                      </span>
                    </button>
                  </div>
                  <div className="content-library-header-meta">
                    <div className="content-library-coverstrip" aria-label="Library cover art">
                      <div className="content-library-covers content-library-covers--compact">
                        {visibleLibraryCovers.map((cover, index) => (
                          <div
                            key={`${cover.album}-${cover.artist}-${index}`}
                            className="content-library-cover content-library-cover--compact"
                            title={`${cover.album} · ${cover.artist}`}
                          >
                            <img src={cover.coverurl} alt={`${cover.album} cover`} loading="lazy" />
                          </div>
                        ))}
                        {Array.from({ length: libraryCoverPlaceholderCount }).map((_, index) => (
                          <div
                            key={`library-cover-placeholder-${index}`}
                            className="content-library-cover content-library-cover--compact content-library-cover--dummy"
                            aria-hidden="true"
                          />
                        ))}
                      </div>
                    </div>
                    <div className="content-library-stats">
                      <div className="content-library-stats__item">
                        <span className="content-library-stats__label">Tracks</span>
                        <span className="content-library-stats__value">
                          {libraryLoading ? '—' : libraryTrackCount ?? 0}
                        </span>
                      </div>
                      <div className="content-library-stats__item">
                        <span className="content-library-stats__label">Albums</span>
                        <span className="content-library-stats__value">
                          {libraryLoading ? '—' : libraryAlbumCount ?? 0}
                        </span>
                      </div>
                      <div className="content-library-stats__item">
                        <span className="content-library-stats__label">Artists</span>
                        <span className="content-library-stats__value">
                          {libraryLoading ? '—' : libraryArtistCount ?? 0}
                        </span>
                      </div>
                    </div>
                  </div>
                </header>
                <div className="content-pane__section">
                  <div
                    className={`content-dropzone ${libraryDragActive ? 'is-active' : ''} ${
                      libraryUploading ? 'is-disabled' : ''
                    }`}
                    role="button"
                    tabIndex={libraryUploading ? -1 : 0}
                    onClick={() => {
                      if (libraryUploading) return;
                      libraryFileInputRef.current?.click();
                    }}
                    onKeyDown={(event) => {
                      if (libraryUploading) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        libraryFileInputRef.current?.click();
                      }
                    }}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!libraryUploading) setLibraryDragActive(true);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect = 'copy';
                    }}
                    onDragLeave={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setLibraryDragActive(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setLibraryDragActive(false);
                      if (libraryUploading) return;
                      void handleDropFiles(event.dataTransfer);
                    }}
                  >
                    <div className="content-dropzone__title">
                      <span className="content-dropzone__icon" aria-hidden="true">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                          <path d="M12 3v10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                          <path d="M8 7l4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M4 14v3.2A2.8 2.8 0 0 0 6.8 20h10.4A2.8 2.8 0 0 0 20 17.2V14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                      </span>
                      {libraryUploading ? 'Uploading…' : 'Drop audio here'}
                    </div>
                    <div className="content-dropzone__meta">or click to select a file</div>
                    <div className="content-dropzone__hint">MP3, FLAC, M4A, AAC, OGG, WAV</div>
                    <input
                      type="file"
                      accept="audio/mp3,audio/flac,audio/x-flac,audio/m4a,audio/aac,audio/ogg,audio/wav"
                      multiple
                      ref={libraryFileInputRef}
                      disabled={libraryUploading}
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []).map((file) => ({
                          file,
                          relativePath: normalizeRelativePath(file.webkitRelativePath),
                        }));
                        void handleLibraryUploadFiles(files);
                        e.target.value = '';
                      }}
                    />
                  </div>
                </div>
              </article>
              {storageLoading ? (
                <article className="content-card">
                  <p className="content-body-copy content-body-copy--muted">Loading shares…</p>
                </article>
              ) : storageError ? (
                <article className="content-card">
                  <p className="content-body-copy content-body-copy--muted">Unable to load shares.</p>
                </article>
              ) : libraryStorages.length > 0 ? (
                <>
                  {libraryStorages.map((storage) => {
                    const shareStats = libraryStorageStats[storage.id];
                    const shareCovers = libraryStorageCovers[storage.id] ?? [];
                    const visibleShareCovers = shareCovers.slice(0, shareCoverSlots);
                    const shareCoverPlaceholderCount = Math.max(
                      shareCoverSlots - visibleShareCovers.length,
                      0,
                    );

                    return (
                      <article key={storage.id} className="content-card content-card--library content-card--share">
                        <header className="content-card__header">
                          <div className="content-card__header-row">
                            <div className="content-share-title">
                              <h3>
                                {storage.name}
                                {storage.server && !storage.name.includes(storage.server) ? ` (${storage.server})` : ''}
                              </h3>
                            </div>
                            <button
                              type="button"
                              className="content-library-rescan content-library-rescan--header"
                              onClick={handleLibraryRescan}
                              disabled={libraryActionPending}
                            >
                              <span className="content-library-rescan__label">
                                {libraryActionPending ? 'Rescanning…' : 'Rescan'}
                              </span>
                            </button>
                          </div>
                        </header>
                        <div className="content-library-header-meta content-library-header-meta--share">
                          <div
                            className="content-library-coverstrip content-library-coverstrip--share"
                            aria-label={`${storage.name} library`}
                          >
                            <div className="content-library-covers content-library-covers--compact">
                              {visibleShareCovers.map((cover, index) => (
                                <div
                                  key={`${storage.id}-${cover.album}-${cover.artist}-${index}`}
                                  className="content-library-cover content-library-cover--compact"
                                  title={`${cover.album} · ${cover.artist}`}
                                >
                                  <img src={cover.coverurl} alt={`${cover.album} cover`} loading="lazy" />
                                </div>
                              ))}
                              {Array.from({ length: shareCoverPlaceholderCount }).map((_, index) => (
                                <div
                                  key={`${storage.id}-dummy-${index}`}
                                  className="content-library-cover content-library-cover--compact content-library-cover--dummy"
                                  aria-hidden="true"
                                />
                              ))}
                            </div>
                          </div>
                          <div className="content-library-stats content-library-stats--share">
                            <div className="content-library-stats__item">
                              <span className="content-library-stats__label">Tracks</span>
                              <span className="content-library-stats__value">
                                {shareStats ? shareStats.tracks : '—'}
                              </span>
                            </div>
                            <div className="content-library-stats__item">
                              <span className="content-library-stats__label">Albums</span>
                              <span className="content-library-stats__value">
                                {shareStats ? shareStats.albums : '—'}
                              </span>
                            </div>
                            <div className="content-library-stats__item">
                              <span className="content-library-stats__label">Artists</span>
                              <span className="content-library-stats__value">
                                {shareStats ? shareStats.artists : '—'}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="content-pane__section">
                          <div className="content-share-info">
                            <div className="content-share-meta-list">
                              <div className="content-share-meta-item">
                                <span className="content-share-meta-label">Server</span>
                                <span className="content-share-meta-value">{storage.server || '—'}</span>
                              </div>
                              <div className="content-share-meta-item">
                                <span className="content-share-meta-label">Share</span>
                                <span className="content-share-meta-value">
                                  {storage.folder ? `/${storage.folder}` : 'Share root'}
                                </span>
                              </div>
                              <div className="content-share-meta-item">
                                <span className="content-share-meta-label">Access</span>
                                <span className="content-share-meta-value">
                                  {storage.guest
                                    ? 'Guest'
                                    : storage.username
                                      ? `User: ${storage.username}`
                                      : 'Credentials required'}
                                </span>
                              </div>
                            </div>
                            <div className="content-share-actions">
                              <button
                                type="button"
                                className="danger-link"
                                onClick={() => handleDeleteLibraryStorage(storage.id)}
                                disabled={deletingStorageId === storage.id}
                              >
                                {deletingStorageId === storage.id ? 'Removing…' : 'Remove'}
                              </button>
                            </div>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </>
              ) : (
                <article className="content-card">
                  <header>
                    <div>
                      <h3>No shares yet</h3>
                      <p className="content-body-copy content-body-copy--muted">
                        Add a share to expose remote music folders to the library.
                      </p>
                    </div>
                  </header>
                </article>
              )}
            </div>
          </div>
        </section>
      )}

      {contentFilter === 'custom' && (
        <section className="content-section">
          <header className="content-section__header">
            <div>
              <p className="content-section__eyebrow">Music sources</p>
              <h2>Custom services</h2>
              <p>
                Loxone only supports Spotify. To expose other services inside the app we introduce bridge providers. Each bridge
                maps one external service to one virtual Spotify account so Loxone can list multiple unsupported sources.
              </p>
              <div className="content-section__actions">
                <button type="button" className="secondary" onClick={openBridgeModal}>
                  Add bridge
                </button>
              </div>
            </div>
          </header>
          <div className="content-section__body">
            <div className="content-grid">
              {spotifyBridges.length > 0 ? (
                spotifyBridges.map((bridge) => {
                  const logoUrl = resolveBridgeLogoUrl(bridge.provider);
                  return (
                    <article key={bridge.id} className="content-card">
                      <header className="content-card__header content-card__header--split">
                        <div>
                          <div className="content-linein-title">
                            {logoUrl && (
                              <img
                                className="content-bridge-logo"
                                src={logoUrl}
                                alt=""
                                loading="lazy"
                                aria-hidden="true"
                              />
                            )}
                            <div className="content-linein-title-text">
                              <h3>{bridge.label ?? bridge.id}</h3>
                              <p className="content-linein-id" title={bridge.id}>
                                {bridge.id}
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="content-linein-actions">
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => openBridgeEditModal(bridge)}
                            disabled={bridgeDeletingId === bridge.id}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger-link"
                            onClick={() => handleBridgeDelete(bridge.id)}
                            disabled={bridgeDeletingId === bridge.id}
                          >
                            {bridgeDeletingId === bridge.id ? 'Removing…' : 'Remove'}
                          </button>
                        </div>
                      </header>
                      <div className="content-linein-meta-row" />
                    </article>
                  );
                })
              ) : (
                <article className="content-card">
                  <p className="content-body-copy">No custom services configured yet.</p>
                  <span className="content-note">Add a bridge to expose Music Assistant or Apple Music instantly.</span>
                </article>
              )}
            </div>
          </div>
        </section>
      )}

      {contentFilter === 'linein' && (
        <section className="content-section">
          <header className="content-section__header">
            <div>
              <p className="content-section__eyebrow">Music sources</p>
              <h2>Line-in</h2>
              <p>Manage virtual line-in sources exposed to the Loxone app.</p>
              <div className="content-section__actions">
                <button type="button" className="secondary" onClick={() => openLineInModal()}>
                  Add line-in
                </button>
              </div>
            </div>
          </header>
          <div className="content-section__body">
            <div className="content-linein-subsection">
              <div className="content-linein-subsection__header">
                <h3>Line-in inputs</h3>
                <span>Sources selectable in the Loxone app.</span>
              </div>
              <div className="content-grid">
                {lineInInputs.length > 0 ? (
                  lineInInputs.map((input) => (
                    <article key={input.id ?? input.name} className="content-card">
                      <header className="content-card__header content-card__header--split">
                        <div>
                          <div className="content-linein-title">
                            <img
                              className="content-bridge-logo"
                              src={resolveLineInIconUrl(input.iconType)}
                              alt=""
                              aria-hidden="true"
                            />
                            <div className="content-linein-title-text">
                              <h3>{input.name || 'Line-in'}</h3>
                              {input.id && (
                                <p className="content-linein-id" title={input.id}>
                                  {input.id}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="content-linein-actions">
                          <button type="button" className="secondary" onClick={() => openLineInModal(input)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger-link"
                            onClick={() => handleLineInRemove(input.id ?? '', input.name)}
                          >
                            Remove
                          </button>
                        </div>
                      </header>
                      <div className="content-linein-meta-row">
                        <span className="content-linein-source">
                          {(() => {
                            const sourceType = input.source?.type ?? 'ingest';
                            if (sourceType === 'bridge') {
                              return 'lox-linein-bridge';
                            }
                            return sourceType;
                          })()}
                        </span>
                        {input.id && input.source?.type === 'bridge' && (
                          <div className="content-linein-status-row">
                            {(() => {
                              const status = lineInStatuses[input.id ?? ''];
                              const connected = status?.connected ?? false;
                              const stateLabel = formatLineInState(status?.state);
                              return (
                                <>
                                  <span
                                    className={`content-linein-status__pill ${
                                      connected ? 'is-connected' : 'is-offline'
                                    }`}
                                  >
                                    <span className="content-linein-status__dot" aria-hidden="true" />
                                    {connected ? 'Connected' : 'Offline'}
                                  </span>
                                  {stateLabel && (
                                    <span className="content-linein-status__state-badge">{stateLabel}</span>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        )}
                        {input.source?.type === 'sendspin' && (
                          <div className="content-linein-status-row">
                            {(() => {
                              const clientId =
                                typeof input.source?.clientId === 'string' ? input.source.clientId : '';
                              const client = clientId ? sendspinClientMap.get(clientId) : undefined;
                              if (!client) {
                                return (
                                  <span className="content-linein-status__pill is-offline">
                                    <span className="content-linein-status__dot" aria-hidden="true" />
                                    Offline
                                  </span>
                                );
                              }
                              const stateLabel = formatLineInState(client.sourceState);
                              const signalLabel = formatLineInState(client.sourceSignal);
                              const signalTone =
                                client.sourceSignal === 'present'
                                  ? 'is-connected'
                                  : client.sourceSignal === 'absent'
                                    ? 'is-offline'
                                    : '';
                              if (!stateLabel && !signalLabel) {
                                return (
                                  <span className="content-linein-status__pill is-connected">
                                    <span className="content-linein-status__dot" aria-hidden="true" />
                                    Connected
                                  </span>
                                );
                              }
                              return (
                                <>
                                  {stateLabel && (
                                    <span className="content-linein-status__state-badge">{stateLabel}</span>
                                  )}
                                  {signalLabel && (
                                    <span
                                      className={`content-linein-status__pill${signalTone ? ` ${signalTone}` : ''}`}
                                    >
                                      <span className="content-linein-status__dot" aria-hidden="true" />
                                      {signalLabel}
                                    </span>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    </article>
                  ))
                ) : (
                  <article className="content-card">
                    <p className="content-body-copy">No line-in sources configured yet.</p>
                    <span className="content-note">Add a line-in input to expose it as a selectable source.</span>
                  </article>
                )}
              </div>
            </div>
            <article className="content-card content-card--wide content-linein-bridge-card">
              <div className="content-linein-bridge-list">
                <div className="content-linein-bridge-list__header">
                  <div className="content-linein-subsection__header">
                    <h3>Registered bridges</h3>
                    <span>Devices that can feed line-in inputs.</span>
                  </div>
                </div>
                {lineInBridgesError && <p className="content-linein-error">{lineInBridgesError}</p>}
                {lineInBridges.length > 0 || sendspinClients.length > 0 ? (
                  <div className="content-linein-bridge-table">
                    <div className="content-linein-bridge-row content-linein-bridge-row--header">
                      <span>Bridge</span>
                      <span>Type</span>
                      <span>Status</span>
                      <span>Assigned</span>
                      <span />
                    </div>
                    {lineInBridges.map((bridge) => (
                      <div key={bridge.bridge_id} className="content-linein-bridge-row">
                        <div>
                          <div className="content-linein-bridge-name">
                            {bridge.hostname ?? 'Bridge'}
                          </div>
                          <div className="content-linein-bridge-id" title={bridge.ip ?? bridge.bridge_id}>
                            {bridge.ip ?? bridge.bridge_id}
                          </div>
                        </div>
                        <div>{bridge.version ?? '—'}</div>
                        <div>{bridge.last_seen ?? '—'}</div>
                        <div>{bridge.assigned_input_id ?? '—'}</div>
                        <div className="content-linein-bridge-actions">
                          <button
                            type="button"
                            className="danger-link"
                            onClick={() => handleLineInBridgeDelete(bridge.bridge_id)}
                            disabled={Boolean(bridge.assigned_input_id) || lineInBridgeDeletingId === bridge.bridge_id}
                          >
                            {lineInBridgeDeletingId === bridge.bridge_id ? 'Removing…' : 'Remove'}
                          </button>
                        </div>
                      </div>
                    ))}
                    {sendspinClients.map((client) => {
                      const stateLabel = formatLineInState(client.sourceState);
                      const signalLabel = formatLineInState(client.sourceSignal);
                      const statusLabel = [stateLabel, signalLabel].filter(Boolean).join(' / ') || '—';
                      const assignedList =
                        client.clientId && sendspinAssignedMap.has(client.clientId)
                          ? sendspinAssignedMap.get(client.clientId)!
                          : [];
                      const assignedLabel = assignedList.length ? assignedList.join(', ') : '—';
                      return (
                        <div key={`sendspin-${client.clientId ?? client.id}`} className="content-linein-bridge-row">
                          <div>
                            <div className="content-linein-bridge-name">
                              {client.name || 'Sendspin source'}
                            </div>
                            <div
                              className="content-linein-bridge-id"
                              title={client.clientId || client.id}
                            >
                              {client.clientId || client.id}
                            </div>
                          </div>
                          <div>Sendspin</div>
                          <div>{statusLabel}</div>
                          <div>{assignedLabel}</div>
                          <div />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="content-body-copy content-body-copy--muted">
                    <p>No bridges or Sendspin sources registered yet.</p>
                    <p>Install the bridge to make line-in devices available:</p>
                    <ol className="content-linein-info__steps">
                      <li>
                        Download the binary from{' '}
                        <a
                          href="https://github.com/lox-audioserver/lox-linein-bridge/releases"
                          target="_blank"
                          rel="noreferrer"
                        >
                          here
                        </a>
                        , and place it in <code>/usr/local/bin</code>.
                      </li>
                      <li>
                        Run:
                        <code>sudo lox-input-bridge install</code>
                      </li>
                    </ol>
                  </div>
                )}
              </div>
            </article>
          </div>
        </section>
      )}

      {contentFilter === 'system' && (
      <section className="content-section">
        <header className="content-section__header">
          <div>
            <p className="content-section__eyebrow">System services</p>
            <h2>System services</h2>
            <p>Voice announcements, per-zone storage, and maintenance tools.</p>
          </div>
        </header>
        <div className="content-section__body">
        <div className="content-grid">
          <article className="content-card">
          <header>
            <div>
              <h3>Text-to-speech</h3>
              <p>Select the provider used for spoken alerts and announcements.</p>
            </div>
          </header>
          <div className="content-form">
            <label htmlFor="tts-provider">TTS provider</label>
            <select id="tts-provider" className="content-input-select">
              <option value="google">Google TTS</option>
            </select>
          </div>
          <p className="content-body-copy content-body-copy--muted">
            TTS is automatically available for all zones; no extra setup is required.
          </p>
          </article>

          <article className="content-card">
          <header>
            <div>
              <h3>Favorites & recently played</h3>
              <p>
                Zone favorites and history are stored locally per AudioServer zone to mirror Loxone’s behavior. Controls will
                hook into those stores directly.
              </p>
            </div>
          </header>
          <p className="content-body-copy">
            Use the purge actions below to clear favorites or recently played history for all zones.
          </p>
          <div className="content-purge-row">
            <div className="content-purge-actions">
              <button type="button" className="secondary" onClick={handleFavoritesPurge} disabled={favoritesPurging}>
                {favoritesPurging ? 'Purging…' : 'Purge favorites'}
              </button>
              <button type="button" className="secondary" onClick={handleRecentsPurge} disabled={recentsPurging}>
                {recentsPurging ? 'Purging…' : 'Purge recently played'}
              </button>
            </div>
            <div className="content-purge-feedback">
              {/* feedback routed to global alert */}
            </div>
          </div>
          </article>
        </div>
        </div>
      </section>
      )}

      {contentFilter === 'alerts' && (
      <section className="content-section">
        <header className="content-section__header">
          <div>
            <p className="content-section__eyebrow">Alerts</p>
            <h2>Built-in alerts</h2>
            <p>The siren, bell, and buzzer files that ship with the AudioServer—swap them out or preview them inline.</p>
          </div>
        </header>
        <div className="content-section__body">
        <article className="content-card content-card--wide">
          <header className="content-card__header">
            <div>
              <h3>Alerts</h3>
              <p>
                Replace the built-in alarm, fire alarm, bell, and buzzer sounds. Preview them here and upload new MP3 files as needed.
              </p>
            </div>
          </header>
          {alertsLoading ? (
            <p className="content-body-copy content-body-copy--muted">Loading alerts…</p>
          ) : alertsError ? (
            <></>
          ) : (
            <div className="content-alerts-grid">
              {alerts.map((alert) => (
                <AlertPlaybackRow
                  key={alert.id}
                  alert={alert}
                  alertsSaving={alertsSaving}
                  isActive={activeAlertId === alert.id}
                  onActivate={(id) => setActiveAlertId(id)}
                  onDeactivate={(id) => {
                    setActiveAlertId((current) => (current === id ? null : current));
                  }}
                  onUpload={handleAlertUpload}
                  onRevert={handleAlertRevert}
                />
              ))}
            </div>
          )}
          {/* feedback routed to global alert */}
        </article>
        </div>
      </section>
      )}
      {customRadioModalOpen &&
        renderModal(
          <div
            className="content-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-radio-modal-title"
            onClick={() => closeCustomRadioModal(true)}
          >
            <div className="content-modal" onClick={(e) => e.stopPropagation()}>
              <div className="content-modal-header">
                <div>
                  <h4 id="custom-radio-modal-title">Add custom stream</h4>
                  <p className="content-body-copy">
                    Provide a label and stream URL. Stations sync to the same store Loxone reads from.
                  </p>
                </div>
                <button
                  type="button"
                  className="content-modal-close"
                  aria-label="Close"
                  onClick={() => closeCustomRadioModal(true)}
                  disabled={customRadioSubmitting}
                >
                  ×
                </button>
              </div>
              <div className="content-custom-radio-form">
                <div className="content-custom-radio-field">
                  <label htmlFor="custom-radio-name">Station name</label>
                  <input
                    id="custom-radio-name"
                    type="text"
                    value={customRadioForm.name}
                    onChange={(e) => updateCustomRadioForm({ name: e.target.value })}
                    placeholder="Custom Stream"
                    autoComplete="off"
                  />
                </div>
                <div className="content-custom-radio-field">
                  <label htmlFor="custom-radio-stream">Stream URL</label>
                  <input
                    id="custom-radio-stream"
                    type="text"
                    value={customRadioForm.stream}
                    onChange={(e) => updateCustomRadioForm({ stream: e.target.value })}
                    placeholder="https://example.com/stream.mp3"
                    autoComplete="off"
                  />
                </div>
                <div className="content-custom-radio-field">
                  <label htmlFor="custom-radio-cover">Cover image URL (optional)</label>
                  <input
                    id="custom-radio-cover"
                    type="text"
                    value={customRadioForm.coverurl}
                    onChange={(e) => updateCustomRadioForm({ coverurl: e.target.value })}
                    placeholder="https://example.com/logo.jpg"
                    autoComplete="off"
                  />
                </div>
                <div className="content-actions">
                  <button type="button" onClick={handleCustomRadioAdd} disabled={!customRadioFormValid || customRadioSubmitting}>
                    {customRadioSubmitting ? 'Adding…' : 'Add stream'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => closeCustomRadioModal(true)}
                    disabled={customRadioSubmitting}
                  >
                    Cancel
                  </button>
                  {/* feedback routed to global alert */}
                </div>
              </div>
            </div>
          </div>,
        )}
      {lineInModalOpen &&
        renderModal(
          <div
            className="content-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="linein-modal-title"
            onClick={() => closeLineInModal()}
          >
            <div className="content-modal" onClick={(e) => e.stopPropagation()}>
              <div className="content-modal-header">
                <div>
                  <h4 id="linein-modal-title">{lineInEditingId ? 'Edit line-in' : 'Add line-in'}</h4>
                  <p className="content-body-copy">Define a line-in source for Loxone zones.</p>
                </div>
                <button
                  type="button"
                  className="content-modal-close"
                  aria-label="Close"
                  onClick={() => closeLineInModal()}
                  disabled={lineInSubmitting}
                >
                  ×
                </button>
              </div>
              {(() => {
                const ingestBaseUrl = getLineInIngestBaseUrl();
                const ingestWsUrl = getLineInIngestWsUrl(ingestBaseUrl);
                const ingestTcpHost = getLineInIngestTcpHost();
                const ingestId = lineInEditingId ?? lineInForm.draftId ?? '<line-in-id>';
                return (
                  <div className="content-linein-modal">
                  <div className="content-linein-form">
                    <section className="content-linein-section">
                      <div className="content-linein-section__header">
                        <h5 className="content-linein-section__title">Basics</h5>
                      </div>
                      <div className="content-custom-radio-field">
                        <label htmlFor="linein-name">
                          Name <span className="content-field-required">Required</span>
                        </label>
                        <input
                          id="linein-name"
                          type="text"
                          value={lineInForm.name}
                          onChange={(e) => setLineInForm((prev) => ({ ...prev, name: e.target.value }))}
                          placeholder="Turntable"
                          autoComplete="off"
                        />
                        <p className="content-input-hint">This is the label shown in the Loxone app.</p>
                      </div>
                      <div className="content-custom-radio-field">
                        <label htmlFor="linein-icon">Icon</label>
                        <div className="content-linein-icon-grid" role="listbox" aria-label="Line-in icon">
                          {LINEIN_ICON_OPTIONS.map((option) => {
                            const isSelected = lineInForm.iconType === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                className={`content-linein-icon-option${isSelected ? ' is-selected' : ''}`}
                                onClick={() =>
                                  setLineInForm((prev) => ({ ...prev, iconType: option.value }))
                                }
                                aria-pressed={isSelected}
                              >
                                <img src={resolveLineInIconUrl(option.value)} alt="" aria-hidden="true" />
                                <span className="content-linein-icon-label">{option.label}</span>
                              </button>
                            );
                          })}
                        </div>
                        <p className="content-input-hint">Pick the icon to show next to the source.</p>
                      </div>
                    </section>
                    <section className="content-linein-section">
                      <div className="content-linein-section__header">
                        <h5 className="content-linein-section__title">Source</h5>
                      </div>
                      <div className="content-custom-radio-field">
                        <label htmlFor="linein-source">Input method</label>
                        <select
                          id="linein-source"
                          className="content-input-select"
                          value={lineInForm.sourceType}
                          onChange={(e) =>
                            setLineInForm((prev) => ({ ...prev, sourceType: e.target.value as LineInSourceType }))
                          }
                        >
                          <option value="bridge">Lox-linein-bridge</option>
                          <option value="ingest">Manual ingest</option>
                          <option value="sendspin">Sendspin</option>
                          <option value="lox-beolink">Lox BeoLink</option>
                        </select>
                        <p className="content-input-hint">Select how audio reaches this input.</p>
                      </div>
                    </section>
                    <section className="content-linein-section">
                      <div className="content-linein-section__header">
                        <h5 className="content-linein-section__title">Preferences</h5>
                      </div>
                      <div className="content-custom-radio-field">
                        <label htmlFor="linein-metadata">Enable acoustic fingerprinting</label>
                        <label className="content-switch" htmlFor="linein-metadata">
                          <input
                            id="linein-metadata"
                            type="checkbox"
                            checked={lineInForm.metadataEnabled}
                            onChange={(e) =>
                              setLineInForm((prev) => ({ ...prev, metadataEnabled: e.target.checked }))
                            }
                          />
                          <span className="content-switch-slider" />
                        </label>
                        <p className="content-input-hint">
                          Tries to identify track metadata for this input.
                        </p>
                      </div>
                    </section>
                  </div>
                <aside className="content-linein-preview">
                  <div className="content-linein-info">
                    {lineInForm.sourceType === 'bridge' && (
                      <div className="content-linein-info__section">
                        <div className="content-linein-info__section-header">
                          <p className="content-linein-info__title">Bridge setup</p>
                        </div>
                        <p className="content-linein-info__copy">
                          Bind a registered bridge and choose its capture device.
                        </p>
                        <div className="content-linein-select-row">
                          <select
                            id="linein-bridge-select"
                            className="content-input-select"
                            value={lineInForm.bridgeId}
                            onChange={(e) =>
                              setLineInForm((prev) => ({
                                ...prev,
                                bridgeId: e.target.value,
                                captureDeviceId: '',
                              }))
                            }
                          >
                            <option value="">Select a bridge</option>
                            {lineInForm.bridgeId &&
                              !availableLineInBridges.some((bridge) => bridge.bridge_id === lineInForm.bridgeId) && (
                                <option value={lineInForm.bridgeId}>
                                  {lineInForm.bridgeId} (unregistered)
                                </option>
                              )}
                            {availableLineInBridges.map((bridge) => (
                              <option key={bridge.bridge_id} value={bridge.bridge_id}>
                                {bridge.hostname ? `${bridge.hostname} · ${bridge.bridge_id}` : bridge.bridge_id}
                              </option>
                            ))}
                          </select>
                        </div>
                        {lineInBridgesError && <p className="content-linein-error">{lineInBridgesError}</p>}
                        {activeLineInBridge && (
                          <div className="content-linein-meta-grid">
                            <div>
                              <p className="content-linein-info__label">Hostname</p>
                              <p className="content-linein-meta-value">
                                {activeLineInBridge.hostname ?? activeLineInBridge.bridge_id}
                              </p>
                            </div>
                            <div>
                              <p className="content-linein-info__label">Last seen</p>
                              <p className="content-linein-meta-value">
                                {activeLineInBridge.last_seen ?? '—'}
                              </p>
                            </div>
                            <div>
                              <p className="content-linein-info__label">Devices</p>
                              <p className="content-linein-meta-value">
                                {activeLineInBridgeDevices.length || '—'}
                              </p>
                            </div>
                          </div>
                        )}
                        <div className="content-linein-info__select">
                          <label htmlFor="linein-capture-device">Capture device</label>
                          <div className="content-linein-select-row">
                            <select
                              id="linein-capture-device"
                              className="content-input-select"
                              value={lineInForm.captureDeviceId}
                              onChange={(e) =>
                                setLineInForm((prev) => ({ ...prev, captureDeviceId: e.target.value }))
                              }
                              disabled={!activeLineInBridge}
                            >
                              <option value="">Default device</option>
                              {activeLineInBridgeDevices.map((device) => (
                                <option key={device.id} value={device.id}>
                                  {device.name ? `${device.name} · ${device.id}` : device.id}
                                </option>
                              ))}
                            </select>
                          </div>
                          <p className="content-input-hint">
                            {activeLineInBridge
                              ? 'Choose which capture device the bridge should use.'
                              : 'Select a bridge to view capture devices.'}
                          </p>
                        </div>
                        <div className="content-linein-info__vad">
                          <p className="content-linein-info__label">Ingest settings</p>
                          <div className="content-linein-info__vad-grid">
                            <label className="content-linein-info__vad-field">
                              <span>Sample rate (Hz)</span>
                              <input
                                id="linein-sample-rate"
                                type="number"
                                inputMode="numeric"
                                value={lineInForm.ingestSampleRate}
                                onChange={(e) =>
                                  setLineInForm((prev) => ({ ...prev, ingestSampleRate: e.target.value }))
                                }
                                placeholder="44100"
                              />
                            </label>
                            <label className="content-linein-info__vad-field">
                              <span>Resampler</span>
                              <select
                                id="linein-resampler"
                                className="content-input-select"
                                value={lineInForm.ingestResampler}
                                onChange={(e) =>
                                  setLineInForm((prev) => ({ ...prev, ingestResampler: e.target.value }))
                                }
                              >
                                <option value="linear">Linear (low quality)</option>
                                <option value="sinc-fast">Sinc-fast (balanced)</option>
                                <option value="sinc/rubato">Sinc (highest quality)</option>
                              </select>
                            </label>
                          </div>
                          <p className="content-linein-info__hint">
                            Sample rate must match the bridge capture rate. Resampler sets quality (linear → sinc-fast → sinc).
                          </p>
                        </div>
                        <div className="content-linein-info__vad">
                          <p className="content-linein-info__label">VAD settings</p>
                          <div className="content-linein-info__vad-grid">
                            <label className="content-linein-info__vad-field">
                              <span>Threshold (dB)</span>
                              <input
                                id="linein-vad-threshold"
                                type="number"
                                inputMode="decimal"
                                value={lineInForm.vadThresholdDb}
                                onChange={(e) =>
                                  setLineInForm((prev) => ({ ...prev, vadThresholdDb: e.target.value }))
                                }
                                placeholder="-45"
                              />
                            </label>
                            <label className="content-linein-info__vad-field">
                              <span>Hold (ms)</span>
                              <input
                                id="linein-vad-hold"
                                type="number"
                                inputMode="numeric"
                                value={lineInForm.vadHoldMs}
                                onChange={(e) =>
                                  setLineInForm((prev) => ({ ...prev, vadHoldMs: e.target.value }))
                                }
                                placeholder="2000"
                              />
                            </label>
                          </div>
                          <p className="content-linein-info__hint">Control when streaming starts and stops on silence.</p>
                        </div>
                      </div>
                    )}
                    {lineInForm.sourceType === 'sendspin' && (
                      <div className="content-linein-info__section">
                        <p className="content-linein-info__title">Sendspin</p>
                        <p className="content-linein-info__copy">
                          Stream audio from a Sendspin source client. Select the client ID below and capture will start
                          when the line-in input is selected.
                        </p>
                        <div className="content-linein-info__select">
                          <label htmlFor="linein-sendspin-client">Sendspin client</label>
                          <div className="content-linein-select-row">
                            <select
                              id="linein-sendspin-client"
                              className="content-input-select"
                              value={lineInForm.sendspinClientId}
                              onChange={(e) => setLineInForm((prev) => ({ ...prev, sendspinClientId: e.target.value }))}
                            >
                              <option value="">Select a client</option>
                              {sendspinClients.map((client) => (
                                <option key={client.id} value={client.clientId}>
                                  {client.name || client.clientId}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="secondary content-linein-refresh"
                              onClick={() => void handleSendspinDiscovery()}
                              disabled={sendspinLoading}
                            >
                              {sendspinLoading ? 'Refreshing…' : 'Refresh'}
                            </button>
                          </div>
                          {sendspinError && <p className="content-linein-error">{sendspinError}</p>}
                        </div>
                      </div>
                    )}
                    {lineInForm.sourceType === 'ingest' && (
                      <div className="content-linein-info__section">
                        <p className="content-linein-info__title">Manual ingest</p>
                        <p className="content-linein-info__copy">
                          Manual ingest supports WebSocket and TCP per line-in.
                        </p>
                        <div className="content-linein-info__manual">
                          <p className="content-linein-info__label">Ingest endpoints</p>
                          <div className="content-linein-info__urls">
                            <p className="content-linein-info__label">WebSocket ingest</p>
                            <code>{`${ingestWsUrl}/ingest/${ingestId}`}</code>
                            <p className="content-linein-info__label">TCP ingest</p>
                            <code>{`tcp://${ingestTcpHost}:7080`}</code>
                            <p className="content-linein-info__hint">
                              For manual testing only. Send the line-in ID as the first line (ending with newline),
                              then stream raw audio.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                    {lineInForm.sourceType === 'lox-beolink' && (
                      <div className="content-linein-info__section">
                        <p className="content-linein-info__title">Lox BeoLink</p>
                        <p className="content-linein-info__copy">
                          Lox BeoLink line-in ingests audio from a BeoLink gateway integration.
                        </p>
                      </div>
                    )}
                  </div>
                </aside>
                <div className="content-actions content-actions--linein">
                  <button
                    type="button"
                    className="primary"
                    onClick={handleLineInSave}
                    disabled={
                      !lineInForm.name.trim() ||
                      lineInSubmitting ||
                      (lineInForm.sourceType === 'sendspin' && !lineInForm.sendspinClientId.trim()) ||
                      (lineInForm.sourceType === 'bridge' && !lineInForm.bridgeId.trim())
                    }
                  >
                    {lineInSubmitting ? 'Saving…' : lineInEditingId ? 'Save line-in' : 'Add line-in'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => closeLineInModal()}
                    disabled={lineInSubmitting}
                  >
                    Cancel
                  </button>
                </div>
                  </div>
                );
              })()}
            </div>
          </div>,
        )}
      {bridgeModalOpen &&
        renderModal(
          <div
            className="content-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bridge-modal-title"
            onClick={() => closeBridgeModal(true)}
          >
            <div className="content-modal" onClick={(e) => e.stopPropagation()}>
              <div className="content-modal-header">
                <div>
                  <h4 id="bridge-modal-title">{bridgeEditingId ? 'Edit bridge' : 'Add bridge'}</h4>
                  <p className="content-body-copy">
                    Expose bridged service as a Spotify-compatible source.
                  </p>
                </div>
                <button
                  type="button"
                  className="content-modal-close"
                  aria-label="Close"
                  onClick={() => closeBridgeModal(true)}
                  disabled={bridgeSubmitting}
                >
                  ×
                </button>
              </div>
              <div className="content-bridge-modal-body">
                <div className="content-bridge-steps">
                  <div className="content-bridge-step">
                    <span className="content-bridge-step-label">Step 1</span>
                    <h5>Choose provider</h5>
                    <p className="content-body-copy content-body-copy--muted">
                      Pick which service you want to expose through the Spotify-compatible bridge.
                    </p>
                    <div className="content-bridge-picker">
                      <div className="content-bridge-logo-swatch" aria-hidden="true">
                        {bridgeProviderLogoUrl ? (
                          <img className="content-bridge-logo" src={bridgeProviderLogoUrl} alt="" loading="lazy" />
                        ) : (
                          <span className="content-bridge-logo-fallback">?</span>
                        )}
                      </div>
                      <div className="content-bridge-picker-field">
                        <label htmlFor="bridge-provider">Provider</label>
                        <select
                          id="bridge-provider"
                          className="content-input-select"
                          value={bridgeForm.provider}
                          onChange={(e) => updateBridgeForm({ provider: e.target.value as BridgeFormState['provider'] })}
                          disabled={bridgeSubmitting}
                        >
                          <option value="musicassistant">Music Assistant</option>
                          <option value="applemusic">Apple Music</option>
                          <option value="deezer">Deezer</option>
                          <option value="tidal">Tidal</option>
                        </select>
                      </div>
                    </div>
                  </div>
                  <div className="content-bridge-step content-bridge-step--info">
                    <div className="content-bridge-provider-info">
                      <div className="content-bridge-provider-header">
                        {bridgeProviderLogoUrl && (
                          <img className="content-bridge-provider-logo" src={bridgeProviderLogoUrl} alt="" loading="lazy" />
                        )}
                        <div>
                          {bridgeForm.provider === 'musicassistant' && <h5>Music Assistant</h5>}
                          {bridgeForm.provider === 'applemusic' && <h5>Apple Music</h5>}
                          {bridgeForm.provider === 'deezer' && <h5>Deezer</h5>}
                          {bridgeForm.provider === 'tidal' && <h5>Tidal</h5>}
                          <p className="content-bridge-provider-subtitle">Bridge setup details</p>
                        </div>
                      </div>
                      {bridgeForm.provider === 'musicassistant' && (
                        <>
                          <p>
                            Music Assistant exposes one Spotify account per configured MA account. Create dedicated MA accounts with
                            provider filters to surface specific services in Loxone.
                          </p>
                          <span className="content-bridge-badge">Requires Music Assistant 2.7+</span>
                        </>
                      )}
                      {bridgeForm.provider === 'applemusic' && (
                        <p>
                          Use a Media User Token from music.apple.com to enable Apple Music browsing and playback. Tokens can be refreshed
                          anytime from your browser session.
                        </p>
                      )}
                      {bridgeForm.provider === 'deezer' && (
                        <p>
                          Deezer works without credentials for public catalog data. Add an ARL cookie only if you need private playlists or
                          recommendations.
                        </p>
                      )}
                      {bridgeForm.provider === 'tidal' && (
                        <p>
                          Provide a valid access token plus a two-letter country code to enable Tidal catalog and playback.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
                <div className="content-bridge-step content-bridge-step--form">
                  <span className="content-bridge-step-label">Step 2</span>
                  <h5>Credentials</h5>
                  <p className="content-body-copy content-body-copy--muted">
                    Only fields required for the selected provider are shown.
                  </p>
                  {bridgeForm.provider === 'musicassistant' && (
                    <div className="content-bridge-form-grid">
                      <div className="content-custom-radio-field">
                        <label htmlFor="bridge-host">Host</label>
                        <input
                          id="bridge-host"
                          type="text"
                          value={bridgeForm.host}
                          onChange={(e) => updateBridgeForm({ host: e.target.value })}
                          placeholder="127.0.0.1"
                          autoComplete="off"
                        />
                      </div>
                      <div className="content-custom-radio-field">
                        <label htmlFor="bridge-port">Port</label>
                        <input
                          id="bridge-port"
                          type="number"
                          value={bridgeForm.port}
                          onChange={(e) => updateBridgeForm({ port: Number(e.target.value) || 0 })}
                          placeholder="8095"
                          min={1}
                        />
                      </div>
                      <div className="content-custom-radio-field">
                        <label htmlFor="bridge-apikey">API key</label>
                        <p className="content-input-hint">
                          Generate a long-lived token under your Music Assistant account settings.
                        </p>
                        <input
                          id="bridge-apikey"
                          type="text"
                          value={bridgeForm.apiKey}
                          onChange={(e) => updateBridgeForm({ apiKey: e.target.value })}
                          placeholder="token"
                          autoComplete="off"
                        />
                      </div>
                    </div>
                  )}
                  {bridgeForm.provider === 'applemusic' && (
                    <div className="content-bridge-form-grid">
                      <div className="content-custom-radio-field">
                        <label htmlFor="bridge-usertoken">Media user token</label>
                        <p className="content-input-hint">Paste a token from your music.apple.com session.</p>
                        <input
                          id="bridge-usertoken"
                          type="text"
                          value={bridgeForm.userToken}
                          onChange={(e) => updateBridgeForm({ userToken: e.target.value })}
                          placeholder="Media user token"
                          autoComplete="off"
                        />
                      </div>
                    </div>
                  )}
                  {bridgeForm.provider === 'deezer' && (
                    <div className="content-bridge-form-grid">
                      <div className="content-custom-radio-field">
                        <label htmlFor="bridge-deezer-arl">ARL cookie (optional)</label>
                        <p className="content-input-hint">
                          Add your Deezer ARL cookie to access private playlists or recommendations.
                        </p>
                        <input
                          id="bridge-deezer-arl"
                          type="text"
                          value={bridgeForm.deezerArl}
                          onChange={(e) => updateBridgeForm({ deezerArl: e.target.value })}
                          placeholder="ARL"
                          autoComplete="off"
                        />
                      </div>
                    </div>
                  )}
                  {bridgeForm.provider === 'tidal' && (
                    <div className="content-bridge-form-grid">
                      <div className="content-custom-radio-field">
                        <label htmlFor="bridge-tidal-token">Access token</label>
                        <p className="content-input-hint">Paste a token from your device authorization flow.</p>
                        <input
                          id="bridge-tidal-token"
                          type="text"
                          value={bridgeForm.tidalAccessToken}
                          onChange={(e) => updateBridgeForm({ tidalAccessToken: e.target.value })}
                          placeholder="Access token"
                          autoComplete="off"
                        />
                      </div>
                      <div className="content-custom-radio-field">
                        <label htmlFor="bridge-tidal-country">Country code</label>
                        <input
                          id="bridge-tidal-country"
                          type="text"
                          value={bridgeForm.tidalCountryCode}
                          onChange={(e) => updateBridgeForm({ tidalCountryCode: e.target.value })}
                          placeholder="US"
                          autoComplete="off"
                          maxLength={2}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="content-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={handleBridgeAdd}
                  disabled={!bridgeFormValid || bridgeSubmitting}
                >
                  {bridgeSubmitting ? 'Saving…' : bridgeEditingId ? 'Save bridge' : 'Add bridge'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => closeBridgeModal(true)}
                  disabled={bridgeSubmitting}
                >
                  Cancel
                </button>
                {/* feedback routed to global alert */}
              </div>
            </div>
          </div>,
        )}
      {storageModalOpen &&
        renderModal(
          <div
            className="content-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="storage-modal-title"
            onClick={() => closeStorageModal(true)}
          >
            <div className="content-modal" onClick={(e) => e.stopPropagation()}>
              <div className="content-modal-header">
                <div>
                  <h4 id="storage-modal-title">Add network share</h4>
                  <p className="content-body-copy">
                    Provide the network details of your NAS or network share. Credentials are optional when guest access is enabled.
                  </p>
                </div>
                <button
                  type="button"
                  className="content-modal-close"
                  aria-label="Close"
                  onClick={() => closeStorageModal(true)}
                  disabled={storageSubmitting}
                >
                  ×
                </button>
              </div>
              <div className="library-storage-form">
                <div className="library-storage-form-section">
                  <div className="library-storage-form-section__title">Connection</div>
                  <div className="library-storage-form-field">
                    <label htmlFor="storage-name">Display name</label>
                    <input
                      id="storage-name"
                      type="text"
                      value={storageForm.name}
                      onChange={(e) => updateStorageForm({ name: e.target.value })}
                      placeholder="NASdrive"
                      autoComplete="off"
                    />
                  </div>
                  <div className="library-storage-form__row">
                    <div className="library-storage-form-field">
                      <label htmlFor="storage-server">Server hostname / IP</label>
                      <input
                        id="storage-server"
                        type="text"
                        value={storageForm.server}
                        onChange={(e) => updateStorageForm({ server: e.target.value })}
                        placeholder="192.168.1.20"
                        autoComplete="off"
                      />
                    </div>
                    <div className="library-storage-form-field">
                      <label htmlFor="storage-folder">Share / folder</label>
                      <input
                        id="storage-folder"
                        type="text"
                        value={storageForm.folder}
                        onChange={(e) => updateStorageForm({ folder: e.target.value })}
                        placeholder="Music"
                        autoComplete="off"
                      />
                    </div>
                  </div>
                </div>
                <div className="library-storage-form-section">
                  <div className="library-storage-form-section__title">Access</div>
                  <div className="library-storage-form__row">
                    <div className="library-storage-form-field">
                      <label htmlFor="storage-username">Username</label>
                      <input
                        id="storage-username"
                        type="text"
                        value={storageForm.username}
                        onChange={(e) => updateStorageForm({ username: e.target.value })}
                        placeholder="user"
                        autoComplete="off"
                        disabled={storageForm.guest}
                      />
                    </div>
                    <div className="library-storage-form-field">
                      <label htmlFor="storage-password">Password</label>
                      <input
                        id="storage-password"
                        type="password"
                        value={storageForm.password}
                        onChange={(e) => updateStorageForm({ password: e.target.value })}
                        placeholder="••••••••"
                        autoComplete="new-password"
                        disabled={storageForm.guest}
                      />
                    </div>
                  </div>
                  <label className="library-storage-checkbox" htmlFor="storage-guest">
                    <input
                      id="storage-guest"
                      type="checkbox"
                      checked={storageForm.guest}
                      onChange={(e) =>
                        updateStorageForm({
                          guest: e.target.checked,
                          ...(e.target.checked ? { username: '', password: '' } : {}),
                        })
                      }
                    />
                    Allow guest access (no credentials)
                  </label>
                </div>
              </div>
              <div className="content-actions library-storage-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={handleAddLibraryStorage}
                  disabled={!storageFormValid || storageSubmitting}
                >
                  {storageSubmitting ? 'Adding…' : 'Add share'}
                </button>
                <button type="button" className="secondary" onClick={() => closeStorageModal(true)} disabled={storageSubmitting}>
                  Cancel
                </button>
                {/* feedback routed to global alert */}
              </div>
            </div>
          </div>,
        )}
      </div>
    </div>
  );
}
