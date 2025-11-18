// @ts-nocheck
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


