// @ts-nocheck
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


