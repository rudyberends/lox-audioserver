export function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInput(id, label, value, type = 'text', inline = false, extraAttrs = '') {
  const escapedValue = escapeHtml(value);
  const baseInput = `<input id="${id}" type="${type}" value="${escapedValue}" ${extraAttrs} />`;
  if (inline) {
    return `
      <label for="${id}" class="inline-control">
        <span>${label}</span>
        ${baseInput}
      </label>
    `;
  }
  return `
    <div class="form-control">
      <label for="${id}">${label}</label>
      ${baseInput}
    </div>
  `;
}

export function renderSelect(id, label, values, selectedValue = '', extraAttrs = '') {
  const options = (values || []).map((value) => {
    if (typeof value === 'object' && value !== null) {
      const optionValue = escapeHtml(value.value ?? '');
      const optionLabelRaw = value.label ?? value.value ?? '';
      const optionLabel = escapeHtml(optionLabelRaw);
      const isSelected = value.value === selectedValue;
      return `<option value="${optionValue}" ${isSelected ? 'selected' : ''}>${optionLabel}</option>`;
    }
    const optionValueRaw = value ?? '';
    const optionValue = escapeHtml(optionValueRaw);
    const optionLabel = escapeHtml(optionValueRaw || 'None');
    const isSelected = optionValueRaw === selectedValue;
    return `<option value="${optionValue}" ${isSelected ? 'selected' : ''}>${optionLabel}</option>`;
  }).join('');

  return `
    <div class="form-control">
      <label for="${id}">${label}</label>
      <select id="${id}" ${extraAttrs}>${options}</select>
    </div>
  `;
}

