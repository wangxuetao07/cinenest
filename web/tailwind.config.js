/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0f1115',
        card: '#1a1d24',
        cardhover: '#22262f',
        line: '#2a2f3a',
        accent: '#4f8cff',
        accenthover: '#3d7bf0',
        muted: '#8b93a7',
      },
      fontFamily: {
        sans: ['"Microsoft YaHei"', '"PingFang SC"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
