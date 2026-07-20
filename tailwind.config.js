import animate from 'tailwindcss-animate';

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1rem',
    },
    extend: {
      colors: {
        // ── Semantic dark token set (Kimi tokens.json · dark) ───────────
        // One source of truth: the CSS vars in src/index.css :root. These
        // entries only map Tailwind classes onto the vars. JS / SVG /
        // canvas consumers import the same values from
        // components/viewer/viewerTokens.js.
        background: {
          DEFAULT: 'var(--bg-primary)',
          primary: 'var(--bg-primary)',
          secondary: 'var(--bg-secondary)',
          tertiary: 'var(--bg-tertiary)',
        },
        labels: {
          primary: 'var(--label-primary)',
          secondary: 'var(--label-secondary)',
          tertiary: 'var(--label-tertiary)',
          quaternary: 'var(--label-quaternary)',
        },
        separator: { s1: 'var(--separator-s1)' },
        fills: {
          f1: 'var(--fill-f1)',
          f2: 'var(--fill-f2)',
          f3: 'var(--fill-f3)',
        },
        // ONE accent (color.status.kimiBlue) — replaces the de-facto amber
        // the viewers grew and the older #5DA9E9 shell accent (audit #6/#18).
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          active: 'var(--accent-active)',
          soft: 'var(--accent-soft)',
          foreground: '#FFFFFF',
        },
        accentMuted: 'var(--accent-active)',
        // Semantic status colors (audit #18): nerve/success = positiveGreen,
        // warning-too-close + destructive = danger, AI = purple.
        status: {
          danger: 'var(--danger)',
          'danger-hover': 'var(--danger-hover)',
          'danger-soft': 'var(--danger-soft)',
          success: 'var(--positive)',
          'success-hover': 'var(--positive-hover)',
          'success-soft': 'var(--positive-soft)',
          warning: 'var(--warning)',
          'warning-soft': 'var(--warning-soft)',
          ai: 'var(--ai)',
          'ai-hover': 'var(--ai-hover)',
          'ai-soft': 'var(--ai-soft)',
        },

        // ── Legacy aliases onto the same semantic set ──────────────────
        // Kept so pre-existing surfaces (Shell / Home / Login / ui/* /
        // ios-viewer) migrate by alias instead of by rewrite.
        bg: 'var(--bg-primary)',
        panel: 'var(--bg-secondary)',
        panel2: 'var(--bg-tertiary)',
        text: 'var(--label-primary)',
        muted: {
          DEFAULT: 'var(--label-secondary)',
          foreground: 'var(--label-tertiary)',
        },
        foreground: 'var(--label-primary)',
        border: 'var(--separator-s1)',
        input: 'var(--separator-s1)',
        ring: 'var(--accent)',
        primary: {
          DEFAULT: 'var(--accent)',
          foreground: '#FFFFFF',
        },
        secondary: {
          DEFAULT: 'var(--bg-tertiary)',
          foreground: 'var(--label-primary)',
        },
        destructive: {
          DEFAULT: 'var(--danger)',
          foreground: '#FFFFFF',
        },
        success: {
          DEFAULT: 'var(--positive)',
          foreground: '#FFFFFF',
        },
        warning: {
          DEFAULT: 'var(--warning)',
          foreground: '#121212',
        },
      },
      fontSize: {
        // Kimi webUI scale (typography.webUI): c1 = 12/18 for HUD + badges,
        // b2 = 14/20 for controls, labels, list rows. Sub-12px arbitrary
        // sizes were purged in W8 — nothing below 12px remains.
        xs: ['12px', { lineHeight: '18px' }],
        sm: ['14px', { lineHeight: '20px' }],
      },
      // Layering tokens (web-best-practices §14) — replaces the arbitrary
      // z-10/20/30/50 scale the viewers grew (audit #20).
      zIndex: {
        header: '500',
        'modal-backdrop': '800',
        modal: '810',
        'dialog-backdrop': '850',
        dialog: '860',
        tooltip: '900',
        toast: '1000',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [animate],
};
