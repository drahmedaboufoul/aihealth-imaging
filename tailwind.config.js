export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Imaging brand palette - dark workspace, neutral accents
        bg: '#0A0A0B',
        panel: '#15161A',
        panel2: '#1F2025',
        border: '#2A2B30',
        muted: '#888A92',
        text: '#E8E9EC',
        accent: '#5DA9E9',     // calm blue - viewer-friendly
        accentMuted: '#3B6FA0',
        success: '#1D9E75',
        warn: '#E8A33B',
        danger: '#E5484D',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
