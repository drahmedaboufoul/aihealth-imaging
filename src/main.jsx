import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import ViewerNotConfigured from './components/ViewerNotConfigured';
import { missingClientEnv } from './lib/config';
import './index.css';

const root = ReactDOM.createRoot(document.getElementById('root'));
const missing = missingClientEnv();

if (missing.length > 0) {
  // App (and lib/supabase) is never imported, so its fail-closed startup
  // check cannot leave a white page. Names only — values are never logged.
  console.error(`[config] viewer not configured; missing: ${missing.join(', ')}`);
  root.render(<ViewerNotConfigured />);
} else {
  import('./App').then(({ default: App }) => {
    root.render(
      <React.StrictMode>
        <BrowserRouter>
          <App />
          {/* App-level toast host (W1) — the CBCT viewer's dialogs/actions
              report through sonner instead of native alert()/confirm(). */}
          <Toaster theme="dark" position="top-right" richColors closeButton />
        </BrowserRouter>
      </React.StrictMode>,
    );
  });
}
