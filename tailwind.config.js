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
        // Imaging brand palette - dark workspace
        bg: '#0A0A0B',
        panel: '#15161A',
        panel2: '#1F2025',
        muted: '#888A92',
        text: '#E8E9EC',
        accent: {
          DEFAULT: '#5DA9E9',
          foreground: '#0A0A0B',
        },
        accentMuted: '#3B6FA0',

        // shadcn-compatible tokens (dark workspace)
        border: '#2A2B30',
        input: '#2A2B30',
        ring: '#5DA9E9',
        background: '#0A0A0B',
        foreground: '#E8E9EC',
        primary: {
          DEFAULT: '#5DA9E9',
          foreground: '#0A0A0B',
        },
        secondary: {
          DEFAULT: '#1F2025',
          foreground: '#E8E9EC',
        },
        destructive: {
          DEFAULT: '#E5484D',
          foreground: '#ffffff',
        },
        success: {
          DEFAULT: '#1D9E75',
          foreground: '#ffffff',
        },
        warning: {
          DEFAULT: '#E8A33B',
          foreground: '#0A0A0B',
        },
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
