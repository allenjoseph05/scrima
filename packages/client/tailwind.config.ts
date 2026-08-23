// GAMING REDESIGN
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Scrima brand colors (legacy)
        scrima: {
          50: '#f0f4ff',
          100: '#dde6ff',
          200: '#c0cfff',
          300: '#93adff',
          400: '#6080ff',
          500: '#3d55fc',
          600: '#2c35f1',
          700: '#2427de',
          800: '#2323b3',
          900: '#21208e',
          950: '#15135a',
        },
        // Gaming palette
        gaming: {
          bg: '#050810',
          surface: '#0A0E1A',
          card: '#0D1221',
          elevated: '#121929',
          border: '#1A2440',
          'border-bright': '#2D4A6B',
          purple: '#7C3AED',
          'purple-glow': '#A78BFA',
          'purple-dim': '#4C1D95',
          cyan: '#00D4FF',
          'cyan-dim': '#0E4966',
          red: '#FF2D55',
          green: '#00FF85',
          orange: '#F59E0B',
          'text-primary': '#E8EFFF',
          'text-secondary': '#7A8BAD',
          'text-muted': '#3D4F6E',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      animation: {
        'spin-slow': 'spin 3s linear infinite',
        'pulse-soft': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        scan: 'scan 3s linear infinite',
        flicker: 'flicker 4s ease-in-out infinite',
        shimmer: 'shimmer 4s linear infinite',
        float: 'float 3s ease-in-out infinite',
        'rotate-slow': 'rotate-slow 12s linear infinite',
        'fade-in-up': 'fade-in-up 0.4s ease-out both',
      },
      keyframes: {
        'glow-pulse': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 8px #7C3AED' },
          '50%': { opacity: '0.6', boxShadow: '0 0 20px #7C3AED, 0 0 40px #7C3AED44' },
        },
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
        flicker: {
          '0%, 95%, 100%': { filter: 'brightness(1)' },
          '96%': { filter: 'brightness(0.85)' },
          '97%': { filter: 'brightness(1.05)' },
          '98%': { filter: 'brightness(0.9)' },
          '99%': { filter: 'brightness(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        'rotate-slow': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
