// @ts-nocheck
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


