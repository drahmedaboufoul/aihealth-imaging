/*
 * M0 safety: outward pages, build-time AI / rooms flags, config screen and
 * error sanitizing. Server-rendered with react-dom/server (node env, no DOM).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { safeErrorMessage, GENERIC_ERROR_MESSAGE } from '../src/lib/safeError';
import { missingClientEnv, REQUIRED_CLIENT_ENV } from '../src/lib/config';
import { shareDownloadName } from '../src/lib/sharePayload';
import ViewerNotConfigured from '../src/components/ViewerNotConfigured';
import { SharedSessionHeader, ShareErrorPanel } from '../src/pages/SharedViewerPage';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const URL_TEXT_RE = /https?:\/\/|www\./i;
const STUDY_UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

/** Visible text only (attributes dropped). */
const textOf = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('build-time feature flags default OFF', () => {
  async function flags(env = {}) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return import('../src/lib/featureFlags');
  }

  it('hides outside-AI reads and viewer rooms when the variables are unset', async () => {
    const f = await flags();
    expect(f.ENABLE_THIRD_PARTY_AI).toBe(false);
    expect(f.ENABLE_VIEWER_ROOMS).toBe(false);
    expect(f.canShowThirdPartyAi({ readOnly: false, hasStudy: true })).toBe(false);
  });

  it.each(['', 'false', 'TRUE', '1', 'yes'])('stays off for %j', async (value) => {
    const f = await flags({ VITE_ENABLE_THIRD_PARTY_AI: value, VITE_ENABLE_VIEWER_ROOMS: value });
    expect(f.ENABLE_THIRD_PARTY_AI).toBe(false);
    expect(f.ENABLE_VIEWER_ROOMS).toBe(false);
  });

  it('opts in only with "true", and never for read-only or study-less sessions', async () => {
    const f = await flags({ VITE_ENABLE_THIRD_PARTY_AI: 'true', VITE_ENABLE_VIEWER_ROOMS: 'true' });
    expect(f.ENABLE_VIEWER_ROOMS).toBe(true);
    expect(f.canShowThirdPartyAi({ readOnly: false, hasStudy: true })).toBe(true);
    expect(f.canShowThirdPartyAi({ readOnly: true, hasStudy: true })).toBe(false);
    expect(f.canShowThirdPartyAi({ readOnly: false, hasStudy: false })).toBe(false);
  });
});

describe('CBCT AI tab follows the flag', () => {
  async function tabLabels(props) {
    const { default: ToolRail } = await import('../src/components/cbct/ToolRail');
    const html = renderToStaticMarkup(
      <ToolRail viewMode="mpr-3d" presetTable={[]} annotations={[]} implants={[]} nervePoints={[]} {...props} />,
    );
    return [...html.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map((m) => textOf(m[1]));
  }

  it('renders no AI tab when outside AI is off (default)', async () => {
    expect(await tabLabels({ readOnly: false })).not.toContain('AI');
    expect(await tabLabels({ readOnly: false, showAiTab: false })).not.toContain('AI');
  });

  it('renders the AI tab only for a writable session with the flag on', async () => {
    expect(await tabLabels({ readOnly: false, showAiTab: true })).toContain('AI');
    expect(await tabLabels({ readOnly: true, showAiTab: true })).not.toContain('AI');
  });
});

describe('viewer configuration', () => {
  it('reports missing client variables by name', () => {
    expect(missingClientEnv({})).toEqual([...REQUIRED_CLIENT_ENV]);
    expect(missingClientEnv({ VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_ANON_KEY: '  ' }))
      .toEqual(['VITE_SUPABASE_ANON_KEY']);
    expect(missingClientEnv({ VITE_SUPABASE_URL: 'x', VITE_SUPABASE_ANON_KEY: 'y' })).toEqual([]);
  });

  it('renders a friendly "Viewer not configured" screen instead of a blank page', () => {
    const text = textOf(renderToStaticMarkup(<ViewerNotConfigured />));
    expect(text).toContain('Viewer not configured');
    expect(text.length).toBeGreaterThan(40);
    for (const name of REQUIRED_CLIENT_ENV) expect(text).not.toContain(name);
    expect(text).not.toMatch(URL_TEXT_RE);
  });

  it('boots the not-configured screen without importing the app (main.jsx)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^import App/m);
    expect(src).toMatch(/missingClientEnv\(\)/);
    expect(src).toMatch(/<ViewerNotConfigured \/>/);
    expect(src).toMatch(/import\('\.\/App'\)/);
  });
});

