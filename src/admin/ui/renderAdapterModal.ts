// @ts-nocheck
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


