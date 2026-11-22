/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // SF on Apple platforms, PingFang for Chinese, graceful fallbacks elsewhere.
      fontFamily: {
        // Vietnamese tone marks (ế ộ ữ …) need a font with the full Latin
        // Extended Additional block: Segoe UI / Noto Sans cover Windows and
        // Linux, SF Pro covers macOS, and system-ui is the last-resort
        // fallback before the generic sans-serif.
        sans: [
          '-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"SF Pro Display"',
          '"Segoe UI"', '"Noto Sans"',
          '"Helvetica Neue"', '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"',
          'Inter', 'system-ui', 'sans-serif',
        ],
      },
      colors: {
        // Single interactive accent across the product (iOS dark-mode blue).
        // Violet stays reserved for AI vocabulary highlights only.
        brand: {
          DEFAULT: '#0A84FF',
          300: '#66B0FF',
          400: '#409CFF',
          500: '#0A84FF',
          600: '#0774E8',
        },
        glass: {
          light: 'rgba(255, 255, 255, 0.1)',
          dark: 'rgba(0, 0, 0, 0.2)',
          border: 'rgba(255, 255, 255, 0.05)',
        },
        // Semantic surface / text / line / state tokens (tokens.md §2.1).
        // Old literal classes (zinc-*, white/*) stay available via Tailwind's
        // default palette; these are additive and don't change any default.
        app: '#09090b',
        surface: { DEFAULT: '#18181b', 2: '#27272a', 3: '#3f3f46' },
        fg: {
          primary: '#f4f4f5',
          strong: '#d4d4d8',
          secondary: '#a1a1aa',
          muted: '#71717a',
          disabled: '#52525b',
          inverse: '#09090b',
        },
        line: {
          subtle: 'rgba(255,255,255,0.05)',
          strong: 'rgba(255,255,255,0.10)',
        },
        state: {
          hover: 'rgba(255,255,255,0.05)',
          selected: 'rgba(255,255,255,0.07)',
          pressed: 'rgba(255,255,255,0.10)',
        },
        overlay: 'rgba(9,9,11,0.70)',
        // Solid "control" fill for the one primary button (replaces bg-zinc-100).
        control: '#f4f4f5',
        success: { DEFAULT: '#10B981', fg: '#34D399' },
        warning: { DEFAULT: '#F59E0B', fg: '#FBBF24' },
        danger: { DEFAULT: '#EF4444', fg: '#F87171' },
        highlight: { DEFAULT: '#8B5CF6', fg: '#D8B4FE' },
      },
      fontSize: {
        // Type scale (tokens.md §3.2). Named sizes are additive; text-xs/sm/…
        // keep their Tailwind defaults so existing classes render unchanged.
        micro: ['0.6875rem', { lineHeight: '1rem' }],
        caption: ['0.8125rem', { lineHeight: '1.125rem' }],
        ui: ['0.875rem', { lineHeight: '1.25rem' }],
        'body-zh': ['0.9375rem', { lineHeight: '1.5rem' }],
        body: ['1rem', { lineHeight: '1.625rem' }],
        section: ['1.0625rem', { lineHeight: '1.5rem' }],
        dialog: ['1.25rem', { lineHeight: '1.75rem' }],
        page: ['1.5rem', { lineHeight: '2rem' }],
        'page-lg': ['1.875rem', { lineHeight: '2.25rem' }],
        'display-sm': ['2.25rem', { lineHeight: '2.5rem' }],
        display: ['3rem', { lineHeight: '3.25rem' }],
        'display-lg': ['3.75rem', { lineHeight: '4rem' }],
      },
      letterSpacing: {
        hero: '-0.015em',
      },
      borderRadius: {
        control: '0.5rem',
        'control-lg': '0.75rem',
        card: '1rem',
        layer: '1rem',
        panel: '1.5rem',
      },
      height: {
        'control-xs': '1.75rem',
        'control-sm': '2rem',
        'control-md': '2.25rem',
        'control-lg': '2.5rem',
        'control-xl': '3rem',
        subheader: '3rem',
        topbar: '4rem',
        'topbar-mobile': '3rem',
        bottombar: '3.5rem',
        'sidebar-header': '4rem',
      },
      minHeight: {
        touch: '2.75rem',
      },
      width: {
        sidebar: '15rem',
        'sidebar-collapsed': '4.5rem',
      },
      maxWidth: {
        page: '90rem',
        admin: '72rem',
        library: '64rem',
        course: '48rem',
        reading: '45rem',
        task: '42rem',
        rail: '20rem',
        'dialog-sm': '28rem',
        'dialog-md': '36rem',
        'dialog-lg': '56rem',
        // Desktop page measures (docs/设计-桌面布局规范.md §2). One page
        // prototype = one token; screens use PageContainer instead of
        // picking their own max-w-*.
        'page-wide': '105rem',
        'page-standard': '80rem',
        'page-reading': '75rem',
        'page-marketing': '75rem',
        'page-focused': '42rem',
        // Reading body measure: 65–75ch, spec pins 68ch.
        'reading-body': '68ch',
      },
      gridTemplateColumns: {
        // PageGrid rail: main column + 320px side rail, ≥xl only.
        'page-rail': 'minmax(0, 1fr) 20rem',
      },
      transitionTimingFunction: {
        // Apple-feel deceleration curve for micro-interactions
        apple: 'cubic-bezier(0.25, 1, 0.5, 1)',
        exit: 'cubic-bezier(0.4, 0, 1, 1)',
      },
      boxShadow: {
        // Layered, soft elevation shadows
        'elev-1': '0 1px 1px rgba(0,0,0,0.25), 0 4px 12px rgba(0,0,0,0.25)',
        'elev-2': '0 1px 1px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.35)',
        'elev-3': '0 1px 2px rgba(0,0,0,0.35), 0 24px 60px rgba(0,0,0,0.5)',
      },
      zIndex: {
        base: '0',
        raised: '10',
        chrome: '20',
        nav: '30',
        overlay: '40',
        dialog: '50',
        popover: '60',
        toast: '100',
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out',
        'slide-up': 'slideUp 0.5s ease-out',
        // Right-side drawer entry (Dialog `side="right"`). Exit is a plain
        // transition in the component; both are neutralized by the global
        // prefers-reduced-motion rule in index.css.
        'slide-in-right': 'slideInRight 0.28s cubic-bezier(0.25, 1, 0.5, 1)',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(24px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        }
      }
    },
  },
  plugins: [],
}
