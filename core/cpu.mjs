// The handheld's processor (a Sharp LR35902, a Z80 cousin): registers,
// flags, every opcode and the CB-prefixed ones, interrupts and HALT.
// `bus` is the memory map (read8/write8) plus `tick(cycles)`, which
// advances the timer and the picture by the cycles each instruction takes.

const Z = 0x80
const N = 0x40
const H = 0x20
const C = 0x10

export class Cpu {
  constructor(bus) {
    this.bus = bus
    this.reset()
  }

  // The state the boot ROM leaves behind on an original model, so games
  // start without one.
  reset() {
    this.a = 0x01
    this.f = 0xb0
    this.b = 0x00
    this.c = 0x13
    this.d = 0x00
    this.e = 0xd8
    this.h = 0x01
    this.l = 0x4d
    this.sp = 0xfffe
    this.pc = 0x0100
    this.ime = false
    this.imeNext = false
    this.halted = false
  }

  get bc() { return (this.b << 8) | this.c }
  set bc(v) { this.b = (v >> 8) & 0xff; this.c = v & 0xff }
  get de() { return (this.d << 8) | this.e }
  set de(v) { this.d = (v >> 8) & 0xff; this.e = v & 0xff }
  get hl() { return (this.h << 8) | this.l }
  set hl(v) { this.h = (v >> 8) & 0xff; this.l = v & 0xff }
  get af() { return (this.a << 8) | this.f }
  set af(v) { this.a = (v >> 8) & 0xff; this.f = v & 0xf0 }

  fetch8() {
    const v = this.bus.read8(this.pc)
    this.pc = (this.pc + 1) & 0xffff
    return v
  }

  fetch16() {
    const lo = this.fetch8()
    return lo | (this.fetch8() << 8)
  }

  push(v) {
    this.sp = (this.sp - 1) & 0xffff
    this.bus.write8(this.sp, (v >> 8) & 0xff)
    this.sp = (this.sp - 1) & 0xffff
    this.bus.write8(this.sp, v & 0xff)
  }

  pop() {
    const lo = this.bus.read8(this.sp)
    this.sp = (this.sp + 1) & 0xffff
    const hi = this.bus.read8(this.sp)
    this.sp = (this.sp + 1) & 0xffff
    return lo | (hi << 8)
  }

  flag(mask) { return (this.f & mask) !== 0 }

  setFlags(z, n, h, c) {
    this.f = (z ? Z : 0) | (n ? N : 0) | (h ? H : 0) | (c ? C : 0)
  }

  // Registers by their 3-bit opcode index: B C D E H L (HL) A.
  getR(i) {
    switch (i) {
      case 0: return this.b
      case 1: return this.c
      case 2: return this.d
      case 3: return this.e
      case 4: return this.h
      case 5: return this.l
      case 6: return this.bus.read8(this.hl)
      default: return this.a
    }
  }

  setR(i, v) {
    v &= 0xff
    switch (i) {
      case 0: this.b = v; break
      case 1: this.c = v; break
      case 2: this.d = v; break
      case 3: this.e = v; break
      case 4: this.h = v; break
      case 5: this.l = v; break
      case 6: this.bus.write8(this.hl, v); break
      default: this.a = v
    }
  }

  // Register pairs by their 2-bit index: BC DE HL SP.
  getRR(i) {
    switch (i) {
      case 0: return this.bc
      case 1: return this.de
      case 2: return this.hl
      default: return this.sp
    }
  }

  setRR(i, v) {
    v &= 0xffff
    switch (i) {
      case 0: this.bc = v; break
      case 1: this.de = v; break
      case 2: this.hl = v; break
      default: this.sp = v
    }
  }

  cond(i) {
    switch (i) {
      case 0: return !this.flag(Z)
      case 1: return this.flag(Z)
      case 2: return !this.flag(C)
      default: return this.flag(C)
    }
  }

