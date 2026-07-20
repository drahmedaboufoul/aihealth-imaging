/*
 * Page shell — dark workspace look. The viewer apps live edge-to-edge,
 * so this is intentionally thin. Use only for non-viewer surfaces (404, health).
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Activity } from 'lucide-react';

export default function Shell({ children, title }) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="h-12 border-b border-border flex items-center px-4 gap-4 bg-panel">
        <Link to="/" className="flex items-center gap-2 text-text">
          <Activity size={16} className="text-accent" />
          <span className="font-semibold tracking-tight text-[13px]">aiHealth Imaging</span>
          <span className="text-muted text-xs uppercase tracking-[0.1em]">Preview</span>
        </Link>
        {title && (
          <>
            <span className="text-muted">·</span>
            <span className="text-[13px] text-muted">{title}</span>
          </>
        )}
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
