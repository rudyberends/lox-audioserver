// @ts-nocheck
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