describe('shared page renders no ids, URLs or patient identity', () => {
  // A legacy / misbehaving payload that still carries everything we stopped sending.
  const payload = {
    study: {
      id: STUDY_UUID, study_type: 'cbct', study_date: '2026-07-01',
      patient_name: 'Synthetic Example', description: 'Synthetic Example CBCT',
    },
    niftiUrl: `https://project.supabase.co/storage/v1/object/sign/imaging-derived/${STUDY_UUID}/vol.nii.gz?token=abc`,
    permission: 'export',
    expires_at: new Date(Date.now() + 3 * 86400000).toISOString(),
    invited_email: 'recipient@example.test',
  };

  it('header shows modality, date and expiry only', () => {
    const html = renderToStaticMarkup(<SharedSessionHeader payload={payload} />);
    const text = textOf(html);
    expect(text).toContain('cbct');
    expect(text).not.toMatch(UUID_RE);
    expect(text).not.toMatch(URL_TEXT_RE);
    expect(text).not.toContain('Synthetic Example');
    expect(text).not.toContain('@');
  });

  it('exports with a neutral scan-YYYY-MM-DD filename', () => {
    const html = renderToStaticMarkup(<SharedSessionHeader payload={payload} />);
    expect(html).toContain('download="scan-2026-07-01.nii.gz"');
    expect(html.match(/download="([^"]*)"/)[1]).not.toMatch(UUID_RE);
    expect(shareDownloadName(undefined)).toBe('scan.nii.gz');
    expect(shareDownloadName('2026-07-01T10:00:00Z')).toBe('scan-2026-07-01.nii.gz');
  });

  it('error panel sanitizes ids, URLs and backend text', () => {
    const raw = `Invite ${STUDY_UUID} failed at https://project.supabase.co/rest/v1/imaging_share_invites`;
    const text = textOf(renderToStaticMarkup(<ShareErrorPanel message={raw} />));
    expect(text).not.toMatch(UUID_RE);
    expect(text).not.toMatch(URL_TEXT_RE);
    expect(text).toContain('Link can&#x27;t be opened');
    expect(text).toContain('The link may be expired');
  });

  it('keeps the resolver\'s own short reasons readable', () => {
    const text = textOf(renderToStaticMarkup(<ShareErrorPanel message="Invite expired" />));
    expect(text).toContain('Invite expired');
  });
});

describe('safeErrorMessage', () => {
  it('redacts URLs, UUIDs, emails, paths and id parameters', () => {
    const out = safeErrorMessage(new Error(
      `No file for id=${STUDY_UUID} at clinic/abc/scan.dcm via https://x.example/a?b=c for dr@example.test`,
    ));
    expect(out).not.toMatch(UUID_RE);
    expect(out).not.toMatch(URL_TEXT_RE);
    expect(out).not.toContain('scan.dcm');
    expect(out).not.toContain('@');
  });

  it.each([
    'new row violates row-level security policy for table "imaging_share_invites"',
    'JWT expired',
    'PGRST116: JSON object requested, multiple (or no) rows returned',
    'StorageApiError: Object not found',
  ])('replaces raw backend errors with the fallback: %s', (msg) => {
    expect(safeErrorMessage(new Error(msg), 'Fallback.')).toBe('Fallback.');
  });

  it('passes short user-facing messages through and handles empties', () => {
    expect(safeErrorMessage('This shared study has no DICOM files.')).toBe('This shared study has no DICOM files.');
    expect(safeErrorMessage(null)).toBe(GENERIC_ERROR_MESSAGE);
    expect(safeErrorMessage({ message: 'x'.repeat(400) }, 'Fallback.')).toBe('Fallback.');
  });
});

describe('share link minting', () => {
  it('refuses in a production build without VITE_PUBLIC_VIEWER_URL, before any database write', async () => {
    vi.resetModules();
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_PUBLIC_VIEWER_URL', '');
    // A preview/current origin is present but must not be used in production.
    vi.stubGlobal('window', { location: { origin: 'https://preview-123.vercel.app' } });
    const insert = vi.fn();
    vi.doMock('../src/lib/supabase', () => ({
      supabase: {
        auth: { getSession: vi.fn(async () => ({ data: { session: { user: { id: 'u1' } } } })) },
        from: vi.fn(() => ({ insert, select: vi.fn() })),
      },
    }));
    const { createShareInvite } = await import('../src/lib/shareInvite');
    await expect(createShareInvite({ studyId: 's1', invitedEmail: 'a@b.co' }))
      .rejects.toThrow('Share links are not configured on this deployment.');
    expect(insert).not.toHaveBeenCalled();
    vi.doUnmock('../src/lib/supabase');
    vi.unstubAllGlobals();
  });
});
