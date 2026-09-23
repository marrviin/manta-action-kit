import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app';
import { AppProviders } from '@/components/app-providers';
import { screenshotMode } from '@/lib/storage';
import '@/assets/tailwind.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);

// Read the persisted screenshot mode BEFORE mounting so the popup's first
// frame already shows the saved Segmented choice (no fallback→stored flicker).
// A local-storage read costs ~1ms — imperceptible on popup open.
void (async () => {
  const initialScreenshotMode = await screenshotMode.getValue();
  root.render(
    <React.StrictMode>
      <AppProviders>
        <App initialScreenshotMode={initialScreenshotMode} />
      </AppProviders>
    </React.StrictMode>,
  );
})();
