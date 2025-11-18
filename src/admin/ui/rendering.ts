// @ts-nocheck
export function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  const raf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (callback) => setTimeout(callback, 16);
  raf(() => {
    renderScheduled = false;
    render();
  });
}

export function render() {
  if (!state.config) return;

  let focusSnapshot = null;
  if (typeof document !== 'undefined') {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      const activeId = activeElement.id;
      if (activeId && FOCUS_PRESERVE_IDS.has(activeId)) {
        let selectionStart = null;
        let selectionEnd = null;
        let selectionDirection = null;
        if ('selectionStart' in activeElement && 'selectionEnd' in activeElement) {
          try {
            selectionStart = activeElement.selectionStart;
            selectionEnd = activeElement.selectionEnd;
            selectionDirection = activeElement.selectionDirection || null;
          } catch (error) {
            selectionStart = null;
            selectionEnd = null;
            selectionDirection = null;
          }
        }
        focusSnapshot = { id: activeId, selectionStart, selectionEnd, selectionDirection };
      }
    }
  }

  if (Array.isArray(state.config.zones)) {
    state.config.zones.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }

  const panelsHtml = renderPanels(state.config);
  const modalHtml = renderAdapterModal();
  app.innerHTML = panelsHtml + modalHtml;
  bindFormEvents();
  updateTabs();
  updateHeroSummary();
  maybeLoadLogs();

  if (focusSnapshot && typeof document !== 'undefined') {
    const nextElement = document.getElementById(focusSnapshot.id);
    if (nextElement instanceof HTMLElement) {
      try {
        if (typeof nextElement.focus === 'function') {
          nextElement.focus({ preventScroll: true });
        }
      } catch {
        try {
          nextElement.focus();
        } catch {
          // Ignore focus errors
        }
      }
      if (
        focusSnapshot.selectionStart !== null &&
        focusSnapshot.selectionEnd !== null &&
        'setSelectionRange' in nextElement
      ) {
        try {
          nextElement.setSelectionRange(
            focusSnapshot.selectionStart,
            focusSnapshot.selectionEnd,
            focusSnapshot.selectionDirection ?? 'none',
          );
        } catch {
          // Ignore selection errors
        }
      }
    }
  }
}

export function renderPanels(config) {
  const activeTab = state.activeTab || 'miniserver';
  const panelClass = (name) => `tabpanel${activeTab === name ? ' active' : ''}`;
  const isPaired = Boolean(config.audioserver?.paired);
  const miniserverIpRaw = config.miniserver?.ip || '';
  const miniserverIpValue = escapeHtml(miniserverIpRaw);
  const miniserverSerialRaw = config.miniserver?.serial || '';
  const miniserverSerialValue = escapeHtml(isPaired ? miniserverSerialRaw : '');
  const miniserverIpField = `
            <div class="form-control readonly-field">
              <label for="miniserver-ip">Miniserver IP</label>
              <input id="miniserver-ip" type="text" value="${miniserverIpValue}" readonly aria-readonly="true" placeholder="Will populate after pairing" />
            </div>`;
  const miniserverSerialField = `
            <div class="form-control readonly-field">
              <label for="miniserver-serial">Miniserver Serial</label>
              <input id="miniserver-serial" type="text" value="${miniserverSerialValue}" readonly aria-readonly="true" placeholder="Will populate after pairing" />
            </div>`;
  const connectionCard = `
            <article class="miniserver-card connection">
              <header>
                <div>
                  <h3>Connection</h3>
                  <p>Review the detected MiniServer details after pairing.</p>
                </div>
                <div class="connection-state">${renderMiniserverBadge(config)}</div>
              </header>
              <div class="miniserver-form">
                ${miniserverIpField}
                ${miniserverSerialField}
              </div>
              ${renderPairingWaitIndicator()}
            </article>`;

  const generalPanel = `
    <section data-tabpanel="miniserver" class="${panelClass('miniserver')}">
      <div class="miniserver-header">
        <div class="miniserver-title">
          <h2>AudioServer Setup</h2>
          <p class="miniserver-subtitle">Follow these steps to get paired and start using the AudioServer.</p>
        </div>
        <div class="miniserver-state">
          ${renderPairingBadge(config.audioserver)}
        </div>
      </div>
      <div class="miniserver-layout">
        <div class="miniserver-primary">
          ${connectionCard}
        </div>
        ${renderStatus(config)}
      </div>
    </section>
  `;

  const zonesPanel = `
    <section data-tabpanel="zones" class="${panelClass('zones')}">
      ${renderZonesPanel(config)}
    </section>
  `;

  const updatePanel = `
    <section data-tabpanel="update" class="${panelClass('update')}">
      ${renderUpdatePanel()}
    </section>
  `;

  const logsPanel = `
    <section data-tabpanel="logs" class="${panelClass('logs')}">
      ${renderLogs(config.logging)}
    </section>
  `;

  return `${generalPanel}${zonesPanel}${updatePanel}${logsPanel}`;
}

