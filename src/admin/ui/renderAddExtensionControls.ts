// @ts-nocheck
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