  // The eight ALU operations on A, by their 3-bit index.
  alu(op, v) {
    const a = this.a
    switch (op) {
      case 0: { // ADD
        const r = a + v
        this.setFlags((r & 0xff) === 0, false, (a & 0xf) + (v & 0xf) > 0xf, r > 0xff)
        this.a = r & 0xff
        break
      }
      case 1: { // ADC
        const c = this.flag(C) ? 1 : 0
        const r = a + v + c
        this.setFlags((r & 0xff) === 0, false, (a & 0xf) + (v & 0xf) + c > 0xf, r > 0xff)
        this.a = r & 0xff
        break
      }
      case 2: { // SUB
        const r = a - v
        this.setFlags((r & 0xff) === 0, true, (a & 0xf) < (v & 0xf), r < 0)
        this.a = r & 0xff
        break
      }
      case 3: { // SBC
        const c = this.flag(C) ? 1 : 0
        const r = a - v - c
        this.setFlags((r & 0xff) === 0, true, (a & 0xf) - (v & 0xf) - c < 0, r < 0)
        this.a = r & 0xff
        break
      }
      case 4: // AND
        this.a = a & v
        this.setFlags(this.a === 0, false, true, false)
        break
      case 5: // XOR
        this.a = (a ^ v) & 0xff
        this.setFlags(this.a === 0, false, false, false)
        break
      case 6: // OR
        this.a = (a | v) & 0xff
        this.setFlags(this.a === 0, false, false, false)
        break
      default: { // CP
        const r = a - v
        this.setFlags((r & 0xff) === 0, true, (a & 0xf) < (v & 0xf), r < 0)
      }
    }
  }

  inc8(v) {
    const r = (v + 1) & 0xff
    this.f = (this.f & C) | (r === 0 ? Z : 0) | ((v & 0xf) === 0xf ? H : 0)
    return r
  }

  dec8(v) {
    const r = (v - 1) & 0xff
    this.f = (this.f & C) | N | (r === 0 ? Z : 0) | ((v & 0xf) === 0 ? H : 0)
    return r
  }

  addHL(v) {
    const hl = this.hl
    const r = hl + v
    this.f = (this.f & Z) | ((hl & 0xfff) + (v & 0xfff) > 0xfff ? H : 0) | (r > 0xffff ? C : 0)
    this.hl = r & 0xffff
  }

  // SP plus a signed byte, as ADD SP,e and LD HL,SP+e compute it.
  spPlus(e) {
    const s = e > 127 ? e - 256 : e
    const r = (this.sp + s) & 0xffff
    this.setFlags(false, false, (this.sp & 0xf) + (e & 0xf) > 0xf, (this.sp & 0xff) + (e & 0xff) > 0xff)
    return r
  }

  daa() {
    let a = this.a
    let adjust = 0
    let carry = this.flag(C)
    if (this.flag(H) || (!this.flag(N) && (a & 0xf) > 9)) adjust |= 0x06
    if (carry || (!this.flag(N) && a > 0x99)) {
      adjust |= 0x60
      carry = true
    }
    a = this.flag(N) ? a - adjust : a + adjust
    a &= 0xff
    this.f = (a === 0 ? Z : 0) | (this.f & N) | (carry ? C : 0)
    this.a = a
  }

  // CB-prefixed: rotates, shifts, SWAP, BIT, RES, SET.
  cb() {
    const op = this.fetch8()
    const r = op & 7
    const v = this.getR(r)
    const x = op >> 6
    const y = (op >> 3) & 7
    if (x === 1) { // BIT
      this.f = (this.f & C) | H | ((v & (1 << y)) === 0 ? Z : 0)
      return r === 6 ? 12 : 8
    }
    if (x === 2) { // RES
      this.setR(r, v & ~(1 << y))
      return r === 6 ? 16 : 8
    }
    if (x === 3) { // SET
      this.setR(r, v | (1 << y))
      return r === 6 ? 16 : 8
    }
    let res
    let carry
    switch (y) {
      case 0: carry = v >> 7; res = (v << 1) | carry; break // RLC
      case 1: carry = v & 1; res = (v >> 1) | (carry << 7); break // RRC
      case 2: carry = v >> 7; res = (v << 1) | (this.flag(C) ? 1 : 0); break // RL
      case 3: carry = v & 1; res = (v >> 1) | (this.flag(C) ? 0x80 : 0); break // RR
      case 4: carry = v >> 7; res = v << 1; break // SLA
      case 5: carry = v & 1; res = (v >> 1) | (v & 0x80); break // SRA
      case 6: carry = 0; res = ((v & 0xf) << 4) | (v >> 4); break // SWAP
      default: carry = v & 1; res = v >> 1 // SRL
    }
    res &= 0xff
    this.setFlags(res === 0, false, false, carry === 1)
    this.setR(r, res)
    return r === 6 ? 16 : 8
  }

