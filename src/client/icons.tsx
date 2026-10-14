import type { CSSProperties } from 'react'

const paths = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5M9 21v-8h6v8',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 12M4 12l2.3 6a7 7 0 0 0 11.6-1',
  play: 'm8 5 11 7-11 7V5',
  stop: 'M6 6h12v12H6V6',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3M8 12l3 3 5-6',
  archive: 'M4 3h16v5H4V3M6 8v13h12V8M10 12h4',
  wrench: 'M14 7a5 5 0 0 0 6 6l-9 9-5-5 9-9a5 5 0 0 0-1-1M14 7l4 4 4-4M14 7V3',
  arrow: 'M12 4v16M6 14l6 6 6-6',
  check: 'm5 12 4 4L19 6',
  info: 'M12 10v7M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
} as const

export function HomeIcon({ name = 'home', size = 20, style }: { name?: keyof typeof paths; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}><path d={paths[name]} /></svg>
}
