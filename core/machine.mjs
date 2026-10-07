// The whole handheld: memory map, cartridge banking, timer, picture
// processor, joypad, OAM DMA and the serial port. Sound registers are
// kept (games read them back) but no sound is made.

import { Cpu } from './cpu.mjs'

export const WIDTH = 160
export const HEIGHT = 144
const CYCLES_PER_LINE = 456
const LINES_PER_FRAME = 154

// The interrupt bits in IF and IE.
const VBLANK = 0x01
const STAT = 0x02
const TIMER = 0x04
const SERIAL = 0x08
const JOYPAD = 0x10

// The four shades, lightest first, as 0x00RRGGBB: the classic green screen.
export const SHADES = [0xe0f8d0, 0x88c070, 0x346856, 0x081820]

// Buttons by name, as the joypad register sees them.
export const BUTTONS = ['right', 'left', 'up', 'down', 'a', 'b', 'select', 'start']

class Cartridge {
  constructor(rom) {
    this.rom = rom
    const type = rom[0x147]
    this.mbc =
      type === 0 || type === 8 || type === 9 ? 0
      : type >= 1 && type <= 3 ? 1
      : type >= 0x0f && type <= 0x13 ? 3
      : type >= 0x19 && type <= 0x1e ? 5
      : -1
    if (this.mbc === -1) throw new Error(`cartridge type 0x${type.toString(16)} is not supported yet`)
    const ramSizes = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000]
    this.ram = new Uint8Array(Math.max(ramSizes[rom[0x149]] ?? 0, 0x2000))
    this.romBanks = Math.max(2, rom.length >> 14)
    this.romBank = 1
    this.ramBank = 0
    this.ramEnabled = false
    this.mode = 0
    this.title = String.fromCharCode(...rom.subarray(0x134, 0x144)).replace(/\0.*$/s, '').trim()
  }

  read(addr) {
    if (addr < 0x4000) {
      if (this.mbc === 1 && this.mode === 1) {
        const bank = (this.ramBank << 5) % this.romBanks
        return this.rom[bank * 0x4000 + addr] ?? 0xff
      }
      return this.rom[addr] ?? 0xff
    }
    if (addr < 0x8000) {
      let bank = this.romBank
      if (this.mbc === 1) bank |= this.ramBank << 5
      bank %= this.romBanks
      return this.rom[bank * 0x4000 + (addr - 0x4000)] ?? 0xff
    }
    // 0xA000-0xBFFF: cartridge RAM
    if (!this.ramEnabled && this.mbc !== 0) return 0xff
    const bank = this.mbc === 1 && this.mode === 0 ? 0 : this.ramBank
    return this.ram[(bank * 0x2000 + (addr - 0xa000)) % this.ram.length]
  }

  write(addr, v) {
    if (addr >= 0xa000) {
      if (!this.ramEnabled && this.mbc !== 0) return
      const bank = this.mbc === 1 && this.mode === 0 ? 0 : this.ramBank
      this.ram[(bank * 0x2000 + (addr - 0xa000)) % this.ram.length] = v
      return
    }
    if (this.mbc === 0) return
    if (addr < 0x2000) {
      this.ramEnabled = (v & 0x0f) === 0x0a
    } else if (addr < 0x4000) {
      if (this.mbc === 1) {
        this.romBank = v & 0x1f || 1
      } else if (this.mbc === 3) {
        this.romBank = v & 0x7f || 1
      } else if (addr < 0x3000) {
        this.romBank = (this.romBank & 0x100) | v
      } else {
        this.romBank = (this.romBank & 0xff) | ((v & 1) << 8)
      }
    } else if (addr < 0x6000) {
      this.ramBank = this.mbc === 5 ? v & 0x0f : v & 0x03
    } else if (this.mbc === 1) {
      this.mode = v & 1
    }
  }
}

export class Machine {
  constructor(rom) {
    this.cart = new Cartridge(rom)
    this.vram = new Uint8Array(0x2000)
    this.wram = new Uint8Array(0x2000)
    this.oam = new Uint8Array(0xa0)
    this.hram = new Uint8Array(0x7f)
    this.io = new Uint8Array(0x80)
    this.ie = 0
    this.if = 0xe1 & 0x1f
    // The picture: one shade index (0-3) per pixel, and the finished frame.
    this.frame = new Uint8Array(WIDTH * HEIGHT)
    this.frameReady = false
    this.lineCycles = 0
    this.ly = 0
    this.windowLine = 0
    this.divCounter = 0xabcc
    this.timerCounter = 0
    this.pressed = new Set()
    this.serialOut = []
    this.io[0x40] = 0x91 // LCDC
    this.io[0x47] = 0xfc // BGP
    this.io[0x48] = 0xff
    this.io[0x49] = 0xff
    this.io[0x26] = 0xf1 // NR52
    this.cpu = new Cpu(this)
  }

  get title() { return this.cart.title }

  // ---- The memory map ---------------------------------------------------

