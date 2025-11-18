// @ts-nocheck
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



