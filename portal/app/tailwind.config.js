/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        sm:   ['16px', { lineHeight: '1.5', fontWeight: '600' }],
        md:   ['20px', { lineHeight: '1.4', fontWeight: '600' }],
        lg:   ['28px', { lineHeight: '1.3', fontWeight: '700' }],
        xl:   ['40px', { lineHeight: '1.1', fontWeight: '700' }],
      },
      colors: {
        // Legacy
        base:    '#1f1f21',
        surface: '#2a2a2d',
        inset:   '#161618',
        primary: '#F5F5F7',
        muted:   'rgba(245,245,247,0.6)',
        accent:  '#f97316',
        'accent-hover': '#ea6c0a',
        // Mission control tokens
        'mc-base':     '#080B10',
        'mc-card':     '#0F1318',
        'mc-elevated': '#1A1F28',
        'mc-border':   '#252C38',
        'mc-primary':  '#C8D0DC',
        'mc-secondary':'#8892A0',
        'mc-emphasis': '#FFFFFF',
        'mc-cyan':     '#00D4FF',
        'mc-green':    '#2ECC71',
        'mc-amber':    '#F5A623',
        'mc-red':      '#E84040',
        'mc-purple':   '#7B68EE',
      },
      borderColor: {
        DEFAULT: 'rgba(255,255,255,0.06)',
      },
    },
  },
  plugins: [],
};
