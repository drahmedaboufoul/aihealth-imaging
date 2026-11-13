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
  // App, AuthProvider and i18n (and through them lib/supabase) are never
  // imported, so the fail-closed startup check cannot leave a white page.
  // Names only — values are never logged.
  console.error(`[config] viewer not configured; missing: ${missing.join(', ')}`);
  root.render(<ViewerNotConfigured />);
} else {
  Promise.all([
    import('./App'),
    import('./contexts/AuthContext'),
    import('./i18n'),
  ]).then(([{ default: App }, { AuthProvider }]) => {
    root.render(
      <React.StrictMode>
        <BrowserRouter>
          {/* Signed-in user for the kyour viewer components (useAuth). */}
          <AuthProvider>
            <App />
          </AuthProvider>
          {/* App-level toast host (W1) — the CBCT viewer's dialogs/actions
              report through sonner instead of native alert()/confirm(). */}
          <Toaster theme="dark" position="top-right" richColors closeButton />
        </BrowserRouter>
      </React.StrictMode>,
    );
  });
}
