// @ts-nocheck
export function renderPairingWaitIndicator() {
  if (!state.waitingForPairing) return '';
  return `
    <div class="connection-wait" role="status" aria-live="polite">
      <span class="connection-wait__pulse" aria-hidden="true"></span>
      <span class="connection-wait__text">Waiting for the Miniserver to initiate pairing…</span>
    </div>
  `;
}


