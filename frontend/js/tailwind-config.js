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
        sans: ['Geist', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        surface: {
          DEFAULT: '#0f131c',
          dim: '#0b0e15',
          container: '#141822',
          card: '#181d2a',
          border: '#232938',
          hover: '#1e2434',
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
