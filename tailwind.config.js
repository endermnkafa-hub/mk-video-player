/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./frontend/index.html', './frontend/detached.html', './frontend/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#eff6ff', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' },
      },
    },
  },
};
