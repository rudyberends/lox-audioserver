// @ts-nocheck
export function renderZoneCard(zone) {
  if (!zone) return '';
  if (zone && zone.placeholder === 'extension') {
    return renderExtensionPlaceholderCard(zone);
  }
  const status = getZoneStatusEntry(zone);
  const adapter = getZoneAdapter(zone);
  const adapterType = normalizeAdapterType(status?.adapterType ?? adapter.type);
  const adapterLabel = formatAdapterLabel(adapterType);
  const adapterDescription = describeAdapter(adapterType);
  const adapterParams = adapter.parameters || {};
  const musicAssistant = isMusicAssistantAdapter(adapterType);
  const isNull = isNullAdapter(adapterType);
  const connected = !isNull && Boolean(status?.connected);
  const statusPrefix = connected ? 'Online' : 'Pending connection';
  const statusText = isNull ? 'Unassigned' : statusPrefix;
  const statusClass = isNull ? 'dummy' : connected ? 'connected' : 'disconnected';
  const safeStatusText = escapeHtml(statusText);
  const zoneNumber = typeof zone.id === 'number' ? zone.id : '—';
  const safeZoneId = escapeHtml(String(zoneNumber));
  const zoneNameRaw = `${status?.name ?? zone.name ?? ''}`.trim();
  const safeZoneName = zoneNameRaw ? escapeHtml(zoneNameRaw) : '';
  const zoneTitle = safeZoneName ? safeZoneName : `#${safeZoneId}`;
  const metadataBlock = renderZoneMetadata(status, { isDummy: isNull });
  const hasPlayerSelection = Boolean(String(adapterParams.maPlayerId || '').trim());
  let connectHint = '';
  const connectError = state.zoneStatus?.[zone.id]?.connectError || '';
  const cardStateClass = connected
    ? 'zone-card--connected'
    : isNull
      ? 'zone-card--unassigned'
      : 'zone-card--pending';

  if (!connected && musicAssistant && !hasPlayerSelection) {
    connectHint = '<p class="zone-card-hint">Configure a Music Assistant player before connecting.</p>';
  }

  const zoneLabel = safeZoneName || `Zone ${safeZoneId}`;
  const zoneLabelAria = escapeHtml(zoneLabel);
  let adapterSubDetail = '';
  if (musicAssistant) {
    const playerId = String(adapterParams.maPlayerId ?? '').trim();
    if (playerId) adapterSubDetail = escapeHtml(playerId);
  } else {
    const ipRaw = adapterParams.ip ?? adapterParams.IP;
    const ip = typeof ipRaw === 'string' ? ipRaw.trim() : '';
    if (ip) adapterSubDetail = escapeHtml(ip);
  }

  const adapterDescriptionMarkup = adapterDescription && !musicAssistant
    ? `<span class="zone-adapter-description">${escapeHtml(adapterDescription)}</span>`
    : '';
  const adapterSubDetailMarkup = adapterSubDetail && !musicAssistant
    ? `<span class="zone-adapter-sub">${adapterSubDetail}</span>`
    : '';

  return `
    <article class="zone-card ${cardStateClass}" data-index="${zone.id}">
      <header class="zone-card-header">
        <div class="zone-card-heading">
          <h3 class="zone-card-title">${zoneTitle}</h3>
        </div>
        <div class="zone-card-status-dot zone-card-status-dot--${statusClass}" title="${safeStatusText}" data-zone-status="${zone.id}" aria-hidden="true"></div>
      </header>
      <div class="zone-card-playback">
        <div class="zone-card-nowplaying">${metadataBlock}</div>
      </div>
      <div class="zone-card-adapter">
        <span class="zone-adapter-label">Zone adapter</span>
        <div class="zone-adapter-info">
          <span class="zone-adapter-name">${escapeHtml(adapterLabel)}</span>
        </div>
        ${adapterDescriptionMarkup}
        ${adapterSubDetailMarkup}
      </div>
      <div class="zone-card-divider" aria-hidden="true"></div>
      <div class="zone-card-actions">
        <button type="button" class="zone-adapter-button" data-action="configure-zone" data-id="${zone.id}" aria-label="Configure ${zoneLabelAria}">
          <span class="zone-adapter-button__label">Configure</span>
          <span class="zone-adapter-button__icon" aria-hidden="true">→</span>
        </button>
      </div>
      ${connectHint}
      ${connectError ? `<p class="zone-card-error">${escapeHtml(connectError)}</p>` : ''}
    </article>
  `;
}


