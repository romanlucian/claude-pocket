// Pure helpers for the pane: fitting the 160x144 picture to it, reading keys
// and paths. No `$` here, so the tests call them directly.

export const WIDTH = 160
export const HEIGHT = 144

export type Fit = { columns: number; rows: number }

/**
 * The cell box the picture gets in a pane `columns` wide with `rows` free:
 * the terminal scales the real picture into it, a cell being about twice as
 * tall as wide.
 */
export function fit(columns: number, rows: number): Fit {
  const maxColumns = Math.max(16, Math.min(columns, 96))
  const maxRows = Math.max(8, rows)
  // rows a picture `c` columns wide needs: a cell is two "pixels" tall.
  const rowsFor = (c: number) => Math.ceil((c * HEIGHT) / WIDTH / 2)
  let c = maxColumns
  while (c > 16 && rowsFor(c) > maxRows) c--
  return { columns: c, rows: Math.min(255, rowsFor(c)) }
}

/** The console button a key stands for, or `pause`. */
export function buttonFor(key: string): string | undefined {
  switch (key) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return key
    case 'z':
    case 'Z':
      return 'a'
    case 'x':
    case 'X':
      return 'b'
    case 'return':
    case 'enter':
      return 'start'
    case ' ':
    case 'space':
      return 'select'
    case 'p':
    case 'P':
      return 'pause'
    default:
      return undefined
  }
}

/** A path as typed: `~/Games/x.gb` under the home folder, quotes removed. */
export function expandPath(path: string, home: string): string {
  const clean = path.trim().replace(/^(['"])(.*)\1$/, '$2')
  return clean.startsWith('~/') ? `${home}${clean.slice(1)}` : clean
}
