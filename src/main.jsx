import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      {/* App-level toast host (W1) — the CBCT viewer's dialogs/actions
          report through sonner instead of native alert()/confirm(). */}
      <Toaster theme="dark" position="top-right" richColors closeButton />
    </BrowserRouter>
  </React.StrictMode>,
);
