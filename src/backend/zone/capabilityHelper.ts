import type { ZoneCapabilityDescriptor, ZoneCapabilityKind, ZoneCapabilityStatus } from './capabilityTypes';

type CapabilityOverride = Partial<Record<ZoneCapabilityKind, {
  status: ZoneCapabilityStatus;
  detail?: string;
}>>;

export const CAPABILITY_KIND_ORDER: ZoneCapabilityKind[] = ['control', 'content', 'grouping', 'alerts', 'tts'];

const NONE_STATUS: ZoneCapabilityStatus = 'none';

function resolveStatus(value: CapabilityOverride[ZoneCapabilityKind] | undefined, fallback: ZoneCapabilityStatus) {
  return value?.status ?? fallback;
}

function resolveDetail(value: CapabilityOverride[ZoneCapabilityKind] | undefined) {
  const detail = value?.detail?.trim();
  return detail ? detail : undefined;
}

export function buildCapabilitySet(
  source: 'backend' | 'adapter',
  overrides: CapabilityOverride = {},
  defaults: CapabilityOverride = {},
): ZoneCapabilityDescriptor[] {
  return CAPABILITY_KIND_ORDER.map((kind) => {
    const defaultEntry = defaults[kind];
    const overrideEntry = overrides[kind];

    const status = resolveStatus(overrideEntry, resolveStatus(defaultEntry, NONE_STATUS));
    const detail = resolveDetail(overrideEntry) ?? resolveDetail(defaultEntry);

    return {
      kind,
      status,
      detail,
      source,
    };
  });
}

export function backendCapabilities(overrides: CapabilityOverride = {}, defaults: CapabilityOverride = {}) {
  return buildCapabilitySet('backend', overrides, defaults);
}

export function backendNativeCapabilities(overrides: CapabilityOverride = {}) {
  const defaults: CapabilityOverride = {
    control: { status: 'native' },
    content: { status: 'native' },
    grouping: { status: 'native' },
    alerts: { status: 'native' },
    tts: { status: 'native' },
  };
  return backendCapabilities(overrides, defaults);
}

export function backendNoneCapabilities(overrides: CapabilityOverride = {}) {
  return backendCapabilities(overrides);
}

export function adapterCapabilities(overrides: CapabilityOverride = {}, defaults: CapabilityOverride = {}) {
  return buildCapabilitySet('adapter', overrides, defaults);
}

export function adapterContentCapabilities(detail?: string) {
  return adapterCapabilities({
    content: { status: 'adapter', detail },
  });
}
