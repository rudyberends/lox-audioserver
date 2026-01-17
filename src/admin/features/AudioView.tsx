import React from 'react';
import './AudioView.css';
import { fetchZoneStates, type ZonePlaybackState, type ZoneStatesResponse } from '../services/zonesApi';
import { fetchGroups, type GroupRecord } from '../services/groupsApi';

type ViewState = {
  loading: boolean;
  error: string | null;
  states: ZonePlaybackState[];
  system?: ZoneStatesResponse['system'];
};

export default function AudioView(): JSX.Element {
  const [audioQuery, setAudioQuery] = React.useState('');
  const [audioFilter, setAudioFilter] = React.useState<'all' | 'active' | 'issues'>('all');
  const [audioDensity, setAudioDensity] = React.useState<'overview' | 'detailed'>('overview');
  const formatBackend = (backend: string | null | undefined): string => {
    const normalized = (backend ?? '').toLowerCase();
    if (normalized === 'unknown' || normalized === 'uknown' || normalized === '') {
      return 'Temporary sync group';
    }
    return backend ?? 'Temporary sync group';
  };

  const formatSampleRate = (value?: number | null): string | null => {
    if (!value || !Number.isFinite(value)) return null;
    if (value >= 100000) {
      return `${(value / 1000).toFixed(0)} kHz`;
    }
    if (value >= 1000) {
      const rounded = (value / 1000).toFixed(1);
      return `${rounded} kHz`;
    }
    return `${value} Hz`;
  };

  const formatSeconds = (value?: number | null): string | null => {
    if (!Number.isFinite(value ?? NaN)) return null;
    const total = Math.max(0, Math.floor(value ?? 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatBitrate = (bps?: number | null): string | null => {
    if (!Number.isFinite(bps ?? NaN) || (bps ?? 0) <= 0) return null;
    const kbps = (bps ?? 0) / 1000;
    if (kbps >= 1000) {
      return `${(kbps / 1000).toFixed(2)} Mbps`;
    }
    return `${kbps.toFixed(0)} kbps`;
  };

  const formatAgeMs = (timestamp?: number | null): string | null => {
    if (!Number.isFinite(timestamp ?? NaN)) return null;
    const raw = Number(timestamp ?? 0);
    const ts = raw < 1_000_000_000_000 ? raw * 1000 : raw;
    const delta = Math.max(0, Date.now() - ts);
    return formatSeconds(delta / 1000);
  };

  const formatBytes = (bytes?: number | null): string | null => {
    if (!Number.isFinite(bytes ?? NaN) || (bytes ?? 0) <= 0) return null;
    const value = bytes ?? 0;
    if (value >= 1024 * 1024) {
      return `${(value / (1024 * 1024)).toFixed(2)} MB`;
    }
    return `${Math.round(value / 1024)} KB`;
  };

  const formatTech = (
    tech: ZonePlaybackState['tech'],
  ): {
    input?: string;
    output?: string;
    session?: string;
    streams?: string;
    quality?: string;
    notes?: string[];
    throughput?: string;
    streamDetails?: string[];
    http?: string;
    backpressure?: string;
    backpressureDrops?: number;
    backpressureRecent?: number;
    clientFormat?: string;
    streamTotal?: string;
    protocol?: string | null;
    subscribers?: number;
    sendspinLead?: string;
    sendspinBuffer?: string;
    sendspinBackpressure?: string;
    sendspinLastDrop?: string;
    engineStatus?: string;
    lastEngineEvent?: string;
    resampler?: string;
  } | null => {
    if (!tech) return null;
    const inputParts: string[] = [];
    const outputParts: string[] = [];
    const notes: string[] = [];
    const providerLabel = tech.inputProvider ? tech.inputProvider : null;
    const inputFormat = (tech.input?.format ?? '').toLowerCase();
    const outputProfile = (tech.output?.profiles?.[0] ?? '').toLowerCase();
    const isLosslessFormat = (fmt?: string | null): boolean => {
      if (!fmt) return false;
      return /(flac|pcm|s\d{2}le|wav|alac)/.test(fmt.toLowerCase());
    };
    const isLossyFormat = (fmt?: string | null): boolean => {
      if (!fmt) return false;
      return /(mp3|aac|m4a|ogg|opus)/.test(fmt.toLowerCase());
    };
    const inputLossless = isLosslessFormat(inputFormat) ? true : isLossyFormat(inputFormat) ? false : undefined;
    const outputLossless = outputProfile === 'pcm' || outputProfile === 'flac';
    if (tech.input) {
      if (tech.input.format) inputParts.push(tech.input.format.toUpperCase());
      const sr = formatSampleRate(tech.input.sampleRate);
      if (sr) inputParts.push(sr);
      if (tech.input.channels) inputParts.push(`${tech.input.channels}ch`);
    }
    if (tech.output) {
      if (tech.output.profiles?.length) outputParts.push((tech.output.profiles[0] ?? '').toUpperCase());
      if (tech.output.bitrate) outputParts.push(tech.output.bitrate.toUpperCase());
      const outSr = formatSampleRate(tech.output.sampleRate);
      if (outSr) outputParts.push(outSr);
      if (tech.output.channels) outputParts.push(`${tech.output.channels}ch`);
      if (tech.output.pcmBitDepth && (tech.output.profiles?.[0] ?? '').toLowerCase() === 'pcm') {
        outputParts.push(`${tech.output.pcmBitDepth}-bit`);
      }
    }
    const target =
      tech.outputTarget ||
      (tech.outputs && tech.outputs.length ? tech.outputs[0] : null) ||
      (tech.transports && tech.transports.length ? tech.transports[0] : null);
    const inputLabel = [providerLabel, ...inputParts].filter(Boolean).join(' • ');
    const outputLabel = [target, ...outputParts].filter(Boolean).join(' • ');
    const outputLossy =
      outputProfile === '' ||
      outputProfile === 'mp3' ||
      outputProfile === 'aac' ||
      outputProfile === 'ogg' ||
      outputProfile === 'opus';
    const isResampled =
      tech.input?.sampleRate &&
      tech.output?.sampleRate &&
      tech.input.sampleRate !== tech.output.sampleRate;
    const quality =
      inputLossless === false || outputLossy
        ? outputProfile
          ? `Lossy (${outputProfile.toUpperCase()})`
          : 'Lossy'
        : outputLossless
          ? isResampled
            ? 'Lossless (resampled)'
            : 'Bit-perfect'
          : 'Lossy';
    if (inputLossless === false && inputFormat) {
      notes.push(`Source is lossy (${inputFormat.toUpperCase()})`);
    }
    if (inputLossless && outputLossy && outputProfile) {
      notes.push(`Transcoding to lossy output (${outputProfile.toUpperCase()})`);
    }
    if (tech.input?.sampleRate && tech.output?.sampleRate && tech.input.sampleRate !== tech.output.sampleRate) {
      const inSr = formatSampleRate(tech.input.sampleRate);
      const outSr = formatSampleRate(tech.output.sampleRate);
      notes.push(`Resampled ${inSr ?? tech.input.sampleRate} → ${outSr ?? tech.output.sampleRate}`);
    }
    if (tech.input?.channels && tech.output?.channels && tech.input.channels !== tech.output.channels) {
      notes.push(
        tech.output.channels < tech.input.channels
          ? `Downmix ${tech.input.channels}ch → ${tech.output.channels}ch`
          : `Upmix ${tech.input.channels}ch → ${tech.output.channels}ch`,
      );
    }
    const resampler = tech.output?.resampler
      ? `${tech.output.resampler.toUpperCase()}${
          tech.output.resamplePrecision ? ` • prec ${tech.output.resamplePrecision}` : ''
        }${tech.output.resampleCutoff ? ` • cutoff ${tech.output.resampleCutoff}` : ''}`
      : undefined;
    const sessionParts: string[] = [];
    if (tech.session?.state) {
      sessionParts.push(tech.session.state);
    }
    const elapsed = formatSeconds(tech.session?.elapsed);
    const duration = formatSeconds(tech.session?.duration);
    if (elapsed || duration) {
      sessionParts.push(`${elapsed ?? '--:--'} / ${duration ?? '--:--'}`);
    }
    const streams: string[] = [];
    if (tech.streams?.mp3) streams.push('MP3 stream');
    if (tech.streams?.pcm) streams.push('PCM stream');
    const primaryStat = tech.streamStats?.[0];
    const throughput = formatBitrate(primaryStat?.bps);
    const totalBps =
      tech.streamStats?.reduce((sum, stat) => (Number.isFinite(stat.bps ?? NaN) ? sum + (stat.bps ?? 0) : sum), 0) ??
      0;
    const streamTotal = formatBitrate(totalBps);
    const streamDetails =
      tech.streamStats
        ?.map((stat) => {
          const rate = formatBitrate(stat.bps);
          const bufKb =
            typeof stat.bufferedBytes === 'number'
              ? `${Math.round((stat.bufferedBytes / 1024) * 10) / 10} KB`
              : null;
          const subCount = typeof stat.subscribers === 'number' ? stat.subscribers : 1;
          const subs = ` • ${subCount} sub${subCount === 1 ? '' : 's'}`;
          const total = formatBytes(stat.totalBytes);
          const age = formatAgeMs(stat.lastUpdated);
          const ageLabel = age ? ` • ${age} ago` : '';
          const drops = stat.subscriberDrops ? ` • ${stat.subscriberDrops} drops` : '';
          const restarts = stat.restarts ? ` • ${stat.restarts} restarts` : '';
          const lastDropAge = formatAgeMs(stat.lastSubscriberDropAt);
          const lastDropLabel = lastDropAge ? ` • last drop ${lastDropAge} ago` : '';
          if (!rate && !bufKb && !total) return null;
          return `${stat.profile.toUpperCase()}: ${rate ?? '—'}${bufKb ? ` (${bufKb} buffer)` : ''}${total ? ` • ${total}` : ''}${subs}${ageLabel}${drops}${restarts}${lastDropLabel}`;
        })
        .filter(Boolean) ?? undefined;
    const httpBits: string[] = [];
    if (tech.output?.httpProfile) httpBits.push(`HTTP ${tech.output.httpProfile}`);
    if (tech.output?.httpIcyEnabled) httpBits.push('ICY on');
    if (tech.output?.httpIcyName) httpBits.push(`Name ${tech.output.httpIcyName}`);
    if (tech.output?.prebufferBytes) {
      const kb = Math.round((tech.output.prebufferBytes / 1024) * 10) / 10;
      httpBits.push(`Prebuffer ${kb} KB`);
    }
    if (tech.output?.httpFallbackSeconds) httpBits.push(`Fallback ${tech.output.httpFallbackSeconds}s`);
    if (tech.backpressure) {
      const dropInfo = `${tech.backpressure.drops} drops`;
      const lastBuf =
        tech.backpressure.lastBytes > 0
          ? `${Math.round((tech.backpressure.lastBytes / 1024) * 10) / 10} KB buffered`
          : null;
      notes.push(`Backpressure ${dropInfo}${lastBuf ? ` (last ${lastBuf})` : ''}`);
    }
    if (primaryStat?.bufferedBytes) {
      const kb = Math.round((primaryStat.bufferedBytes / 1024) * 10) / 10;
      notes.push(`Buffer ~${kb} KB`);
    }
    const clientFormat = tech.sendspin
      ? `${tech.sendspin.codec.toUpperCase()} ${formatSampleRate(tech.sendspin.sampleRate) ?? tech.sendspin.sampleRate} • ${tech.sendspin.channels}ch${tech.sendspin.bitDepth ? ` • ${tech.sendspin.bitDepth}-bit` : ''}${
          tech.sendspin.bufferCapacity ? ` • buffer ${tech.sendspin.bufferCapacity} bytes` : ''
        }`
      : undefined;
    let sendspinLead: string | undefined;
    let sendspinBuffer: string | undefined;
    if (tech.sendspin?.leadUs != null) {
      const leadMs = Math.round((tech.sendspin.leadUs / 1000) * 10) / 10;
      const targetMs =
        tech.sendspin.targetLeadUs != null ? Math.round((tech.sendspin.targetLeadUs / 1000) * 10) / 10 : null;
      const driftMs = targetMs != null ? leadMs - targetMs : leadMs;
      sendspinLead = targetMs != null ? `${leadMs} ms (target ${targetMs} ms, drift ${driftMs >= 0 ? '+' : ''}${driftMs} ms)` : `${leadMs} ms`;
      if (tech.sendspin.bufferedBytes) {
        const kb = Math.round((tech.sendspin.bufferedBytes / 1024) * 10) / 10;
        const cap = tech.sendspin.bufferCapacity || tech.sendspin.bufferCapacity === 0 ? tech.sendspin.bufferCapacity : null;
        const util = cap && cap > 0 ? ` • ${(Math.min(100, (tech.sendspin.bufferedBytes / cap) * 100)).toFixed(0)}%` : '';
        sendspinBuffer = `Client buffer ~${kb} KB${util}`;
      }
    }
    let sendspinBackpressure: string | undefined;
    let sendspinLastDrop: string | undefined;
    if (tech.backpressure?.lastDropTs) {
      const seconds = Math.max(0, Math.round((Date.now() - tech.backpressure.lastDropTs) / 1000));
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      sendspinLastDrop = `${mins}m ${secs.toString().padStart(2, '0')}s ago`;
    }
    if (tech.backpressure) {
      sendspinBackpressure = `${tech.backpressure.drops} drops · last ${Math.round((tech.backpressure.lastBytes / 1024) * 10) / 10} KB buffered`;
    }
    const engineRestarts =
      tech.streamStats?.reduce((sum, stat) => sum + (stat.restarts ?? 0), 0) ?? 0;
    const subscriberDrops =
      tech.streamStats?.reduce((sum, stat) => sum + (stat.subscriberDrops ?? 0), 0) ?? 0;
    const lastEngineEvent = tech.streamStats?.reduce(
      (latest: { at: number; label: string } | null, stat) => {
        const candidates: Array<{ at?: number | null; label: string }> = [
          { at: stat.lastErrorAt, label: stat.lastError ? `Error: ${stat.lastError}` : 'Error' },
          { at: stat.lastStderrAt, label: stat.lastStderr ? `Stderr: ${stat.lastStderr}` : 'Stderr' },
          {
            at: stat.lastExitAt,
            label: stat.lastExitCode != null || stat.lastExitSignal
              ? `Exit ${stat.lastExitCode ?? ''} ${stat.lastExitSignal ?? ''}`.trim()
              : 'Exit',
          },
        ];
        const newest = candidates
          .filter((c) => Number.isFinite(c.at ?? NaN))
          .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
        if (!newest || !Number.isFinite(newest.at ?? NaN)) return latest;
        if (!latest || (newest.at ?? 0) > latest.at) {
          return { at: newest.at ?? 0, label: newest.label };
        }
        return latest;
      },
      null as { at: number; label: string } | null,
    );
    const lastEngineAge = lastEngineEvent ? formatAgeMs(lastEngineEvent.at) : null;
    const engineStatus =
      engineRestarts || subscriberDrops
        ? `${engineRestarts} restarts • ${subscriberDrops} drops`
        : undefined;
    if (!inputLabel && !outputLabel) return null;
    return {
      input: inputLabel || undefined,
      output: outputLabel || undefined,
      session: sessionParts.length ? sessionParts.join(' • ') : undefined,
      streams: streams.length ? streams.join(' • ') : undefined,
      quality,
      notes: notes.length ? notes : undefined,
      throughput: throughput || undefined,
      streamDetails,
      http: httpBits.length ? httpBits.join(' • ') : undefined,
      backpressure: tech.backpressure ? `${tech.backpressure.drops} drops` : undefined,
      backpressureDrops: tech.backpressure?.drops ?? 0,
      backpressureRecent: tech.backpressure?.recentDrops ?? 0,
      clientFormat,
      streamTotal,
      protocol: tech.sendspin?.protocol ?? null,
      subscribers: (tech.streamStats || []).reduce((sum, stat) => {
        const subCount = typeof stat.subscribers === 'number' ? stat.subscribers : 1;
        return sum + subCount;
      }, 0),
      sendspinLead,
      sendspinBuffer,
      sendspinBackpressure,
      sendspinLastDrop,
      engineStatus,
      lastEngineEvent: lastEngineEvent ? `${lastEngineEvent.label}${lastEngineAge ? ` • ${lastEngineAge} ago` : ''}` : undefined,
      resampler,
    };
  };

  const [view, setView] = React.useState<ViewState>({
    loading: true,
    error: null,
    states: [],
  });
  const [groups, setGroups] = React.useState<GroupRecord[]>([]);
  const [groupsError, setGroupsError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const load = async () => {
      try {
        const { map, system } = await fetchZoneStates();
        if (cancelled) return;
        const list = Object.values(map);
        setView((prev) => ({ ...prev, states: list, system, loading: false, error: null }));
      } catch (err) {
        if (!cancelled) {
          setView((prev) => ({
            ...prev,
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load audio state',
          }));
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(load, 5000);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const loadGroups = async () => {
      try {
        const list = await fetchGroups();
        if (!cancelled) {
          setGroups(list);
          setGroupsError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setGroupsError(err instanceof Error ? err.message : 'Failed to load groups');
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(loadGroups, 7000);
        }
      }
    };

    void loadGroups();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const activeCount = view.states.filter((s) => {
    const state = (s.state ?? '').toString().trim().toLowerCase();
    return state === 'playing' || state === 'play' || state === 'paused' || state === 'pause';
  }).length;
  const loadAvg = view.system?.loadavg?.[0];
  const clockOffset = Number.isFinite(view.system?.clockOffsetMs ?? NaN) ? view.system?.clockOffsetMs ?? null : null;
  const cores = view.system?.cores ?? 1;
  const loadPerCore = loadAvg != null && cores > 0 ? loadAvg / cores : null;
  const streamTotals = React.useMemo(() => {
    let streams = 0;
    let subscribers = 0;
    let bufferedBytes = 0;
    let maxBufferedBytes = 0;
    let throughputBps = 0;
    let backpressureDrops = 0;
    let backpressureRecent = 0;
    const profileCounts = new Map<string, number>();
    const inputProviders = new Set<string>();
    const outputTargets = new Set<string>();
    const protocols = new Set<string>();
    let resampledZones = 0;
    let downmixZones = 0;
    let upmixZones = 0;
    let losslessInputs = 0;
    let lossyInputs = 0;
    let losslessPaths = 0;
    let lossyOutputs = 0;
    let httpOutputs = 0;
    const activeProfileCounts = new Map<string, number>();
    let prebufferBytes = 0;
    let sendspinBufferedBytes = 0;
    let sendspinBufferCapacity = 0;
    let sendspinLeadDriftSum = 0;
    let sendspinLeadCount = 0;
    let oldestSessionMs: number | null = null;
    let staleSessions = 0;
    let engineRestarts = 0;
    let subscriberDrops = 0;
    const now = Date.now();
    view.states.forEach((s) => {
      const stats = s.tech?.streamStats ?? [];
      streams += stats.length;
      subscribers += stats.reduce((sum, stat) => {
        const subCount = typeof stat.subscribers === 'number' ? stat.subscribers : 1;
        return sum + subCount;
      }, 0);
      stats.forEach((stat) => {
        if (Number.isFinite(stat.bufferedBytes ?? NaN)) {
          bufferedBytes += stat.bufferedBytes;
          maxBufferedBytes = Math.max(maxBufferedBytes, stat.bufferedBytes);
        }
        if (Number.isFinite(stat.bps ?? NaN)) throughputBps += stat.bps ?? 0;
        if (typeof stat.restarts === 'number') engineRestarts += stat.restarts;
        if (typeof stat.subscriberDrops === 'number') subscriberDrops += stat.subscriberDrops;
        if (typeof stat.profile === 'string' && stat.profile) {
          const key = stat.profile.toUpperCase();
          profileCounts.set(key, (profileCounts.get(key) ?? 0) + 1);
        }
      });
      if (s.tech?.inputProvider) inputProviders.add(s.tech.inputProvider);
      if (s.tech?.outputTarget) outputTargets.add(s.tech.outputTarget);
      if (s.tech?.sendspin?.protocol) protocols.add(s.tech.sendspin.protocol);
      const statsProfiles = stats.map((stat) => stat.profile.toUpperCase());
      statsProfiles.forEach((profile) => {
        activeProfileCounts.set(profile, (activeProfileCounts.get(profile) ?? 0) + 1);
      });
      if (statsProfiles.some((profile) => profile === 'MP3')) {
        httpOutputs += 1;
      }
      if (Number.isFinite(s.tech?.output?.prebufferBytes ?? NaN)) {
        prebufferBytes += s.tech?.output?.prebufferBytes ?? 0;
      }
      if (s.tech?.input?.format) {
        const fmt = s.tech.input.format.toLowerCase();
        const isLossless = /(flac|pcm|s\d{2}le|wav|alac)/.test(fmt);
        const isLossy = /(mp3|aac|m4a|ogg|opus)/.test(fmt);
        if (isLossless) losslessInputs += 1;
        if (isLossy) lossyInputs += 1;
        const outputProfile = (s.tech?.output?.profiles?.[0] ?? '').toLowerCase();
        const outputLossless = outputProfile === 'pcm' || outputProfile === 'flac';
        const outputLossy =
          outputProfile === '' ||
          outputProfile === 'mp3' ||
          outputProfile === 'aac' ||
          outputProfile === 'ogg' ||
          outputProfile === 'opus';
        const hasResample =
          s.tech?.input?.sampleRate &&
          s.tech?.output?.sampleRate &&
          s.tech.input.sampleRate !== s.tech.output.sampleRate;
        if (isLossless && outputLossless && !hasResample) {
          losslessPaths += 1;
        }
        if (isLossless && outputLossy) {
          lossyOutputs += 1;
        }
      }
      if (
        s.tech?.input?.sampleRate &&
        s.tech?.output?.sampleRate &&
        s.tech.input.sampleRate !== s.tech.output.sampleRate
      ) {
        resampledZones += 1;
      }
      if (
        s.tech?.input?.channels &&
        s.tech?.output?.channels &&
        s.tech.input.channels !== s.tech.output.channels
      ) {
        if (s.tech.output.channels < s.tech.input.channels) {
          downmixZones += 1;
        } else {
          upmixZones += 1;
        }
      }
      if (s.tech?.backpressure?.drops) {
        backpressureDrops += s.tech.backpressure.drops;
      }
      if (s.tech?.backpressure?.recentDrops) {
        backpressureRecent += s.tech.backpressure.recentDrops;
      }
      if (s.tech?.sendspin?.bufferedBytes) {
        sendspinBufferedBytes += s.tech.sendspin.bufferedBytes;
      }
      if (s.tech?.sendspin?.bufferCapacity) {
        sendspinBufferCapacity += s.tech.sendspin.bufferCapacity;
      }
      if (s.tech?.sendspin?.leadUs != null && s.tech?.sendspin?.targetLeadUs != null) {
        sendspinLeadDriftSum += (s.tech.sendspin.leadUs - s.tech.sendspin.targetLeadUs) / 1000;
        sendspinLeadCount += 1;
      }
      if (s.tech?.session?.startedAt) {
        const age = Math.max(0, now - s.tech.session.startedAt);
        if (oldestSessionMs === null || age > oldestSessionMs) {
          oldestSessionMs = age;
        }
      }
      if (s.tech?.session?.updatedAt) {
        const updated = s.tech.session.updatedAt;
        const ts = updated < 1_000_000_000_000 ? updated * 1000 : updated;
        if (now - ts > 30_000) staleSessions += 1;
      }
    });
    return {
      streams,
      subscribers,
      bufferedBytes,
      maxBufferedBytes,
      throughputBps,
      backpressureDrops,
      backpressureRecent,
      profileCounts,
      inputProviders,
      outputTargets,
      protocols,
      resampledZones,
      downmixZones,
      upmixZones,
      losslessInputs,
      lossyInputs,
      losslessPaths,
      lossyOutputs,
      httpOutputs,
      prebufferBytes,
      sendspinBufferedBytes,
      sendspinBufferCapacity,
      sendspinLeadDriftSum,
      sendspinLeadCount,
      oldestSessionMs,
      staleSessions,
      engineRestarts,
      subscriberDrops,
      activeProfileCounts,
    };
  }, [view.states]);
  const stateMap = React.useMemo(() => {
    const map = new Map<number, ZonePlaybackState>();
    view.states.forEach((s) => {
      if (typeof s.id === 'number') map.set(s.id, s);
    });
    return map;
  }, [view.states]);

  const isActiveState = (s?: ZonePlaybackState | null): boolean => {
    const state = (s?.state ?? '').toString().trim().toLowerCase();
    return state === 'playing' || state === 'play' || state === 'paused' || state === 'pause';
  };

  const isStaleState = (s?: ZonePlaybackState | null): boolean => {
    const updated = s?.tech?.session?.updatedAt;
    if (!Number.isFinite(updated ?? NaN)) return false;
    const ts = (updated ?? 0) < 1_000_000_000_000 ? (updated ?? 0) * 1000 : (updated ?? 0);
    return Date.now() - ts > 30_000;
  };

  const hasIssues = (s?: ZonePlaybackState | null): boolean => {
    if (!s?.tech) return false;
    const backpressure = s.tech.backpressure;
    const backpressureIssue = (backpressure?.drops ?? 0) > 0 || (backpressure?.recentDrops ?? 0) > 0;
    const streamIssue =
      s.tech.streamStats?.some(
        (stat) => (stat.subscriberDrops ?? 0) > 0 || (stat.restarts ?? 0) > 0 || stat.lastError || stat.lastStderr,
      ) ?? false;
    return backpressureIssue || streamIssue || isStaleState(s);
  };

  const issueCount = view.states.filter((s) => hasIssues(s)).length;

  const matchesQuery = (s: ZonePlaybackState): boolean => {
    const query = audioQuery.trim().toLowerCase();
    if (!query) return true;
    const fields = [
      s.name,
      s.title,
      s.artist,
      s.album,
      s.station,
      s.sourceName,
      s.id != null ? String(s.id) : '',
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return fields.includes(query);
  };

  const groupedZoneIds = React.useMemo(() => {
    const set = new Set<number>();
    groups.forEach((g) => g.members.forEach((m) => set.add(m)));
    return set;
  }, [groups]);

  const groupCards = React.useMemo(() => {
    return groups
      .map((group) => {
        const members = group.members.map((id, idx) => {
          const fallbackName = group.memberNames[idx] ?? `Zone ${id}`;
          return (
            stateMap.get(id) ?? {
              id,
              name: fallbackName,
              state: '',
              title: '',
              coverUrl: '',
              coverurl: '',
              tech: undefined,
            }
          );
        });
        const leaderState = stateMap.get(group.leader) ?? members.find((m) => m.id === group.leader);
        const anyActive = members.some(isActiveState);
        const protocol =
          leaderState?.tech?.sendspin?.protocol ||
          members
            .map((m) => m.tech?.sendspin?.protocol || m.tech?.outputTarget || m.tech?.inputProvider)
            .find(Boolean) ||
            null;
        return { group, members, anyActive, leaderState, protocol };
      })
      .filter(Boolean) as Array<{
        group: GroupRecord;
        members: ZonePlaybackState[];
        anyActive: boolean;
        leaderState?: ZonePlaybackState;
        protocol?: string | null;
      }>;
  }, [groups, stateMap]);

  const filteredStates = React.useMemo(() => {
    return view.states.filter((s) => {
      if (!matchesQuery(s)) return false;
      if (audioFilter === 'active') return isActiveState(s);
      if (audioFilter === 'issues') return hasIssues(s);
      return true;
    });
  }, [view.states, audioQuery, audioFilter]);

  const filteredGroupCards = React.useMemo(() => {
    return groupCards.filter((card) => {
      const matchesAnyMember = card.members.some((member) => matchesQuery(member));
      if (!matchesAnyMember && audioQuery.trim().length) return false;
      if (audioFilter === 'active') return card.anyActive;
      if (audioFilter === 'issues') return card.members.some((member) => hasIssues(member));
      return true;
    });
  }, [groupCards, audioFilter, audioQuery]);

  const activeGroups = filteredGroupCards.filter((g) => g.anyActive).length;
  const groupAccentPalette = ['#2563eb', '#0ea5e9', '#14b8a6', '#22c55e', '#f97316', '#f59e0b', '#ef4444'];
  const groupAccentByLeader = React.useMemo(() => {
    const map = new Map<number, string>();
    filteredGroupCards.forEach((card, index) => {
      const accent = groupAccentPalette[index % groupAccentPalette.length];
      map.set(card.group.leader, accent);
    });
    return map;
  }, [filteredGroupCards]);
  const memberToLeader = React.useMemo(() => {
    const map = new Map<number, number>();
    filteredGroupCards.forEach((card) => {
      card.members.forEach((member) => {
        if (member.id != null) map.set(member.id, card.group.leader);
      });
    });
    return map;
  }, [filteredGroupCards]);
  const groupCardByLeader = React.useMemo(() => {
    const map = new Map<number, (typeof filteredGroupCards)[number]>();
    filteredGroupCards.forEach((card) => {
      map.set(card.group.leader, card);
    });
    return map;
  }, [filteredGroupCards]);
  const renderEntries = React.useMemo(() => {
    const entries: Array<
      | { type: 'group'; leaderId: number; card: (typeof filteredGroupCards)[number] }
      | { type: 'zone'; state: ZonePlaybackState }
    > = [];
    const seenGroups = new Set<number>();
    filteredStates.forEach((state) => {
      const id = state.id ?? -1;
      const leaderId = memberToLeader.get(id);
      if (leaderId && !seenGroups.has(leaderId)) {
        const card = groupCardByLeader.get(leaderId);
        if (card) {
          entries.push({ type: 'group', leaderId, card });
          seenGroups.add(leaderId);
          return;
        }
      }
      if (leaderId) {
        return;
      }
      entries.push({ type: 'zone', state });
    });
    return entries;
  }, [filteredStates, memberToLeader, groupCardByLeader]);

  const TechSummary = ({
    techParts,
    protocol,
  }: {
    techParts: ReturnType<typeof formatTech> | null;
    protocol?: string | null;
  }): JSX.Element | null => {
    if (!techParts) return null;

    return (
      <div className="audio-tech audio-tech--compact">
        <div className="audio-tech__pills">
          {techParts.quality && (
            <span
              className={`audio-quality-badge ${
                techParts.quality.toLowerCase().includes('lossless') ||
                techParts.quality.toLowerCase().includes('bit-perfect')
                  ? 'is-lossless'
                  : 'is-lossy'
              }`}
            >
              {techParts.quality}
            </span>
          )}
          {protocol && <span className="audio-chip audio-chip--ghost">{protocol}</span>}
          {techParts.streamTotal && <span className="audio-chip audio-chip--ghost">{techParts.streamTotal}</span>}
          {techParts.throughput && <span className="audio-chip audio-chip--ghost">{techParts.throughput}</span>}
          {techParts.subscribers ? (
            <span className="audio-chip audio-chip--ghost">
              {techParts.subscribers} listener{techParts.subscribers === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
        <div className="audio-tech__grid">
          {techParts.input && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Input</span>
              <span className="audio-tech-value">{techParts.input}</span>
            </div>
          )}
          {techParts.output && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Output</span>
              <span className="audio-tech-value">{techParts.output}</span>
            </div>
          )}
          {techParts.resampler && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Resampler</span>
              <span className="audio-tech-value">{techParts.resampler}</span>
            </div>
          )}
          {techParts.session && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Session</span>
              <span className="audio-tech-value">{techParts.session}</span>
            </div>
          )}
          {techParts.streams && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Streams</span>
              <span className="audio-tech-value">{techParts.streams}</span>
            </div>
          )}
          {techParts.throughput && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Throughput</span>
              <span className="audio-tech-value">{techParts.throughput}</span>
            </div>
          )}
          {techParts.streamDetails?.map((line, idx) => (
            <div key={`stream-detail-${idx}`} className="audio-tech__item">
              <span className="audio-tech-label">Profile</span>
              <span className="audio-tech-value">{line}</span>
            </div>
          ))}
          {techParts.clientFormat && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Client</span>
              <span className="audio-tech-value">{techParts.clientFormat}</span>
            </div>
          )}
          {techParts.http && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">HTTP</span>
              <span className="audio-tech-value">{techParts.http}</span>
            </div>
          )}
          {techParts.backpressureDrops && techParts.backpressureDrops > 0 && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Backpressure</span>
              <span className="audio-tech-value audio-badge warning">{techParts.backpressure}</span>
            </div>
          )}
          {techParts.backpressureRecent && techParts.backpressureRecent > 0 && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Last 5m</span>
              <span className="audio-tech-value audio-badge warning">{techParts.backpressureRecent} drops</span>
            </div>
          )}
          {techParts.sendspinLead && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Sendspin lead</span>
              <span className="audio-tech-value">{techParts.sendspinLead}</span>
            </div>
          )}
          {techParts.sendspinBuffer && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Sendspin buffer</span>
              <span className="audio-tech-value">{techParts.sendspinBuffer}</span>
            </div>
          )}
          {techParts.sendspinBackpressure && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Sendspin WS</span>
              <span className="audio-tech-value">{techParts.sendspinBackpressure}</span>
            </div>
          )}
          {techParts.sendspinLastDrop && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Last drop</span>
              <span className="audio-tech-value">{techParts.sendspinLastDrop}</span>
            </div>
          )}
          {techParts.engineStatus && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">Engine</span>
              <span className="audio-tech-value">{techParts.engineStatus}</span>
            </div>
          )}
          {techParts.lastEngineEvent && (
            <div className="audio-tech__item">
              <span className="audio-tech-label">FFmpeg</span>
              <span className="audio-tech-value">{techParts.lastEngineEvent}</span>
            </div>
          )}
        </div>
        {techParts.notes?.length ? (
          <div className="audio-tech__notes">
            {techParts.notes.map((note, idx) => (
              <span key={`note-${idx}`} className="audio-chip audio-chip--ghost">
                {note}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const renderSnapshotChips = (items: string[]): JSX.Element => {
    if (!items.length) {
      return <span className="audio-snapshot__value">—</span>;
    }
    return (
      <div className="audio-snapshot__chips">
        {items.map((item) => (
          <span key={item} className="audio-snapshot__chip">
            {item}
          </span>
        ))}
      </div>
    );
  };

  const compactIoLabel = (value?: string): string | null => {
    if (!value) return null;
    return value.split(' • ')[0] ?? value;
  };

  return (
    <div className="audio-layout">
      <div className="audio-shell">
        <header className="audio-hero">
          <div className="audio-hero__copy">
            <p className="audio-eyebrow">Audio manager & Stream Engine</p>
            <h1>Live sessions</h1>
            <p className="audio-subtitle">
              The Audio Manager owns per-zone sessions, stream URLs, and profile decisions. It hands playback to the Stream Engine,
              which runs per-profile ffmpeg pipelines, buffers audio, and fans out to subscribers (Sendspin, HTTP, AirPlay, DLNA).
              Track live signal flow per zone, see active profiles, and spot throughput or buffer pressure.
            </p>
          </div>
          <div className="audio-hero__stats">
            {[
              {
                label: 'System load',
                value: typeof loadAvg === 'number' ? loadAvg.toFixed(2) : '–',
                sub: typeof loadPerCore === 'number' ? `${loadPerCore.toFixed(2)} /core` : '',
                tone: 'muted',
              },
              {
                label: 'Sync groups',
                value: groupCards.length,
                sub: `${activeGroups} active`,
              },
              {
                label: 'Streams',
                value: streamTotals.streams,
                sub: `${streamTotals.subscribers} listener${streamTotals.subscribers === 1 ? '' : 's'}`,
              },
              {
                label: 'NTP offset',
                value: clockOffset !== null ? `${clockOffset} ms` : 'Clock ok',
              },
            ].map((stat) => (
              <div key={stat.label} className={`audio-hero__stat${stat.tone === 'muted' ? ' is-muted' : ''}`}>
                <span className="audio-hero__stat-label">{stat.label}</span>
                <span className="audio-hero__stat-value">{stat.value}</span>
                {stat.sub ? <span className="audio-hero__stat-sub">{stat.sub}</span> : null}
              </div>
            ))}
          </div>
        </header>
        <div className="audio-toolbar">
          <div className="audio-toolbar__search">
            <input
              type="search"
              value={audioQuery}
              onChange={(event) => setAudioQuery(event.target.value)}
              placeholder="Search zones, sources, or track info"
              aria-label="Search audio sessions"
            />
          </div>
          <div className="audio-toolbar__filters" role="group" aria-label="Session filters">
            <button
              type="button"
              className={`audio-filter ${audioFilter === 'all' ? 'is-active' : ''}`}
              onClick={() => setAudioFilter('all')}
            >
              All
              <span className="audio-filter__count">{view.states.length}</span>
            </button>
            <button
              type="button"
              className={`audio-filter ${audioFilter === 'active' ? 'is-active' : ''}`}
              onClick={() => setAudioFilter('active')}
            >
              Active
              <span className="audio-filter__count">{activeCount}</span>
            </button>
            <button
              type="button"
              className={`audio-filter ${audioFilter === 'issues' ? 'is-active' : ''}`}
              onClick={() => setAudioFilter('issues')}
            >
              Issues
              <span className="audio-filter__count">{issueCount}</span>
            </button>
          </div>
          <div className="audio-toolbar__filters" role="group" aria-label="Detail level">
            <button
              type="button"
              className={`audio-filter ${audioDensity === 'overview' ? 'is-active' : ''}`}
              onClick={() => setAudioDensity('overview')}
            >
              Overview
            </button>
            <button
              type="button"
              className={`audio-filter ${audioDensity === 'detailed' ? 'is-active' : ''}`}
              onClick={() => setAudioDensity('detailed')}
            >
              Detailed
            </button>
          </div>
          <div className="audio-toolbar__meta">
            Showing {filteredStates.length} of {view.states.length} sessions
          </div>
        </div>

        {view.loading && <p className="audio-status subtle">Loading audio state…</p>}
        {view.error && <p className="audio-status error">{view.error}</p>}
        {!view.loading && !view.error && filteredStates.length === 0 && (
          <p className="audio-status subtle">No sessions match this filter.</p>
        )}

        <section className="audio-section">
          <div className="zones-host-card zones-host-card--full">
            <div className="zones-host-card__top">
              <div>
                <p className="audio-section__eyebrow">Zones</p>
                <p className="audio-section__title">Sessions</p>
                {audioDensity === 'detailed' && (
                  <>
                      <p className="audio-section__hint">Monitor grouped and standalone rooms, plus their streams.</p>
                      <div className="audio-pipeline">
                        <span className="audio-pipeline__item">Source</span>
                        <span className="audio-pipeline__arrow">→</span>
                        <span className="audio-pipeline__item">Resolver</span>
                        <span className="audio-pipeline__arrow">→</span>
                        <span className="audio-pipeline__item">Manager</span>
                        <span className="audio-pipeline__arrow">→</span>
                        <span className="audio-pipeline__item">Engine</span>
                        <span className="audio-pipeline__arrow">→</span>
                        <span className="audio-pipeline__item">Profiles</span>
                        <span className="audio-pipeline__arrow">→</span>
                        <span className="audio-pipeline__item">Subscribers</span>
                        <span className="audio-pipeline__arrow">→</span>
                        <span className="audio-pipeline__item">Outputs</span>
                      </div>
                      <p className="audio-pipeline__detail">
                        Resolve source → create session → spawn ffmpeg → buffer → publish streams · prefer lossless paths whenever possible.
                      </p>
                    </>
                  )}
                </div>
                <div className="zone-count zone-count--compact">
                  <span className="zone-count__value">{renderEntries.length}</span>
                  <span className="zone-count__label">sessions</span>
                </div>
            </div>
            {audioDensity === 'detailed' && (
                <div className="audio-snapshot">
                  <div className="audio-snapshot__section">
                    <div className="audio-snapshot__section-head">Routing</div>
                    <div className="audio-snapshot__grid">
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Active sessions</span>
                        <span className="audio-snapshot__value">{activeCount}</span>
                      </div>
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Streams</span>
                        <span className="audio-snapshot__value">{streamTotals.streams}</span>
                      </div>
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Inputs</span>
                        {renderSnapshotChips(Array.from(streamTotals.inputProviders.values()))}
                      </div>
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Outputs</span>
                        {renderSnapshotChips(Array.from(streamTotals.outputTargets.values()))}
                      </div>
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Protocols</span>
                        {renderSnapshotChips(Array.from(streamTotals.protocols.values()))}
                      </div>
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Profiles</span>
                        {renderSnapshotChips(
                          Array.from(streamTotals.activeProfileCounts.entries()).map(
                            ([profile, count]) => `${profile} ${count}`,
                          ),
                        )}
                      </div>
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">HTTP outputs</span>
                        <span className="audio-snapshot__value">
                          {streamTotals.httpOutputs ? `${streamTotals.httpOutputs}` : '—'}
                        </span>
                      </div>
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Lossless paths</span>
                        <span className="audio-snapshot__value">
                          {streamTotals.losslessPaths ? `${streamTotals.losslessPaths}` : '0'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="audio-snapshot__section">
                    <div className="audio-snapshot__section-head">Performance</div>
                    <div className="audio-snapshot__grid">
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Buffered</span>
                        <span className="audio-snapshot__value">
                          {formatBytes(streamTotals.bufferedBytes) ?? '—'}
                          {streamTotals.maxBufferedBytes > 0 ? (
                            <span className="audio-snapshot__value-muted">
                              {' '}
                              · peak {formatBytes(streamTotals.maxBufferedBytes)}
                            </span>
                          ) : null}
                        </span>
                      </div>
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Subscribers</span>
                        <span className="audio-snapshot__value">{streamTotals.subscribers}</span>
                      </div>
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Throughput</span>
                        <span className="audio-snapshot__value">
                          {formatBitrate(streamTotals.throughputBps) ?? '—'}
                        </span>
                      </div>
                      <div
                        className={`audio-snapshot__item${streamTotals.resampledZones ? ' audio-snapshot__item--warn' : ''}`}
                      >
                        <span className="audio-snapshot__label">Resampling</span>
                        <span className="audio-snapshot__value">
                          {streamTotals.resampledZones ? `${streamTotals.resampledZones} zones` : 'None'}
                        </span>
                      </div>
                      <div
                        className={`audio-snapshot__item${streamTotals.downmixZones || streamTotals.upmixZones ? ' audio-snapshot__item--warn' : ''}`}
                      >
                        <span className="audio-snapshot__label">Channel mix</span>
                        <span className="audio-snapshot__value">
                          {streamTotals.downmixZones || streamTotals.upmixZones
                            ? `${streamTotals.downmixZones} downmix · ${streamTotals.upmixZones} upmix`
                            : 'None'}
                        </span>
                      </div>
                      <div className={`audio-snapshot__item${streamTotals.lossyInputs ? ' audio-snapshot__item--warn' : ''}`}>
                        <span className="audio-snapshot__label">Input quality</span>
                        <span className="audio-snapshot__value">
                          {streamTotals.losslessInputs || streamTotals.lossyInputs
                            ? `${streamTotals.losslessInputs} lossless · ${streamTotals.lossyInputs} lossy`
                            : '—'}
                        </span>
                      </div>
                      <div
                        className={`audio-snapshot__item${streamTotals.lossyOutputs ? ' audio-snapshot__item--warn' : ''}`}
                      >
                        <span className="audio-snapshot__label">Lossy outputs</span>
                        <span className="audio-snapshot__value">
                          {streamTotals.lossyOutputs ? `${streamTotals.lossyOutputs}` : '0'}
                        </span>
                      </div>
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Prebuffer</span>
                        <span className="audio-snapshot__value">
                          {formatBytes(streamTotals.prebufferBytes) ?? '—'}
                        </span>
                      </div>
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Sendspin buffer</span>
                        <span className="audio-snapshot__value">
                          {formatBytes(streamTotals.sendspinBufferedBytes) ?? '—'}
                          {streamTotals.sendspinBufferCapacity > 0 ? (
                            <span className="audio-snapshot__value-muted">
                              {' '}
                              · {Math.min(
                                100,
                                Math.round(
                                  (streamTotals.sendspinBufferedBytes / streamTotals.sendspinBufferCapacity) * 100,
                                ),
                              )}
                              %
                            </span>
                          ) : null}
                        </span>
                      </div>
                      <div
                        className={`audio-snapshot__item${
                          streamTotals.sendspinLeadCount &&
                          Math.abs(streamTotals.sendspinLeadDriftSum / streamTotals.sendspinLeadCount) > 5
                            ? ' audio-snapshot__item--warn'
                            : ''
                        }`}
                      >
                        <span className="audio-snapshot__label">Sendspin lead</span>
                        <span className="audio-snapshot__value">
                          {streamTotals.sendspinLeadCount
                            ? `${(streamTotals.sendspinLeadDriftSum / streamTotals.sendspinLeadCount).toFixed(1)} ms drift`
                            : '—'}
                        </span>
                      </div>
                      <div
                        className={`audio-snapshot__item${streamTotals.engineRestarts ? ' audio-snapshot__item--warn' : ''}`}
                      >
                        <span className="audio-snapshot__label">Engine restarts</span>
                        <span className="audio-snapshot__value">
                          {streamTotals.engineRestarts ? `${streamTotals.engineRestarts}` : '0'}
                        </span>
                      </div>
                      <div
                        className={`audio-snapshot__item${streamTotals.subscriberDrops ? ' audio-snapshot__item--warn' : ''}`}
                      >
                        <span className="audio-snapshot__label">Subscriber drops</span>
                        <span className="audio-snapshot__value">
                          {streamTotals.subscriberDrops ? `${streamTotals.subscriberDrops}` : '0'}
                        </span>
                      </div>
                      <div
                        className={`audio-snapshot__item${
                          streamTotals.backpressureDrops || streamTotals.backpressureRecent
                            ? ' audio-snapshot__item--warn'
                            : ''
                        }`}
                      >
                        <span className="audio-snapshot__label">Backpressure</span>
                        <span className="audio-snapshot__value">
                          {streamTotals.backpressureDrops ? `${streamTotals.backpressureDrops} drops` : '0 drops'}
                          {streamTotals.backpressureRecent > 0 ? (
                            <span className="audio-snapshot__value-muted">
                              {' '}
                              · {streamTotals.backpressureRecent} last 5m
                            </span>
                          ) : null}
                        </span>
                      </div>
                      <div className="audio-snapshot__item">
                        <span className="audio-snapshot__label">Oldest session</span>
                        <span className="audio-snapshot__value">
                          {streamTotals.oldestSessionMs ? formatSeconds(streamTotals.oldestSessionMs / 1000) ?? '—' : '—'}
                        </span>
                      </div>
                      <div
                        className={`audio-snapshot__item${streamTotals.staleSessions ? ' audio-snapshot__item--warn' : ''}`}
                      >
                        <span className="audio-snapshot__label">Stale sessions</span>
                        <span className="audio-snapshot__value">
                          {streamTotals.staleSessions ? `${streamTotals.staleSessions}` : '0'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            <div className="audio-grid audio-grid--inset">
              {renderEntries.map((entry) => {
                if (entry.type === 'group') {
                  const { card, leaderId } = entry;
                  const leader =
                    card.leaderState ?? {
                      id: card.group.leader,
                      name: card.group.leaderName,
                      state: '',
                      title: '',
                      artist: '',
                      album: '',
                      station: '',
                      coverUrl: '',
                      coverurl: '',
                      tech: undefined,
                    };
                  const playbackStateRaw = (leader.state ?? '').toString().trim().toLowerCase();
                  const playbackState = playbackStateRaw || 'idle';
                  const title = leader.title?.trim() || leader.station?.trim() || 'Idle';
                  const subtitle = leader.artist?.trim() || leader.album?.trim() || leader.sourceName?.trim() || '';
                  const cover =
                    leader.coverUrl || leader.coverurl || 'https://dummyimage.com/160x160/0f0f0f/ffffff&text=Audio';
                  const techParts = formatTech(leader.tech);
                  const protocol = leader.tech?.sendspin?.protocol ?? null;
                  const sessionAge =
                    leader.tech?.session?.startedAt != null
                      ? formatSeconds((Date.now() - leader.tech.session.startedAt) / 1000)
                      : null;
                  const lastUpdate =
                    leader.tech?.session?.updatedAt != null ? formatAgeMs(leader.tech.session.updatedAt) : null;
                  const isStale =
                    leader.tech?.session?.updatedAt != null
                      ? Date.now() - (leader.tech.session.updatedAt < 1_000_000_000_000
                          ? leader.tech.session.updatedAt * 1000
                          : leader.tech.session.updatedAt) > 30_000
                      : false;
                  const inputKind = leader.tech?.input?.kind ?? null;
                  const outputProfiles = leader.tech?.output?.profiles?.length
                    ? leader.tech.output.profiles.map((p) => p.toUpperCase()).join(', ')
                    : null;
                  const leadMs =
                    leader.tech?.sendspin?.leadUs != null
                      ? Math.round((leader.tech.sendspin.leadUs / 1000) * 10) / 10
                      : null;
                  const targetMs =
                    leader.tech?.sendspin?.targetLeadUs != null
                      ? Math.round((leader.tech.sendspin.targetLeadUs / 1000) * 10) / 10
                      : null;
                  const leadDrift =
                    leadMs != null && targetMs != null ? Math.round((leadMs - targetMs) * 10) / 10 : null;
                  const isActive =
                    playbackState === 'playing' ||
                    playbackState === 'play' ||
                    playbackState === 'paused' ||
                    playbackState === 'pause';
                  const accent = groupAccentByLeader.get(leaderId) ?? groupAccentPalette[0];
                  const groupSpan = Math.max(1, Math.min(card.members.length || 1, 4));
                  const groupIdLabel = card.group.externalId ? `#${card.group.externalId}` : 'Group';
                  return (
                    <article
                      key={`group-${leaderId}`}
                      className={`audio-card audio-card--group ${audioDensity === 'overview' ? 'is-compact' : ''}`}
                      style={{ '--group-accent': accent, gridColumn: `span ${groupSpan}` } as React.CSSProperties}
                    >
                      <div className="audio-card__main audio-media">
                        <div className="audio-card__cover">
                          <img src={cover} alt="" />
                          <span className={`audio-state audio-state--${playbackState}`}>{playbackState}</span>
                        </div>
                        <div className="audio-card__body">
                          <div className="audio-card__head">
                            <div className="audio-card__zone">
                              {card.members.length > 1 ? 'Group session' : leader.name || `Zone ${leader.id}`}
                            </div>
                            <div className="audio-card__id">
                              <span className="audio-card__id-plain">{groupIdLabel}</span>
                            </div>
                          </div>
                          <p className="audio-card__title">{title}</p>
                          <p className="audio-card__subtitle">{subtitle || 'No metadata yet'}</p>
                          {audioDensity === 'detailed' &&
                            (sessionAge ||
                              lastUpdate ||
                              inputKind ||
                              outputProfiles ||
                              leadMs != null ||
                              leadDrift != null) && (
                              <div className={`audio-card__meta${isStale ? ' is-stale' : ''}`}>
                                {sessionAge && <span>Session {sessionAge}</span>}
                                {lastUpdate && <span>Updated {lastUpdate} ago</span>}
                                {inputKind && <span>Input {inputKind}</span>}
                                {outputProfiles && <span>Profiles {outputProfiles}</span>}
                                {leadMs != null && (
                                  <span>
                                    Lead {leadMs} ms
                                    {leadDrift != null ? ` (${leadDrift >= 0 ? '+' : ''}${leadDrift} ms)` : ''}
                                  </span>
                                )}
                              </div>
                            )}
                          {audioDensity === 'detailed' && <TechSummary techParts={techParts} protocol={protocol} />}
                          <div className="audio-group-tile__members">
                            {card.members.map((member) => (
                              <span key={member.id} className="audio-group-tile__member">
                                {member.name ?? `Zone ${member.id}`}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                }
                const state = entry.state;
                const playbackStateRaw = (state.state ?? '').toString().trim().toLowerCase();
                const playbackState = playbackStateRaw || 'idle';
                const title = state.title?.trim() || state.station?.trim() || 'Idle';
                const subtitle = state.artist?.trim() || state.album?.trim() || state.sourceName?.trim() || '';
                const cover =
                  state.coverUrl || state.coverurl || 'https://dummyimage.com/160x160/0f0f0f/ffffff&text=Audio';
                const techParts = formatTech(state.tech);
                const protocol = state.tech?.sendspin?.protocol ?? null;
                const sessionAge =
                  state.tech?.session?.startedAt != null
                    ? formatSeconds((Date.now() - state.tech.session.startedAt) / 1000)
                    : null;
                const lastUpdate =
                  state.tech?.session?.updatedAt != null ? formatAgeMs(state.tech.session.updatedAt) : null;
                const isStale =
                  state.tech?.session?.updatedAt != null
                    ? Date.now() - (state.tech.session.updatedAt < 1_000_000_000_000
                        ? state.tech.session.updatedAt * 1000
                        : state.tech.session.updatedAt) > 30_000
                    : false;
                const inputKind = state.tech?.input?.kind ?? null;
                const outputProfiles = state.tech?.output?.profiles?.length
                  ? state.tech.output.profiles.map((p) => p.toUpperCase()).join(', ')
                  : null;
                const leadMs =
                  state.tech?.sendspin?.leadUs != null
                    ? Math.round((state.tech.sendspin.leadUs / 1000) * 10) / 10
                    : null;
                const targetMs =
                  state.tech?.sendspin?.targetLeadUs != null
                    ? Math.round((state.tech.sendspin.targetLeadUs / 1000) * 10) / 10
                    : null;
                const leadDrift =
                  leadMs != null && targetMs != null ? Math.round((leadMs - targetMs) * 10) / 10 : null;
                const isActive =
                  playbackState === 'playing' ||
                  playbackState === 'play' ||
                  playbackState === 'paused' ||
                  playbackState === 'pause';
                return (
                  <article
                    key={state.id}
                    className={`audio-card ${isActive ? 'is-active' : ''} ${audioDensity === 'overview' ? 'is-compact' : ''}`}
                  >
                    <div className="audio-card__main audio-media">
                      <div className="audio-card__cover">
                        <img src={cover} alt="" />
                        <span className={`audio-state audio-state--${playbackState}`}>{playbackState}</span>
                      </div>
                      <div className="audio-card__body">
                        <div className="audio-card__head">
                          <div className="audio-card__zone">{state.name || `Zone ${state.id}`}</div>
                          <div className="audio-card__id">
                            <span className="audio-card__id-plain">#{state.id}</span>
                          </div>
                        </div>
                        <p className="audio-card__title">{title}</p>
                        <p className="audio-card__subtitle">{subtitle || 'No metadata yet'}</p>
                        {audioDensity === 'detailed' &&
                          (sessionAge || lastUpdate || inputKind || outputProfiles || leadMs != null || leadDrift != null) && (
                            <div className={`audio-card__meta${isStale ? ' is-stale' : ''}`}>
                              {sessionAge && <span>Session {sessionAge}</span>}
                              {lastUpdate && <span>Updated {lastUpdate} ago</span>}
                              {inputKind && <span>Input {inputKind}</span>}
                              {outputProfiles && <span>Profiles {outputProfiles}</span>}
                              {leadMs != null && (
                                <span>
                                  Lead {leadMs} ms
                                  {leadDrift != null ? ` (${leadDrift >= 0 ? '+' : ''}${leadDrift} ms)` : ''}
                                </span>
                              )}
                            </div>
                          )}
                        {audioDensity === 'detailed' && <TechSummary techParts={techParts} protocol={protocol} />}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
