// Pure helpers between the emulator's frames and the pane: unpacking the
// shades, fitting the 160x144 picture to the pane, drawing it as terminal
// cells, and reading keys. No `$` here, so the tests call them directly.

export const WIDTH = 160
export const HEIGHT = 144

// The four shades, lightest first (0x00RRGGBB), as the emulator draws them.
export const SHADES = [0xe0f8d0, 0x88c070, 0x346856, 0x081820]

const UPPER_HALF_BLOCK = 0x2580

/** The emulator's frame (4 shades per byte, base64) as one shade per pixel. */
export function unpack(px: string): Uint8Array {
  const bytes = Uint8Array.fromBase64(px)
  const shades = new Uint8Array(bytes.length * 4)
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    shades[i * 4] = b & 3
    shades[i * 4 + 1] = (b >> 2) & 3
    shades[i * 4 + 2] = (b >> 4) & 3
    shades[i * 4 + 3] = (b >> 6) & 3
  }
  return shades
}

export type Fit = { columns: number; rows: number }

/**
 * The cell box the picture gets in a pane `columns` wide with `rows` free.
 * Cells: each terminal cell shows two pixels stacked (an upper half block),
 * up to full size. Pixels: the terminal scales a real picture into the box,
 * a cell being about twice as tall as wide.
 */
export function fit(mode: 'cells' | 'pixels', columns: number, rows: number): Fit {
  const maxColumns = Math.max(16, Math.min(columns, mode === 'cells' ? WIDTH : 96))
  const maxRows = Math.max(8, rows)
  // rows a picture `c` columns wide needs: cells hold 2 pixels each.
  const rowsFor = (c: number) => Math.ceil((c * HEIGHT) / WIDTH / 2)
  let c = maxColumns
  while (c > 16 && rowsFor(c) > maxRows) c--
  return { columns: c, rows: Math.min(255, rowsFor(c)) }
}

/**
 * The picture as `Raster` cells, base64: upper half blocks whose foreground
 * is the upper pixel and background the lower, scaled to the box.
 */
export function toCells(shades: Uint8Array, box: Fit): string {
  const { columns, rows } = box
  const words = new Uint32Array(columns * rows * 3)
  const pixelRows = rows * 2
  for (let cy = 0; cy < rows; cy++) {
    const top = Math.min(HEIGHT - 1, Math.floor(((cy * 2) * HEIGHT) / pixelRows))
    const bottom = Math.min(HEIGHT - 1, Math.floor(((cy * 2 + 1) * HEIGHT) / pixelRows))
    for (let cx = 0; cx < columns; cx++) {
      const x = Math.min(WIDTH - 1, Math.floor((cx * WIDTH) / columns))
      const o = (cy * columns + cx) * 3
      words[o] = UPPER_HALF_BLOCK
      words[o + 1] = SHADES[shades[top * WIDTH + x] ?? 0] ?? 0
      words[o + 2] = SHADES[shades[bottom * WIDTH + x] ?? 0] ?? 0
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}

/** A blank (lightest) picture, before the first frame arrives. */
export const blank = (): Uint8Array => new Uint8Array(WIDTH * HEIGHT)

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
