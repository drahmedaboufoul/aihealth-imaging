/*
 * Runtime configuration check. The viewer cannot start without its Supabase
 * client settings; main.jsx renders <ViewerNotConfigured /> instead of a
 * blank page when any are missing. `vite build` in production mode refuses
 * to build without them (vite.config.js), so this is the dev / misconfigured
 * preview safety net.
 */

export const REQUIRED_CLIENT_ENV = Object.freeze(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']);

/** Names (never values) of the required client variables that are unset. */
export function missingClientEnv(env = import.meta.env) {
  return REQUIRED_CLIENT_ENV.filter((name) => !String(env?.[name] ?? '').trim());
}
