import React from 'react';
import { Link } from 'react-router-dom';
import Shell from '../components/Shell';

export default function NotFoundPage() {
  return (
    <Shell title="404">
      <div className="max-w-md mx-auto px-6 py-16 text-center">
        <div className="text-[40px] font-semibold text-muted">404</div>
        <p className="text-[12px] text-muted mt-2">No route here.</p>
        <Link to="/" className="text-accent text-[12px] mt-4 inline-block">Back to home</Link>
      </div>
    </Shell>
  );
}
