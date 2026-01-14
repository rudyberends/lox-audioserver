import React from 'react';
import './InsightView.css';
import AudioView from './AudioView';
import LogsView from './LogsView';

type InsightTab = 'audio' | 'logs';
const INSIGHT_TABS: InsightTab[] = ['audio', 'logs'];
const STORAGE_KEY = 'lox.admin.insightTab';

export default function InsightView(): JSX.Element {
  const [tab, setTab] = React.useState<InsightTab>(() => {
    if (typeof window === 'undefined') return 'audio';
    const stored = window.localStorage.getItem(STORAGE_KEY) as InsightTab | null;
    return stored && INSIGHT_TABS.includes(stored) ? stored : 'audio';
  });

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, tab);
  }, [tab]);

  return (
    <div className="insight-layout">
      <div className="insight-hero">
        <div className="insight-hero__copy">
          <p className="page-hero__eyebrow">AudioServer insight</p>
          <h1 className="page-hero__title">Insight</h1>
          <p className="page-hero__subtitle">
            Monitor audio health and review logs without leaving the admin.
          </p>
        </div>
      </div>
      <div className="insight-filter-bar" role="tablist" aria-label="Insight sections">
        {INSIGHT_TABS.map((key) => (
          <button
            key={key}
            type="button"
            className={`insight-filter-chip${tab === key ? ' is-active' : ''}`}
            onClick={() => setTab(key)}
            role="tab"
            aria-selected={tab === key}
          >
            {key === 'audio' ? 'Audio' : 'Logs'}
          </button>
        ))}
      </div>
      {tab === 'audio' ? <AudioView /> : <LogsView />}
    </div>
  );
}