  read8(addr) {
    if (addr < 0x8000) return this.cart.read(addr)
    if (addr < 0xa000) return this.vram[addr - 0x8000]
    if (addr < 0xc000) return this.cart.read(addr)
    if (addr < 0xe000) return this.wram[addr - 0xc000]
    if (addr < 0xfe00) return this.wram[addr - 0xe000]
    if (addr < 0xfea0) return this.oam[addr - 0xfe00]
    if (addr < 0xff00) return 0xff
    if (addr < 0xff80) return this.readIo(addr & 0x7f)
    if (addr < 0xffff) return this.hram[addr - 0xff80]
    return this.ie
  }

  write8(addr, v) {
    v &= 0xff
    if (addr < 0x8000) this.cart.write(addr, v)
    else if (addr < 0xa000) this.vram[addr - 0x8000] = v
    else if (addr < 0xc000) this.cart.write(addr, v)
    else if (addr < 0xe000) this.wram[addr - 0xc000] = v
    else if (addr < 0xfe00) this.wram[addr - 0xe000] = v
    else if (addr < 0xfea0) this.oam[addr - 0xfe00] = v
    else if (addr < 0xff00) return
    else if (addr < 0xff80) this.writeIo(addr & 0x7f, v)
    else if (addr < 0xffff) this.hram[addr - 0xff80] = v
    else this.ie = v
  }

  readIo(r) {
    switch (r) {
      case 0x00: return this.readJoypad()
      case 0x04: return (this.divCounter >> 8) & 0xff
      case 0x0f: return this.if | 0xe0
      case 0x41: {
        const stat = this.io[0x41] & 0x78
        const coincidence = this.ly === this.io[0x45] ? 0x04 : 0
        return 0x80 | stat | coincidence | this.mode()
      }
      case 0x44: return this.ly
      default: return this.io[r]
    }
  }

  writeIo(r, v) {
    switch (r) {
      case 0x00: this.io[0] = v & 0x30; return
      case 0x02: // serial control: finish a transfer at once
        this.io[2] = v
        if ((v & 0x81) === 0x81) {
          this.serialOut.push(this.io[1])
          this.io[1] = 0xff
          this.io[2] = v & 0x7f
          this.if |= SERIAL
        }
        return
      case 0x04: this.divCounter = 0; return
      case 0x0f: this.if = v & 0x1f; return
      case 0x40:
        if ((v & 0x80) === 0 && (this.io[0x40] & 0x80) !== 0) {
          this.ly = 0
          this.lineCycles = 0
          this.windowLine = 0
        }
        this.io[0x40] = v
        return
      case 0x41: this.io[0x41] = v & 0x78; return
      case 0x44: return
      case 0x46: { // OAM DMA
        const base = v << 8
        for (let i = 0; i < 0xa0; i++) this.oam[i] = this.read8(base + i)
        this.io[0x46] = v
        return
      }
      default: this.io[r] = v
    }
  }

  readJoypad() {
    const select = this.io[0]
    let bits = 0x0f
    if ((select & 0x10) === 0) {
      if (this.pressed.has('right')) bits &= ~0x01
      if (this.pressed.has('left')) bits &= ~0x02
      if (this.pressed.has('up')) bits &= ~0x04
      if (this.pressed.has('down')) bits &= ~0x08
    }
    if ((select & 0x20) === 0) {
      if (this.pressed.has('a')) bits &= ~0x01
      if (this.pressed.has('b')) bits &= ~0x02
      if (this.pressed.has('select')) bits &= ~0x04
      if (this.pressed.has('start')) bits &= ~0x08
    }
    return 0xc0 | select | bits
  }

  // Holds or lets go of a button; a fresh press raises the joypad interrupt.
  setButton(name, isDown) {
    if (!BUTTONS.includes(name)) return
    if (isDown && !this.pressed.has(name)) this.if |= JOYPAD
    if (isDown) this.pressed.add(name)
    else this.pressed.delete(name)
  }

  // ---- Time: the timer and the picture advance with every instruction ----

  tick(cycles) {
    this.tickTimer(cycles)
    this.tickPicture(cycles)
  }

  tickTimer(cycles) {
    const before = this.divCounter
    this.divCounter = (this.divCounter + cycles) & 0xffff
    const tac = this.io[0x07]
    if ((tac & 0x04) === 0) return
    const bit = [9, 3, 5, 7][tac & 3]
    // Count the falling edges of the selected DIV bit over these cycles.
    const period = 1 << (bit + 1)
    const ticks = Math.floor((before % period + cycles) / period)
    for (let i = 0; i < ticks; i++) {
      const tima = this.io[0x05] + 1
      if (tima > 0xff) {
        this.io[0x05] = this.io[0x06]
        this.if |= TIMER
      } else {
        this.io[0x05] = tima
      }
    }
  }

  mode() {
    if ((this.io[0x40] & 0x80) === 0) return 0
    if (this.ly >= HEIGHT) return 1
    if (this.lineCycles < 80) return 2
    if (this.lineCycles < 252) return 3
    return 0
  }

