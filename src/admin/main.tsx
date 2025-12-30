import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './components/Hero.css';
import './components/Tabs.css';
import './components/SectionCard.css';

/**
 * Bootstraps the lightweight admin SPA used for future management features.
 */
const root = document.getElementById('root');

if (!root) {
  throw new Error('Unable to find admin root element');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