  // Runs one instruction (or one idle step while halted), servicing an
  // interrupt first when one is due; returns the cycles taken.
  step() {
    const bus = this.bus
    const pending = bus.ie & bus.if & 0x1f
    if (pending !== 0) {
      this.halted = false
      if (this.ime) {
        this.ime = false
        const bit = 31 - Math.clz32(pending & -pending)
        bus.if &= ~(1 << bit)
        this.push(this.pc)
        this.pc = 0x40 + bit * 8
        bus.tick(20)
        return 20
      }
    }
    if (this.halted) {
      bus.tick(4)
      return 4
    }
    if (this.imeNext) {
      this.imeNext = false
      this.ime = true
    }
    const cycles = this.execute(this.fetch8())
    bus.tick(cycles)
    return cycles
  }

  execute(op) {
    // LD r,r' (and HALT at 0x76)
    if (op >= 0x40 && op < 0x80) {
      if (op === 0x76) {
        this.halted = true
        return 4
      }
      const dst = (op >> 3) & 7
      const src = op & 7
      this.setR(dst, this.getR(src))
      return dst === 6 || src === 6 ? 8 : 4
    }
    // ALU A,r
    if (op >= 0x80 && op < 0xc0) {
      const src = op & 7
      this.alu((op >> 3) & 7, this.getR(src))
      return src === 6 ? 8 : 4
    }

    switch (op) {
      case 0x00: return 4 // NOP
      case 0x10: this.fetch8(); return 4 // STOP
      case 0x01: case 0x11: case 0x21: case 0x31:
        this.setRR(op >> 4, this.fetch16())
        return 12
      case 0x02: this.bus.write8(this.bc, this.a); return 8
      case 0x12: this.bus.write8(this.de, this.a); return 8
      case 0x22: this.bus.write8(this.hl, this.a); this.hl = this.hl + 1; return 8
      case 0x32: this.bus.write8(this.hl, this.a); this.hl = this.hl - 1; return 8
      case 0x0a: this.a = this.bus.read8(this.bc); return 8
      case 0x1a: this.a = this.bus.read8(this.de); return 8
      case 0x2a: this.a = this.bus.read8(this.hl); this.hl = this.hl + 1; return 8
      case 0x3a: this.a = this.bus.read8(this.hl); this.hl = this.hl - 1; return 8
      case 0x03: case 0x13: case 0x23: case 0x33:
        this.setRR(op >> 4, this.getRR(op >> 4) + 1)
        return 8
      case 0x0b: case 0x1b: case 0x2b: case 0x3b:
        this.setRR(op >> 4, this.getRR(op >> 4) - 1)
        return 8
      case 0x09: case 0x19: case 0x29: case 0x39:
        this.addHL(this.getRR(op >> 4))
        return 8
      case 0x04: case 0x0c: case 0x14: case 0x1c: case 0x24: case 0x2c: case 0x34: case 0x3c: {
        const r = (op >> 3) & 7
        this.setR(r, this.inc8(this.getR(r)))
        return r === 6 ? 12 : 4
      }
      case 0x05: case 0x0d: case 0x15: case 0x1d: case 0x25: case 0x2d: case 0x35: case 0x3d: {
        const r = (op >> 3) & 7
        this.setR(r, this.dec8(this.getR(r)))
        return r === 6 ? 12 : 4
      }
      case 0x06: case 0x0e: case 0x16: case 0x1e: case 0x26: case 0x2e: case 0x36: case 0x3e: {
        const r = (op >> 3) & 7
        this.setR(r, this.fetch8())
        return r === 6 ? 12 : 8
      }
      case 0x07: { // RLCA
        const c = this.a >> 7
        this.a = ((this.a << 1) | c) & 0xff
        this.setFlags(false, false, false, c === 1)
        return 4
      }
      case 0x0f: { // RRCA
        const c = this.a & 1
        this.a = (this.a >> 1) | (c << 7)
        this.setFlags(false, false, false, c === 1)
        return 4
      }
      case 0x17: { // RLA
        const c = this.a >> 7
        this.a = ((this.a << 1) | (this.flag(C) ? 1 : 0)) & 0xff
        this.setFlags(false, false, false, c === 1)
        return 4
      }
      case 0x1f: { // RRA
        const c = this.a & 1
        this.a = (this.a >> 1) | (this.flag(C) ? 0x80 : 0)
        this.setFlags(false, false, false, c === 1)
        return 4
      }
      case 0x08: { // LD (a16),SP
        const addr = this.fetch16()
        this.bus.write8(addr, this.sp & 0xff)
        this.bus.write8((addr + 1) & 0xffff, this.sp >> 8)
        return 20
      }
      case 0x18: { // JR e
        const e = this.fetch8()
        this.pc = (this.pc + (e > 127 ? e - 256 : e)) & 0xffff
        return 12
      }
      case 0x20: case 0x28: case 0x30: case 0x38: {
        const e = this.fetch8()
        if (this.cond((op >> 3) & 3)) {
          this.pc = (this.pc + (e > 127 ? e - 256 : e)) & 0xffff
          return 12
        }
        return 8
      }
      case 0x27: this.daa(); return 4
      case 0x2f: this.a ^= 0xff; this.f |= N | H; return 4 // CPL
      case 0x37: this.f = (this.f & Z) | C; return 4 // SCF
      case 0x3f: this.f = (this.f & Z) | (this.flag(C) ? 0 : C); return 4 // CCF

      case 0xc0: case 0xc8: case 0xd0: case 0xd8:
        if (this.cond((op >> 3) & 3)) {
          this.pc = this.pop()
          return 20
        }
        return 8
      case 0xc9: this.pc = this.pop(); return 16 // RET
      case 0xd9: this.pc = this.pop(); this.ime = true; return 16 // RETI
      case 0xc1: this.bc = this.pop(); return 12
      case 0xd1: this.de = this.pop(); return 12
      case 0xe1: this.hl = this.pop(); return 12
      case 0xf1: this.af = this.pop(); return 12
      case 0xc5: this.push(this.bc); return 16
      case 0xd5: this.push(this.de); return 16
      case 0xe5: this.push(this.hl); return 16
      case 0xf5: this.push(this.af); return 16
      case 0xc2: case 0xca: case 0xd2: case 0xda: {
        const addr = this.fetch16()
        if (this.cond((op >> 3) & 3)) {
          this.pc = addr
          return 16
        }
        return 12
      }
      case 0xc3: this.pc = this.fetch16(); return 16
      case 0xe9: this.pc = this.hl; return 4
      case 0xc4: case 0xcc: case 0xd4: case 0xdc: {
        const addr = this.fetch16()
        if (this.cond((op >> 3) & 3)) {
          this.push(this.pc)
          this.pc = addr
          return 24
        }
        return 12
      }
      case 0xcd: {
        const addr = this.fetch16()
        this.push(this.pc)
        this.pc = addr
        return 24
      }
      case 0xc7: case 0xcf: case 0xd7: case 0xdf: case 0xe7: case 0xef: case 0xf7: case 0xff:
        this.push(this.pc)
        this.pc = op & 0x38
        return 16
      case 0xc6: case 0xce: case 0xd6: case 0xde: case 0xe6: case 0xee: case 0xf6: case 0xfe:
        this.alu((op >> 3) & 7, this.fetch8())
        return 8
      case 0xcb: return this.cb()
      case 0xe0: this.bus.write8(0xff00 | this.fetch8(), this.a); return 12
      case 0xf0: this.a = this.bus.read8(0xff00 | this.fetch8()); return 12
      case 0xe2: this.bus.write8(0xff00 | this.c, this.a); return 8
      case 0xf2: this.a = this.bus.read8(0xff00 | this.c); return 8
      case 0xea: this.bus.write8(this.fetch16(), this.a); return 16
      case 0xfa: this.a = this.bus.read8(this.fetch16()); return 16
      case 0xe8: this.sp = this.spPlus(this.fetch8()); return 16
      case 0xf8: this.hl = this.spPlus(this.fetch8()); return 12
      case 0xf9: this.sp = this.hl; return 8
      case 0xf3: this.ime = false; this.imeNext = false; return 4 // DI
      case 0xfb: this.imeNext = true; return 4 // EI
      default:
        // The unused opcodes lock a real console; carry on as a NOP.
        return 4
    }
  }
}
