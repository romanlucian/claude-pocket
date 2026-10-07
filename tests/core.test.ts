import { describe, expect, test } from 'claude-code/testing'

import { Machine } from '../core/machine.mjs'

// A 32 KB cartridge with battery RAM whose program enables the RAM, writes
// A001 = A000 + 1, then A000 = 0x42, and loops: a save loaded shows in A001.
function savingGame(): Uint8Array {
  const rom = new Uint8Array(0x8000)
  rom.set([0x00, 0xc3, 0x50, 0x01], 0x100) // nop; jp 0x150
  rom[0x147] = 0x03 // MBC1+RAM+BATTERY
  rom[0x149] = 0x02 // 8 KB of RAM
  rom.set(
    [0x3e, 0x0a, 0xea, 0x00, 0x00, 0xfa, 0x00, 0xa0, 0x3c, 0xea, 0x01, 0xa0, 0x3e, 0x42, 0xea, 0x00, 0xa0, 0x18, 0xfe],
    0x150,
  )
  return rom
}

// A cartridge that plays a note on the first square channel, then loops.
function beepingGame(): Uint8Array {
  const rom = new Uint8Array(0x8000)
  rom.set([0x00, 0xc3, 0x50, 0x01], 0x100)
  rom.set(
    [
      0x3e, 0x80, 0xe0, 0x11, // ld a,0x80 ; ldh (NR11),a   duty 50%
      0x3e, 0xf0, 0xe0, 0x12, // ld a,0xf0 ; ldh (NR12),a   full volume
      0x3e, 0x00, 0xe0, 0x13, // ld a,0x00 ; ldh (NR13),a
      0x3e, 0x87, 0xe0, 0x14, // ld a,0x87 ; ldh (NR14),a   trigger
      0x18, 0xfe, // jr -2
    ],
    0x150,
  )
  return rom
}

describe('the console', () => {
  test('keeps a game save and loads it back', () => {
    const first = new Machine(savingGame())
    expect(first.hasSave).toBe(true)
    first.runFrame()
    const save = first.takeSave()
    expect(save?.length).toBe(0x2000)
    expect([save?.[0], save?.[1]]).toEqual([0x42, 0x01])
    // Nothing changed since: nothing new to write.
    first.runFrame()
    expect(first.takeSave()).toBeNull()

    const second = new Machine(savingGame())
    second.loadSave(save ?? new Uint8Array(0))
    second.runFrame()
    expect([...(second.takeSave() ?? new Uint8Array(2)).subarray(0, 2)]).toEqual([0x42, 0x43])
  })

  test('a game without a battery has no save', () => {
    const rom = savingGame()
    rom[0x147] = 0x02 // MBC1+RAM, no battery
    expect(new Machine(rom).hasSave).toBe(false)
  })

  test('makes sound: a note on the first channel', () => {
    const machine = new Machine(beepingGame())
    // The first frame ends at the first vertical blank: measure the second.
    machine.runFrame()
    machine.apu.take()
    machine.runFrame()
    const samples: Int16Array = machine.apu.take()
    // About a frame of stereo samples at 32768 a second, and not silence.
    expect(Math.abs(samples.length / 2 - 32768 / 59.7275)).toBeLessThan(10)
    expect(Math.max(...samples.map(Math.abs))).toBeGreaterThan(1000)
    expect(machine.read8(0xff26) & 0x81).toBe(0x81) // powered, channel 1 on
  })
})
