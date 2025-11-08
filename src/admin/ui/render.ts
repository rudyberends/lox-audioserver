// @ts-nocheck
export function render() {
  if (!state.config) return;

  let focusSnapshot = null;
  if (typeof document !== 'undefined') {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      const activeId = activeElement.id;
      if (activeId && FOCUS_PRESERVE_IDS.has(activeId)) {
        let selectionStart = null;
        let selectionEnd = null;
        let selectionDirection = null;
        if ('selectionStart' in activeElement && 'selectionEnd' in activeElement) {
          try {
            selectionStart = activeElement.selectionStart;
            selectionEnd = activeElement.selectionEnd;
            selectionDirection = activeElement.selectionDirection || null;
          } catch (error) {
            selectionStart = null;
            selectionEnd = null;
            selectionDirection = null;
          }
        }
        focusSnapshot = { id: activeId, selectionStart, selectionEnd, selectionDirection };
      }
    }
  }

  if (Array.isArray(state.config.zones)) {
    state.config.zones.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }

  const panelsHtml = renderPanels(state.config);
  const modalHtml = renderAdapterModal();
  app.innerHTML = panelsHtml + modalHtml;
  bindFormEvents();
  updateTabs();
  updateHeroSummary();
  maybeLoadLogs();

  if (focusSnapshot && typeof document !== 'undefined') {
    const nextElement = document.getElementById(focusSnapshot.id);
    if (nextElement instanceof HTMLElement) {
      try {
        if (typeof nextElement.focus === 'function') {
          nextElement.focus({ preventScroll: true });
        }
      } catch {
        try {
          nextElement.focus();
        } catch {
          // Ignore focus errors
        }
      }
      if (
        focusSnapshot.selectionStart !== null &&
        focusSnapshot.selectionEnd !== null &&
        'setSelectionRange' in nextElement
      ) {
        try {
          nextElement.setSelectionRange(
            focusSnapshot.selectionStart,
            focusSnapshot.selectionEnd,
            focusSnapshot.selectionDirection ?? 'none',
          );
        } catch {
          // Ignore selection errors
        }
      }
    }
  }
}


