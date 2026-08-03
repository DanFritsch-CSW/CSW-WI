/** @type {import('tailwindcss').Config} */
export default {
  // Scoped to the scheduling app port (2026-08-03) — Tailwind utility
  // classes only apply where a component explicitly uses them, so this
  // doesn't touch any of CSW-WI's existing custom-CSS pages. `preflight` is
  // disabled below specifically so Tailwind's base reset (which strips
  // default margin/padding/font styling off raw h1/p/button/ul/etc.) can't
  // silently affect anything outside the ported scheduling components.
  content: [
    './src/pages/SchedulingTab.jsx',
    './src/pages/scheduling/**/*.{js,jsx}',
    './src/components/scheduling/**/*.{js,jsx}',
  ],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
}