export function renderStatus(config) {
  const audioserver = config.audioserver ?? {};
  const zones = Array.isArray(config.zones) ? config.zones : [];
  const hasUnassignedZones = zones.some((zone = {}) => isNullAdapter(getZoneAdapter(zone).type));
  const assignmentStepClass = hasUnassignedZones ? 'pairing-step-pending' : 'pairing-step-complete';
  const assignmentBadgeClass = hasUnassignedZones ? 'pending' : 'complete';
  const assignmentBadgeLabel = hasUnassignedZones ? 'Incomplete' : 'Complete';
  const providerConfig = config.mediaProvider ?? {};
  const providerTypeRaw = typeof providerConfig.type === 'string' ? providerConfig.type : '';
  const providerType = providerTypeRaw.trim();
  const providerOptions = providerConfig.options && typeof providerConfig.options === 'object' ? providerConfig.options : {};
  const providerHostRaw = typeof providerOptions.IP === 'string' ? providerOptions.IP : '';
  const providerHost = providerHostRaw.trim();
  const providerRequiresHost = Boolean(providerType && providerType !== 'DummyProvider');
  const providerConfigured = Boolean(providerType && (!providerRequiresHost || providerHost));
  const providerStepClass = providerConfigured ? 'pairing-step-complete' : 'pairing-step-pending';
  const providerBadgeClass = providerConfigured ? 'complete' : 'pending';
  const providerBadgeLabel = providerConfigured ? 'Complete' : 'Pending';
  const zoneActionLabel = hasUnassignedZones ? 'Go to Zones tab' : 'Review zones';
  const providerActionLabel = providerConfigured ? 'Review provider' : 'Open provider setup';
  const pairingHelp = audioserver.paired
    ? `
        <ol class="pairing-steps">
          <li class="${assignmentStepClass}">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Assign players</strong>
                <span class="pairing-step-status ${assignmentBadgeClass}">${assignmentBadgeLabel}</span>
              </div>
              <span class="pairing-step-description">Loxone zones are downloaded from the Miniserver config. Assign an adapter to each zone in the Zones tab.</span>
              <div class="pairing-step-actions">
                <button type="button" class="pairing-step-link" data-nav-tab="zones">${zoneActionLabel}</button>
              </div>
            </div>
          </li>
          <li class="pairing-step-optional ${providerStepClass}">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Add a provider</strong>
                <span class="pairing-step-status optional">Optional</span>
                <span class="pairing-step-status ${providerBadgeClass}">${providerBadgeLabel}</span>
              </div>
              <span class="pairing-step-description">Enable a provider to expose sources to the AudioServer. Without a provider the server returns empty lists for every source request.</span>
              <div class="pairing-step-actions">
                <button type="button" class="pairing-step-link" data-nav-tab="zones" data-scroll-target="#zones-provider">${providerActionLabel}</button>
              </div>
            </div>
          </li>
        </ol>
      `
    : `
        <ol class="pairing-steps">
          <li class="pairing-step-required">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Add an Audio Server in Loxone Config</strong>
                <span class="pairing-step-status required">Required</span>
              </div>
              <span class="pairing-step-description">Use IP of this service and serial <code>50:4F:94:FF:1B:B3</code>.</span>
            </div>
          </li>
          <li class="pairing-step-required">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Configure audio zones</strong>
                <span class="pairing-step-status required">Required</span>
              </div>
              <span class="pairing-step-description">Drop the AudioServer outputs into your project. You start with two stereo outputs (two zones) but can split them for four zones. Loxone labels the split outputs as mono, yet they remain full stereo.</span>
            </div>
          </li>
          <li class="pairing-step-required">
            <span class="pairing-step-indicator" aria-hidden="true"></span>
            <div class="pairing-step-content">
              <div class="pairing-step-heading">
                <strong>Deploy changes</strong>
                <span class="pairing-step-status required">Required</span>
              </div>
              <span class="pairing-step-description">Save your changes and let the Miniserver reboot. The Miniserver initiates pairing with the AudioServer automatically after it boots with the updated project.</span>
            </div>
          </li>
        </ol>
      `;
  const pairingHeaderTitle = audioserver.paired ? 'Pairing completed 🎉' : 'Pairing setup';
  const pairingHeaderSubtitle = audioserver.paired
    ? 'Follow these steps to complete the configuration.'
    : 'The Miniserver will initiate pairing automatically after rebooting with your updated project.';
  return `
    <article class="miniserver-card pairing-info">
      <header>
        <h3>${pairingHeaderTitle}</h3>
        <p>${pairingHeaderSubtitle}</p>
      </header>
      ${pairingHelp}
    </article>
  `;
}

