import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        scrima: {
          bg: '#050810',
          card: '#0D1221',
          purple: '#7C3AED',
          cyan: '#00D4FF',
          text: '#E8EFFF',
          muted: '#7A8BAD',
          border: '#1A2338',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
