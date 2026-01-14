import React from 'react';
import './Tabs.css';

type TabKey = string;

interface TabsProps {
  active: TabKey;
  tabs: readonly TabKey[];
  onChange(tab: TabKey): void;
}

export default function Tabs({ active, tabs, onChange }: TabsProps): JSX.Element {
  return (
    <nav className="tabs" aria-label="Admin navigation">
      <ul>
        {tabs.map((tab) => (
          <li key={tab}>
            <button
              type="button"
              className={active === tab ? 'active' : ''}
              onClick={() => onChange(tab)}
            >
              <span className="tabs__label">{formatLabel(tab)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function formatLabel(value: string): string {
  if (!value) return '';
  if (value === 'insight') return 'Insight';
  return value.charAt(0).toUpperCase() + value.slice(1);
}
