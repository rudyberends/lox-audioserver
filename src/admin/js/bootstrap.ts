// @ts-nocheck
export function setupTabs() {
  if (!tabsNav) return;
  tabsNav.addEventListener('click', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const button = target?.closest('.tab');
    if (!(button instanceof HTMLElement)) return;
    const tabId = button.dataset.tab;
    if (!tabId || tabId === state.activeTab) return;
    state.activeTab = tabId;
    render();
  });
}