export function renderPairingBadge(audioserver = {}

export function renderPairingWaitIndicator() {
  if (!state.waitingForPairing) return '';
  return `
    <div class="connection-wait" role="status" aria-live="polite">
      <span class="connection-wait__pulse" aria-hidden="true"></span>
      <span class="connection-wait__text">Waiting for the Miniserver to initiate pairing…</span>
    </div>
  `;
}

export function renderUpdatePanel() {
  const version = typeof state.version === 'string' && state.version ? state.version : 'Unknown';
  return `
    <section class="updates-panel">
      <header class="updates-panel__header">
        <h2>Update</h2>
        <p class="updates-panel__subtitle">Check the currently installed lox-audioserver version.</p>
      </header>
      <div class="updates-panel__body">
        <dl class="updates-panel__meta">
          <div>
            <dt>Current version</dt>
            <dd>${escapeHtml(version)}</dd>
          </div>
        </dl>
      </div>
    </section>
  `;
}

export function renderMiniserverBadge(config = {}

export function renderZonesPanel({ zones, mediaProvider }

export function renderZoneGroup(group, index = 0, stretch = false) {
  if (!group) return '';
  const { label = 'Unknown source', zones = [] } = group;
  const realZoneCount = zones.filter((zone) => !zone || zone.placeholder !== 'extension').length;
  const groupCount = realZoneCount;
  const countLabel = `${groupCount} ${groupCount === 1 ? 'zone' : 'zones'}`;
  const safeLabel = escapeHtml(label);
  const safeCount = escapeHtml(countLabel);
  const groupKey = typeof group.key === 'string' && group.key ? group.key : `group-${index}`;
  const groupId = `zone-group-${groupKey.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || index}`;
  const isExtensionGroup = isExtensionLabel(label);
  const isAudioServerGroup = isAudioServerLabel(label);
  const classes = ['zone-group'];
  if (isExtensionGroup) classes.push('zone-group--extension');
  if (isAudioServerGroup) classes.push('zone-group--audioserver');
  if (stretch) classes.push('zone-group--stretch');
  const groupClass = classes.join(' ');
  const groupSerial = resolveSourceSerial(label);
  const serialLine = groupSerial ? `<span class="zone-group-serial">Serial ${escapeHtml(groupSerial)}</span>` : '';
  const cards = zones.map((zone) => renderZoneCard(zone)).join('');

  return `
    <section class="${groupClass}" aria-labelledby="${groupId}">
      <header class="zone-group-header">
        <div class="zone-group-heading">
          <h3 class="zone-group-title" id="${groupId}">${safeLabel}</h3>
          ${serialLine}
        </div>
        <span class="zone-group-count">${safeCount}</span>
      </header>
      <div class="zones">
        ${cards}
      </div>
    </section>
  `;
}

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

export function renderExtensionPlaceholderCard(placeholder) {
  const index = Number(placeholder?.index) || 0;
  const label = placeholder?.label || (index ? `Stereo Extension ${index}` : 'New Extension');
  const serial = typeof placeholder?.serial === 'string' && placeholder.serial ? placeholder.serial.toUpperCase() : '';
  const safeLabel = escapeHtml(label);
  const safeSerial = serial ? escapeHtml(serial) : '—';

  const macSerial = safeSerial.replace(/(..)(?=.)/g, '$1:');
  const safeSerialMac = escapeHtml(macSerial);
  return `
    <article class="zone-card zone-card--placeholder">
      <header class="zone-card-header zone-card-placeholder-header">
        <div class="zone-card-heading">
          <span class="zone-card-placeholder-status">Awaiting MiniServer configuration</span>
        </div>
      </header>
      <div class="zone-card-placeholder-body">
        <p>Use the serial ${safeSerialMac} when creating the extension in Loxone Config.</p>
      </div>
    </article>
  `;
}

export function renderAddExtensionControls(extensionStats) {
  if (!extensionStats) return '';
  const totalCount = Number(extensionStats.totalCount) || 0;
  const highestIndex = Number(extensionStats.highestIndex) || 0;
  const remaining = Math.max(0, MAX_EXTENSION_COUNT - totalCount);
  const nextIndex = highestIndex + 1;
  const canAdd = remaining > 0 && nextIndex <= MAX_EXTENSION_COUNT;
  const buttonDisabledAttr = canAdd ? '' : 'disabled';

  return `
    <div class="zone-add-extension">
      <button type="button" id="add-extension" class="secondary" ${buttonDisabledAttr}>Add Extension</button>
    </div>
  `;
}

export function renderZonesMetricIcon(name) {
  switch (name) {
    case 'active-adapters':
      return `
        <svg viewBox="0 0 24 24" role="presentation" aria-hidden="true">
          <path d="M5 5h4v4H5zM10 10h4v4h-4zM15 5h4v4h-4zM15 15h4v4h-4zM5 15h4v4H5zM10 5h4v4h-4z" fill="currentColor"></path>
        </svg>
      `;
    case 'total':
    default:
      return `
        <svg viewBox="0 0 24 24" role="presentation" aria-hidden="true">
          <path d="M4 5h16v3H4zM4 10h16v3H4zM4 15h16v3H4z" fill="currentColor"></path>
        </svg>
      `;
  }
}

export function renderZonesOverview(stats) {
  if (!stats) return '';
  const coreZones = stats.core ?? 0;
  const extensionZones = stats.extension ?? 0;
  const metrics = [
    {
      id: 'total',
      label: 'Total zones',
      value: stats.total,
      tone: 'primary',
      note: stats.total
        ? `${stats.coreTotal} AudioServer · ${stats.extensionTotal} Extension`
        : 'Add zones to begin',
      icon: renderZonesMetricIcon('total'),
    },
    {
      id: 'active-adapters',
      label: 'Active adapters',
      value: stats.activeAdapters,
      tone: stats.activeAdapters ? 'success' : 'neutral',
      note: stats.activeAdapters
        ? `${stats.activeAdapters === 1 ? 'Adapter online' : 'Adapters online'}`
        : 'Assign an adapter to enable playback',
      icon: renderZonesMetricIcon('active-adapters'),
    },
  ];

  return `
    <div class="zones-overview">
      <ul class="zones-metrics" role="list">
        ${metrics
          .map((metric) => `
            <li class="zones-metric zones-metric--${metric.tone}">
              <div class="zones-metric-icon" aria-hidden="true">${metric.icon}</div>
              <div class="zones-metric-content">
                <span class="zones-metric-label">${escapeHtml(metric.label)}</span>
                <span class="zones-metric-value">${escapeHtml(String(metric.value))}</span>
                <span class="zones-metric-note">${escapeHtml(metric.note)}</span>
              </div>
            </li>
          `)
          .join('')}
      </ul>
    </div>
  `;
}

export function renderProviderContent(mediaProvider = {}

export function renderProviderField(field, parameters, discoveryState = {}

export function renderZoneMetadata(status = {}

export function renderAdapterModal() {
  const modalState = state.modal || {};
  const open = Boolean(modalState.open && typeof modalState.zoneId === 'number');
  if (typeof document !== 'undefined') {
    document.body.classList.toggle('modal-open', open);
  }
  if (!open) {
    return '<div id="adapter-modal" class="adapter-modal adapter-modal--hidden" aria-hidden="true"></div>';
  }

  const zone = state.config?.zones.find((z) => z.id === modalState.zoneId);
  if (!zone) {
    if (typeof document !== 'undefined') document.body.classList.remove('modal-open');
    resetModalState();
    return '<div id="adapter-modal" class="adapter-modal adapter-modal--hidden" aria-hidden="true"></div>';
  }

  const adapterOptions = getAdapterOptions();
  const currentAdapter = getZoneAdapter(zone);
  const selectedAdapterType = modalState.adapterType || currentAdapter.type || adapterOptions[0]?.id || 'null';
  const normalizedAdapterType = normalizeAdapterType(selectedAdapterType);
  const adapterFields = getAdapterFields(normalizedAdapterType);
  const adapterMeta = findAdapterMeta(normalizedAdapterType);
  const parameters = {
    ...normalizeAdapterParametersOutput(currentAdapter.parameters || {}),
    ...(modalState.parameters || {}),
  };

  updateModalState({
    adapterType: normalizedAdapterType,
    parameters,
  });

  const modalError = typeof modalState.error === 'string' ? modalState.error.trim() : '';
  const zoneDisplayName = (zone.name ?? '').trim();
  const summaryZoneName = zoneDisplayName || `Zone ${zone.id}`;

  const adapterOptionsValues = adapterOptions.map((option) => {
    const value = option.id ?? option.type ?? '';
    const label = option.label ?? formatAdapterLabel(value);
    return { value, label };
  });
  const adapterSelect = renderSelect(
    'adapter-type',
    'Adapter',
    adapterOptionsValues,
    normalizedAdapterType,
    'class="adapter-modal__select"'
  );

  const discoveryState = modalState.discovery || {};
  const fieldsHtml = adapterFields
    .map((field) => renderAdapterField(field, parameters, discoveryState[field.id]))
    .join('');

  const supportsContentPlayback = adapterSupportsContentPlayback(normalizedAdapterType);
  const allContentPlayers = getContentPlayerOptions();
  const activeProviderTypeId = normalizeProviderType(state.config.mediaProvider?.type || '');
  const hasActiveProvider = Boolean(activeProviderTypeId && activeProviderTypeId !== 'dummy');
  const compatibleContentPlayers = hasActiveProvider ? allContentPlayers.filter((player) => {
    const providerType = normalizeProviderType(player.providerType || player.baseType || '');
    return providerType && providerType === activeProviderTypeId;
  }) : [];
  const beolinkContentOptions = compatibleContentPlayers.filter((player) => normalizeAdapterType(player.adapterType || player.id || '') === 'musicassistant');
  const shouldRestrictContentAdapter = normalizedAdapterType === 'beolink';
  let contentAdapterHost = typeof modalState.contentAdapterHost === 'string' ? modalState.contentAdapterHost : '';
  if (!contentAdapterHost) {
    contentAdapterHost = shouldRestrictContentAdapter
      ? resolveMusicAssistantHost(null)
      : resolveMusicAssistantHost(zone);
    if (contentAdapterHost) {
      updateModalState({ contentAdapterHost });
    }
  }
  const cachedContentPlayers = Array.isArray(modalState.contentAdapterPlayers)
    ? modalState.contentAdapterPlayers
    : [];
  const contentPlayersLoading = Boolean(modalState.contentAdapterPlayersLoading);
  const contentPlayersError = typeof modalState.contentAdapterPlayersError === 'string'
    ? modalState.contentAdapterPlayersError.trim()
    : '';

  const selectedContentAdapter = modalState.contentAdapter || zone.contentAdapter?.id || '';
  const contentAdapterPlayerId = modalState.contentAdapterPlayerId || zone.contentAdapter?.playerId || '';
  let contentAdapterHtml = '';
  if (!supportsContentPlayback && compatibleContentPlayers.length) {
    const availableContentPlayers = shouldRestrictContentAdapter ? beolinkContentOptions : compatibleContentPlayers;
    const normalizedSelectedContentAdapter = shouldRestrictContentAdapter ? (beolinkContentOptions.length ? (modalState.contentAdapter || zone.contentAdapter?.id || beolinkContentOptions[0].id) : '') : selectedContentAdapter;
    if (shouldRestrictContentAdapter && modalState.contentAdapter !== normalizedSelectedContentAdapter) {
      updateModalState({
        contentAdapter: normalizedSelectedContentAdapter,
        contentAdapterPlayerId: '',
      });
    }
    const contentOptions = [
      { value: '', label: 'None' },
      ...availableContentPlayers.map((player) => ({ value: player.id, label: player.label })),
    ];
    const contentSelect = renderSelect(
      'adapter-content',
      'Content Player',
      contentOptions,
      normalizedSelectedContentAdapter,
      'class="adapter-modal__select"'
    );
    const selectedContent = availableContentPlayers.find((player) => player.id === normalizedSelectedContentAdapter);
    const description = selectedContent?.description
      ? `<p class="adapter-modal__hint">${escapeHtml(selectedContent.description)}</p>`
      : '<p class="adapter-modal__hint">Optional: choose a content player to handle library playback for this adapter.</p>';

    let contentPlayerField = '';
    if (selectedContent?.requiresPlayerId) {
      const playerOptions = [
        { value: '', label: 'Select a player' },
        ...cachedContentPlayers.map((player) => ({ value: player.id, label: `${player.name} (${player.id})` })),
      ];
      const hasPlayers = cachedContentPlayers.length > 0;
      const resolvedProviderHost = resolveMusicAssistantHost(null);
      const scanHost = shouldRestrictContentAdapter ? resolvedProviderHost : contentAdapterHost;
      const hostHint = scanHost
        ? ''
        : '<p class="adapter-modal__hint">Set the Music Assistant host in the adapter or provider before scanning.</p>';
      const scanDisabledAttr = scanHost && !contentPlayersLoading ? '' : 'disabled aria-disabled="true"';
      const scanLabel = contentPlayersLoading ? 'Scanning…' : (hasPlayers ? 'Rescan players' : 'Scan players');
      const selectAttrs = [
        'class="adapter-modal__select"',
        contentPlayersLoading ? 'disabled aria-disabled="true"' : '',
      ].filter(Boolean).join(' ');
      const selectHtml = renderSelect(
        'adapter-content-player',
        'Music Assistant Player',
        playerOptions,
        contentAdapterPlayerId,
        selectAttrs
      );
      contentPlayerField = `
        <div class="adapter-modal__content-player">
          ${selectHtml}
          <div class="adapter-modal__ma-actions">
            <button type="button" class="tertiary" data-action="adapter-content-scan" data-host="${escapeHtml(scanHost || '')}" ${scanDisabledAttr}>${scanLabel}</button>
          </div>
          ${contentPlayersError ? `<p class="adapter-modal__content-player-error">${escapeHtml(contentPlayersError)}</p>` : ''}
          ${!hasPlayers && contentAdapterHost && !contentPlayersLoading ? '<p class="adapter-modal__hint">No players cached for this host yet. Scan to discover available players.</p>' : ''}
          ${hostHint}
        </div>
      `;
    }

    contentAdapterHtml = `
      <div class="adapter-modal__content">
        ${contentSelect}
        ${description}
        ${contentPlayerField}
      </div>
    `;
  } else if (!supportsContentPlayback && allContentPlayers.length && !compatibleContentPlayers.length) {
    contentAdapterHtml = '<p class="adapter-modal__hint">Configure a compatible media provider to enable content playback selection.</p>';
  }

  const adapterDescription = adapterMeta?.description || '';
  const summaryDescription = adapterDescription
    ? adapterDescription
    : 'Select an adapter to see configuration details and requirements.';

  return `
    <div id="adapter-modal" class="adapter-modal" role="dialog" aria-modal="true" aria-labelledby="adapter-modal-title">
      <div class="adapter-modal__backdrop" data-modal-close="true"></div>
      <div class="adapter-modal__dialog">
        <header class="adapter-modal__header">
          <div>
            <h2 id="adapter-modal-title">Configure ${escapeHtml(summaryZoneName)}</h2>
            <p class="adapter-modal__subtitle">Adjust adapter settings and connection details.</p>
          </div>
          <button type="button" class="adapter-modal__close" data-modal-close="true" aria-label="Close">×</button>
        </header>
        <div class="adapter-modal__body">
          <div class="adapter-modal__layout">
            <aside class="adapter-modal__summary">
              <h3 class="adapter-modal__summary-title">${escapeHtml(formatAdapterLabel(normalizedAdapterType))}</h3>
              <p class="adapter-modal__summary-text">${escapeHtml(summaryDescription)}</p>
              <div class="adapter-modal__summary-zone">
                <span class="adapter-modal__summary-label">Zone</span>
                <span class="adapter-modal__summary-value">${escapeHtml(summaryZoneName)}</span>
                <span class="adapter-modal__summary-meta">ID ${escapeHtml(String(zone.id))}</span>
              </div>
            </aside>
            <div class="adapter-modal__form">
              ${adapterSelect}
              <div class="adapter-modal__fields" data-adapter-fields="true">
                ${fieldsHtml}
              </div>
              ${contentAdapterHtml}
            </div>
          </div>
          ${modalError ? `<div class="adapter-modal__error" role="alert">${escapeHtml(modalError)}</div>` : ''}
        </div>
        <footer class="adapter-modal__footer">
          <button type="button" class="primary" id="adapter-modal-save">Save</button>
          <button type="button" class="secondary" data-modal-close="true">Cancel</button>
        </footer>
      </div>
    </div>
  `;
}

export function renderAdapterField(field, parameters, discoveryState = {}