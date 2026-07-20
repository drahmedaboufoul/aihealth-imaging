/*
 * viewerTokens — JS mirror of the semantic dark token set.
 *
 * The single source of truth is the `:root` block in src/index.css;
 * tailwind.config.js maps utility classes onto those vars. This module
 * exists for the places that CANNOT consume CSS classes: SVG overlay
 * attributes (stroke/fill), canvas drawing, and inline scrims.
 *
 * Keep values in lockstep with index.css — if you change one, change both.
 */

export const VIEWER_TOKENS = {
  bgPrimary: '#121212',
  bgSecondary: '#1F1F1F',
  bgTertiary: '#292929',
  labelPrimary: 'rgba(255, 255, 255, 0.84)',
  labelSecondary: 'rgba(255, 255, 255, 0.56)',
  labelTertiary: 'rgba(255, 255, 255, 0.42)',
  separator: 'rgba(255, 255, 255, 0.12)',

  // ONE accent (kimiBlue) — replaces the de-facto amber (audit #6/#18).
  accent: '#1A88FF',
  accentHover: '#258EFF',

  // Status colors (audit #18): nerve = positiveGreen, too-close = danger,
  // AI = purple.
  positive: '#16C456',
  danger: '#FF4756',
  warning: '#FF9F0A',
  ai: '#A16BFF',

  // Full-cover scrims over the viewport area (loading / error states) and
  // the translucent chip backing on viewport HUDs.
  scrim: 'rgba(18, 18, 18, 0.95)',
  scrimDeep: 'rgba(18, 18, 18, 0.97)',
  hudChip: 'rgba(18, 18, 18, 0.6)',
  hudChipStrong: 'rgba(18, 18, 18, 0.7)',
};
