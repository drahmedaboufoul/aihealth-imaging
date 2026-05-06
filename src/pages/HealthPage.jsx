import React from 'react';

export default function HealthPage() {
  return (
    <pre style={{ margin: 0, padding: 16, fontFamily: 'monospace', color: '#1D9E75' }}>
{JSON.stringify({ status: 'ok', service: 'aihealth-imaging', phase: 1 }, null, 2)}
    </pre>
  );
}
