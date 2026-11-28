/**
 * LintIQ — Shared Tailwind CSS CDN Configuration
 * Loaded on EVERY page BEFORE any Tailwind classes are used.
 * Keeps the dark-surface palette, accent colors, and fonts in ONE place.
 */
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        surface: {
          DEFAULT: '#10131a',
          dim: '#090b0f',
          container: '#151922',
          card: '#191e29',
          border: 'rgba(255, 255, 255, 0.08)',
          hover: '#1c212c',
        },
        accent: {
          DEFAULT: '#10b981',
          hover: '#059669',
          subtle: '#064e3b',
        }
      }
    }
  }
};
