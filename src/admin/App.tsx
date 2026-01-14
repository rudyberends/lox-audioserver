import React from 'react';
import Hero from './components/Hero';
import Tabs from './components/Tabs';
import SectionCard from './components/SectionCard';
import SetupView from './features/SetupView';
import ContentView from './features/ContentView';
import ZonesView from './features/ZonesView';
import AudioView from './features/AudioView';
import LogsView from './features/LogsView';
import { GlobalAlertProvider } from './components/GlobalAlert';

const TAB_ORDER = ['setup', 'content', 'zones', 'audio', 'logs'] as const;
type TabKey = (typeof TAB_ORDER)[number];
const TAB_STORAGE_KEY = 'lox.admin.activeTab';

export function App(): JSX.Element {
  const [tab, setTab] = React.useState<TabKey>(() => {
    if (typeof window === 'undefined') {
      return 'setup';
    }
    const stored = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (stored && TAB_ORDER.includes(stored as TabKey)) {
      return stored as TabKey;
    }
    return 'setup';
  });
  const [tabPulse, setTabPulse] = React.useState(false);

  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(TAB_STORAGE_KEY, tab);
    }
  }, [tab]);

  const handleTabChange = React.useCallback(
    (next: TabKey) => {
      if (next === tab) return;
      setTab(next);
      setTabPulse((prev) => !prev);
    },
    [tab],
  );

  let content: JSX.Element | null = null;
  if (tab === 'setup') content = <SetupView />;
  if (tab === 'content') content = <ContentView />;
  if (tab === 'zones') content = <ZonesView />;
  if (tab === 'audio') content = <AudioView />;
  if (tab === 'logs') content = <LogsView />;

  return (
    <GlobalAlertProvider>
      <header className="hero">
        <Hero />
        <Tabs active={tab} tabs={TAB_ORDER} onChange={handleTabChange} />
      </header>

      <main id="app">
        <div className="tab-shell">
          <div
            className={`tab-shell__inner ${tabPulse ? 'tab-shell__inner--pulse-a' : 'tab-shell__inner--pulse-b'}`}
          >
            {content}
          </div>
        </div>
      </main>
    </GlobalAlertProvider>
  );
}
