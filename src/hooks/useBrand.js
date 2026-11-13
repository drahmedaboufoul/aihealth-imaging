/*
 * useBrand — report colours for the standalone imaging app. kyour reads a tenant's
 * clinic_branding row; here every report uses the platform palette until tenant
 * branding is added.
 */
const BRAND = Object.freeze({
  brown: '#0A1A22',
  gold: '#119DA4',
  goldWarm: '#34D399',
  goldwarm: '#34D399',
  accent: '#34D399',
  cream: '#EFF5F4',
  line: 'rgba(10,26,34,0.12)',
  border: 'rgba(10,26,34,0.12)',
  muted: '#5B6B70',
  ink: '#0A1A22',
});

export function useBrand() {
  return { brand: BRAND, isLoading: false };
}
