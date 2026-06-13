import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { initI18n } from './i18n';
import './index.css';

// Initialize i18n BEFORE the agent module resolves its discovery message + the
// first render reads translations.
initI18n();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
