const ESC = ''

const CODES = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
} as const

export type StyleName = keyof Omit<typeof CODES, 'reset'>

let enabled = decideDefault()

function decideDefault(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false
  if (process.env['FORCE_COLOR'] !== undefined) return true
  return process.stdout.isTTY === true
}

export function setColorEnabled(value: boolean): void {
  enabled = value
}

export function paint(style: StyleName, text: string): string {
  return enabled ? `${CODES[style]}${text}${CODES.reset}` : text
}

export const bold = (text: string): string => paint('bold', text)
export const dim = (text: string): string => paint('dim', text)
export const red = (text: string): string => paint('red', text)
export const green = (text: string): string => paint('green', text)
export const yellow = (text: string): string => paint('yellow', text)
export const cyan = (text: string): string => paint('cyan', text)
export const gray = (text: string): string => paint('gray', text)
export const magenta = (text: string): string => paint('magenta', text)

export function riskColor(risk: string): string {
  switch (risk) {
    case 'critical':
      return paint('magenta', risk.toUpperCase())
    case 'high':
      return paint('red', risk.toUpperCase())
    case 'medium':
      return paint('yellow', risk.toUpperCase())
    default:
      return paint('green', risk.toUpperCase())
  }
}
