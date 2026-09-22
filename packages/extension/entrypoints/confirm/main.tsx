import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app';
import { AppProviders } from '@/components/app-providers';
import '@/assets/tailwind.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </React.StrictMode>,
);
