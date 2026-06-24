import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      /* Metis design tokens — from prototype HTML CSS variables */
      colors: {
        dark: '#0F1B2D',
        navy: '#1A2744',
        'navy-light': '#1E3050',
        sidebar: '#162035',
        accent: '#00B4D8',
        'accent-dark': '#0077B6',
        gold: '#FFB703',
        light: '#E8F4F8',
        'light-bg': '#F0F4F8',
        muted: '#8B9BB4',
        'muted-dark': '#5A6A7E',
        success: '#06D6A0',
        'success-light': '#D1FAE5',
        danger: '#EF476F',
        'danger-light': '#FDE8EF',
        warning: '#FB8500',
        'warning-light': '#FFF3E0',
        purple: '#7C3AED',
        'purple-light': '#EDE9FE',
        border: '#E2E8F0',
        card: '#FFFFFF',
        'table-header': '#F1F5F9',
        'table-alt': '#F8FAFC',
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans KR', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