  tickPicture(cycles) {
    const lcdc = this.io[0x40]
    if ((lcdc & 0x80) === 0) return
    const stat = this.io[0x41]
    const modeBefore = this.mode()
    this.lineCycles += cycles
    if (this.lineCycles >= CYCLES_PER_LINE) {
      this.lineCycles -= CYCLES_PER_LINE
      this.ly = (this.ly + 1) % LINES_PER_FRAME
      if (this.ly === HEIGHT) {
        this.if |= VBLANK
        this.frameReady = true
        if (stat & 0x10) this.if |= STAT
      }
      if (this.ly === 0) this.windowLine = 0
      if (this.ly === this.io[0x45] && stat & 0x40) this.if |= STAT
    }
    const modeAfter = this.mode()
    if (modeAfter !== modeBefore) {
      if (modeAfter === 3 && this.ly < HEIGHT) this.drawLine(this.ly)
      if (modeAfter === 0 && stat & 0x08) this.if |= STAT
      if (modeAfter === 2 && stat & 0x20) this.if |= STAT
    }
  }

  // ---- The picture: one scanline of background, window and sprites -------

  drawLine(ly) {
    const lcdc = this.io[0x40]
    const scy = this.io[0x42]
    const scx = this.io[0x43]
    const wy = this.io[0x4a]
    const wx = this.io[0x4b] - 7
    const bgp = this.io[0x47]
    const row = ly * WIDTH
    // The raw color index (0-3) of the background under each pixel, which
    // decides whether a "behind background" sprite shows.
    const bgIndex = new Uint8Array(WIDTH)
    const unsignedTiles = (lcdc & 0x10) !== 0

    const tileRowAddr = (tile, line) => {
      const base = unsignedTiles ? tile * 16 : 0x1000 + ((tile << 24) >> 24) * 16
      return base + line * 2
    }

    if (lcdc & 0x01) {
      const windowOn = (lcdc & 0x20) !== 0 && ly >= wy && wx < WIDTH
      const bgMap = lcdc & 0x08 ? 0x1c00 : 0x1800
      const winMap = lcdc & 0x40 ? 0x1c00 : 0x1800
      for (let x = 0; x < WIDTH; x++) {
        let mapX
        let mapY
        let map
        if (windowOn && x >= wx) {
          mapX = x - wx
          mapY = this.windowLine
          map = winMap
        } else {
          mapX = (x + scx) & 0xff
          mapY = (ly + scy) & 0xff
          map = bgMap
        }
        const tile = this.vram[map + (mapY >> 3) * 32 + (mapX >> 3)]
        const addr = tileRowAddr(tile, mapY & 7)
        const bit = 7 - (mapX & 7)
        const color = (((this.vram[addr + 1] >> bit) & 1) << 1) | ((this.vram[addr] >> bit) & 1)
        bgIndex[x] = color
        this.frame[row + x] = (bgp >> (color * 2)) & 3
      }
      if (windowOn) this.windowLine++
    } else {
      this.frame.fill(0, row, row + WIDTH)
    }

    if (lcdc & 0x02) {
      const tall = (lcdc & 0x04) !== 0
      const height = tall ? 16 : 8
      // Up to ten sprites per line, in OAM order; the lower X wins overlaps.
      const onLine = []
      for (let i = 0; i < 40 && onLine.length < 10; i++) {
        const y = this.oam[i * 4] - 16
        if (ly >= y && ly < y + height) onLine.push(i)
      }
      onLine.sort((a, b) => this.oam[a * 4 + 1] - this.oam[b * 4 + 1] || a - b)
      const drawn = new Uint8Array(WIDTH)
      for (const i of onLine) {
        const y = this.oam[i * 4] - 16
        const x = this.oam[i * 4 + 1] - 8
        let tile = this.oam[i * 4 + 2]
        const flags = this.oam[i * 4 + 3]
        let line = ly - y
        if (flags & 0x40) line = height - 1 - line
        if (tall) tile &= 0xfe
        const addr = tile * 16 + line * 2
        const palette = flags & 0x10 ? this.io[0x49] : this.io[0x48]
        for (let px = 0; px < 8; px++) {
          const sx = x + px
          if (sx < 0 || sx >= WIDTH || drawn[sx]) continue
          const bit = flags & 0x20 ? px : 7 - px
          const color = (((this.vram[addr + 1] >> bit) & 1) << 1) | ((this.vram[addr] >> bit) & 1)
          if (color === 0) continue
          drawn[sx] = 1
          if (flags & 0x80 && bgIndex[sx] !== 0) continue
          this.frame[row + sx] = (palette >> (color * 2)) & 3
        }
      }
    }
  }

  // Runs until the next frame is finished (or a frame's worth of cycles
  // passed while the screen is off) and returns the frame's shade indexes.
  runFrame() {
    this.frameReady = false
    let budget = CYCLES_PER_LINE * LINES_PER_FRAME
    while (!this.frameReady && budget > 0) budget -= this.cpu.step()
    return this.frame
  }
}
