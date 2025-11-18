// @ts-nocheck
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


