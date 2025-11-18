// @ts-nocheck
// extracted top-level event handlers and initializers

export const handler = () => {
        if (element.type === 'checkbox') {
          setProviderOption(fieldId, element.checked);
        } else {
          setProviderOption(fieldId, element.value);
        }
      };
      

export function handleAddExtensionClick(event) {
  if (event && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }
  const zones = Array.isArray(state.config?.zones) ? [...state.config.zones] : [];
  zones.sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0));
  const groupedZones = groupZonesBySource(zones);
  const extensionStats = deriveExtensionStats(groupedZones, state.extensionPlaceholders || []);
  state.extensionPlaceholders = extensionStats.placeholders;

  if (extensionStats.totalCount >= MAX_EXTENSION_COUNT || extensionStats.highestIndex >= MAX_EXTENSION_COUNT) {
    setStatus(`Maximum of ${MAX_EXTENSION_COUNT} extensions reached.`, true);
    render();
    return;
  }

  const nextIndex = extensionStats.highestIndex + 1;
  if (nextIndex > MAX_EXTENSION_COUNT) {
    setStatus(`Maximum of ${MAX_EXTENSION_COUNT} extensions reached.`, true);
    render();
    return;
  }

  const serial = computeExtensionSerial(nextIndex);
  const label = `Stereo Extension ${nextIndex}`;
  state.extensionPlaceholders = [
    ...state.extensionPlaceholders,
    {
      index: nextIndex,
      serial,
      label,
    },
  ];

  setStatus(`Placeholder added for ${label}. Use serial ${serial} in your MiniServer project.`);
  render();
}


