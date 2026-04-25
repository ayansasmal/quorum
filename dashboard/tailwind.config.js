/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Entity type palette — matches FRONTEND.md node styling
        decision:    '#3b82f6',   // blue-500
        pattern:     '#22c55e',   // green-500
        constraint:  '#f59e0b',   // amber-500
        runbook:     '#a855f7',   // purple-500
        requirement: '#6b7280',   // gray-500
      },
    },
  },
  plugins: [],
}
