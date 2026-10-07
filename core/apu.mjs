// The handheld's sound: two square-wave channels (the first with a pitch
// sweep), a wave channel playing 32 four-bit samples, and a noise channel,
// mixed to stereo by NR50/NR51. Registers FF10-FF3F.
//
// The chip is stepped with the CPU's cycles and sampled every 128 of them:
// 32768 stereo samples a second, as 16-bit numbers, which `take()` hands out.

export const SAMPLE_RATE = 32768
const CYCLES_PER_SAMPLE = 128 // 4194304 Hz / 32768
const CYCLES_PER_STEP = 8192 // the frame sequencer runs at 512 Hz

const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
]
const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112]
// The bits a read always returns set, FF10-FF2F.
const READ_MASK = [
  0x80, 0x3f, 0x00, 0xff, 0xbf, 0xff, 0x3f, 0x00, 0xff, 0xbf, 0x7f, 0xff, 0x9f, 0xff, 0xbf, 0xff,
  0xff, 0x00, 0x00, 0xbf, 0x00, 0x00, 0x70, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
]

class Channel {
  constructor(lengthMax) {
    this.lengthMax = lengthMax
    this.isOn = false
    this.isDacOn = false
    this.length = 0
    this.isLengthOn = false
    this.timer = 0
  }

  clockLength() {
    if (this.isLengthOn && this.length > 0 && --this.length === 0) this.isOn = false
  }

  // NRx4. `isFirstHalf`: the sequencer's next step does not clock lengths,
  // where turning the length on, or a trigger, clocks it once more at once.
  writeControl(v, isFirstHalf) {
    const wasLengthOn = this.isLengthOn
    this.isLengthOn = (v & 0x40) !== 0
    if (isFirstHalf && !wasLengthOn && this.isLengthOn && this.length > 0 && --this.length === 0 && !(v & 0x80)) {
      this.isOn = false
    }
    if (v & 0x80) {
      const wasZero = this.length === 0
      this.trigger()
      if (wasZero && this.isLengthOn && isFirstHalf) this.length--
    }
  }
}

// What square and noise channels share: the volume envelope.
class Enveloped extends Channel {
  constructor(lengthMax) {
    super(lengthMax)
    this.envelope = 0 // NRx2
    this.volume = 0
    this.envelopeTimer = 0
  }

  setEnvelope(v) {
    this.envelope = v
    this.isDacOn = (v & 0xf8) !== 0
    if (!this.isDacOn) this.isOn = false
  }

  clockEnvelope() {
    const period = this.envelope & 7
    if (period === 0) return
    if (--this.envelopeTimer > 0) return
    this.envelopeTimer = period
    if (this.envelope & 0x08) {
      if (this.volume < 15) this.volume++
    } else if (this.volume > 0) {
      this.volume--
    }
  }

  triggerEnvelope() {
    this.volume = this.envelope >> 4
    this.envelopeTimer = this.envelope & 7 || 8
  }
}

class Square extends Enveloped {
  constructor(hasSweep) {
    super(64)
    this.hasSweep = hasSweep
    this.duty = 0
    this.step = 0
    this.frequency = 0
    this.sweep = 0 // NR10
    this.sweepTimer = 0
    this.isSweepOn = false
    this.shadow = 0
    // A calculation subtracted since the trigger: leaving negate mode then
    // turns the channel off.
    this.hasNegated = false
  }

  setSweep(v) {
    if (this.hasNegated && this.sweep & 0x08 && !(v & 0x08)) this.isOn = false
    this.sweep = v
  }

  period() {
    return (2048 - this.frequency) * 4
  }

  run(cycles) {
    this.timer -= cycles
    while (this.timer <= 0) {
      this.timer += this.period()
      this.step = (this.step + 1) & 7
    }
  }

  output() {
    return this.isOn && this.isDacOn ? DUTY[this.duty][this.step] * this.volume : 0
  }

  // The swept frequency, turning the channel off past the top.
  nextFrequency() {
    const change = this.shadow >> (this.sweep & 7)
    if (this.sweep & 0x08) this.hasNegated = true
    const next = this.sweep & 0x08 ? this.shadow - change : this.shadow + change
    if (next > 2047) this.isOn = false
    return next
  }

  clockSweep() {
    if (--this.sweepTimer > 0) return
    const period = (this.sweep >> 4) & 7
    this.sweepTimer = period || 8
    if (!this.isSweepOn || period === 0) return
    const next = this.nextFrequency()
    if (next <= 2047 && (this.sweep & 7) !== 0) {
      this.frequency = this.shadow = next
      this.nextFrequency()
    }
  }

  trigger() {
    this.isOn = this.isDacOn
    if (this.length === 0) this.length = this.lengthMax
    this.timer = this.period()
    this.triggerEnvelope()
    if (this.hasSweep) {
      this.hasNegated = false
      this.shadow = this.frequency
      const period = (this.sweep >> 4) & 7
      this.sweepTimer = period || 8
      this.isSweepOn = period !== 0 || (this.sweep & 7) !== 0
      if (this.sweep & 7) this.nextFrequency()
    }
  }
}

class Wave extends Channel {
  constructor(ram) {
    super(256)
    this.ram = ram
    this.frequency = 0
    this.position = 0
    this.shift = 4 // NR32: 4 is silent, 0 full, 1 half, 2 a quarter
  }

  run(cycles) {
    this.timer -= cycles
    while (this.timer <= 0) {
      this.timer += (2048 - this.frequency) * 2
      this.position = (this.position + 1) & 31
    }
  }

  output() {
    if (!this.isOn || !this.isDacOn) return 0
    const byte = this.ram[this.position >> 1]
    const sample = this.position & 1 ? byte & 0x0f : byte >> 4
    return sample >> this.shift
  }

  trigger() {
    this.isOn = this.isDacOn
    if (this.length === 0) this.length = this.lengthMax
    this.timer = (2048 - this.frequency) * 2
    this.position = 0
  }
}

class Noise extends Enveloped {
  constructor() {
    super(64)
    this.control = 0 // NR43
    this.lfsr = 0x7fff
  }

  period() {
    return NOISE_DIVISORS[this.control & 7] << (this.control >> 4)
  }

  run(cycles) {
    this.timer -= cycles
    while (this.timer <= 0) {
      this.timer += this.period()
      const bit = (this.lfsr ^ (this.lfsr >> 1)) & 1
      this.lfsr = (this.lfsr >> 1) | (bit << 14)
      if (this.control & 0x08) this.lfsr = (this.lfsr & ~0x40) | (bit << 6)
    }
  }

  output() {
    return this.isOn && this.isDacOn && (this.lfsr & 1) === 0 ? this.volume : 0
  }

  trigger() {
    this.isOn = this.isDacOn
    if (this.length === 0) this.length = this.lengthMax
    this.timer = this.period()
    this.triggerEnvelope()
    this.lfsr = 0x7fff
  }
}

export class Apu {
  constructor() {
    this.regs = new Uint8Array(0x20) // FF10-FF2F as written
    this.waveRam = new Uint8Array(16) // FF30-FF3F
    this.square1 = new Square(true)
    this.square2 = new Square(false)
    this.wave = new Wave(this.waveRam)
    this.noise = new Noise()
    this.channels = [this.square1, this.square2, this.wave, this.noise]
    this.isPowered = true
    this.sequencerCycles = 0
    this.sequencerStep = 0
    this.sampleCycles = 0
    // Samples made since the last take(): left, right, left, right…
    this.buffer = new Int16Array(SAMPLE_RATE) // a second's room
    this.count = 0
    // Each side's DC blocker (the console's own capacitor).
    this.capLeft = 0
    this.capRight = 0
    // As the boot program leaves them.
    this.regs[0x14] = 0x77 // NR50
    this.regs[0x15] = 0xf3 // NR51
  }

  read(r) {
    if (r >= 0x20) return this.waveRam[r - 0x20]
    if (r === 0x16) {
      let status = this.isPowered ? 0x80 : 0
      this.channels.forEach((channel, i) => (status |= channel.isOn ? 1 << i : 0))
      return status | READ_MASK[r]
    }
    return this.regs[r] | READ_MASK[r]
  }

  // `r` is the register's offset from FF10.
  write(r, v) {
    if (r >= 0x20) {
      this.waveRam[r - 0x20] = v
      return
    }
    if (r === 0x16) {
      const isPowered = (v & 0x80) !== 0
      if (!isPowered && this.isPowered) {
        // Power off clears every register; the wave RAM and the length
        // counters stay.
        const lengths = this.channels.map(channel => channel.length)
        for (let i = 0; i < 0x16; i++) this.write(i, 0)
        this.channels.forEach((channel, i) => {
          channel.isOn = false
          channel.length = lengths[i]
        })
      }
      if (isPowered && !this.isPowered) this.sequencerStep = 0
      this.isPowered = isPowered
      return
    }
    const [s1, s2, wave, noise] = this.channels
    if (!this.isPowered) {
      // Off, only the length counters can be written.
      if (r === 0x01) s1.length = 64 - (v & 0x3f)
      else if (r === 0x06) s2.length = 64 - (v & 0x3f)
      else if (r === 0x0b) wave.length = 256 - v
      else if (r === 0x10) noise.length = 64 - (v & 0x3f)
      return
    }
    this.regs[r] = v
    const isFirstHalf = (this.sequencerStep & 1) === 1
    switch (r) {
      case 0x00: s1.setSweep(v); break
      case 0x01: s1.duty = v >> 6; s1.length = 64 - (v & 0x3f); break
      case 0x02: s1.setEnvelope(v); break
      case 0x03: s1.frequency = (s1.frequency & 0x700) | v; break
      case 0x04:
        s1.frequency = (s1.frequency & 0xff) | ((v & 7) << 8)
        s1.writeControl(v, isFirstHalf)
        break
      case 0x06: s2.duty = v >> 6; s2.length = 64 - (v & 0x3f); break
      case 0x07: s2.setEnvelope(v); break
      case 0x08: s2.frequency = (s2.frequency & 0x700) | v; break
      case 0x09:
        s2.frequency = (s2.frequency & 0xff) | ((v & 7) << 8)
        s2.writeControl(v, isFirstHalf)
        break
      case 0x0a:
        wave.isDacOn = (v & 0x80) !== 0
        if (!wave.isDacOn) wave.isOn = false
        break
      case 0x0b: wave.length = 256 - v; break
      case 0x0c: wave.shift = [4, 0, 1, 2][(v >> 5) & 3]; break
      case 0x0d: wave.frequency = (wave.frequency & 0x700) | v; break
      case 0x0e:
        wave.frequency = (wave.frequency & 0xff) | ((v & 7) << 8)
        wave.writeControl(v, isFirstHalf)
        break
      case 0x10: noise.length = 64 - (v & 0x3f); break
      case 0x11: noise.setEnvelope(v); break
      case 0x12: noise.control = v; break
      case 0x13:
        noise.writeControl(v, isFirstHalf)
        break
    }
  }

  clockSequencer() {
    const step = this.sequencerStep
    this.sequencerStep = (step + 1) & 7
    if ((step & 1) === 0) for (const channel of this.channels) channel.clockLength()
    if (step === 2 || step === 6) this.square1.clockSweep()
    if (step === 7) {
      this.square1.clockEnvelope()
      this.square2.clockEnvelope()
      this.noise.clockEnvelope()
    }
  }

  // Steps the chip `cycles` CPU cycles on, sampling as it goes.
  tick(cycles) {
    if (!this.isPowered) {
      this.sampleCycles += cycles
      while (this.sampleCycles >= CYCLES_PER_SAMPLE) {
        this.sampleCycles -= CYCLES_PER_SAMPLE
        this.push(0, 0)
      }
      return
    }
    while (cycles > 0) {
      // Run up to the next sample or sequencer step, whichever is sooner.
      const toSample = CYCLES_PER_SAMPLE - this.sampleCycles
      const toStep = CYCLES_PER_STEP - this.sequencerCycles
      const run = Math.min(cycles, toSample, toStep)
      for (const channel of this.channels) channel.run(run)
      cycles -= run
      this.sampleCycles += run
      this.sequencerCycles += run
      if (this.sequencerCycles >= CYCLES_PER_STEP) {
        this.sequencerCycles = 0
        this.clockSequencer()
      }
      if (this.sampleCycles >= CYCLES_PER_SAMPLE) {
        this.sampleCycles = 0
        this.mix()
      }
    }
  }

  mix() {
    const panning = this.regs[0x15]
    const volumes = this.regs[0x14]
    let left = 0
    let right = 0
    for (let i = 0; i < 4; i++) {
      const channel = this.channels[i]
      if (!channel.isDacOn) continue
      // The DAC: 0-15 to -1..1.
      const level = channel.output() / 7.5 - 1
      if (panning & (0x10 << i)) left += level
      if (panning & (1 << i)) right += level
    }
    left *= (((volumes >> 4) & 7) + 1) / 8
    right *= ((volumes & 7) + 1) / 8
    // Block the DC the DACs leave, as the console's capacitor does.
    const outLeft = left - this.capLeft
    this.capLeft = left - outLeft * 0.995
    const outRight = right - this.capRight
    this.capRight = right - outRight * 0.995
    this.push(outLeft, outRight)
  }

  push(left, right) {
    if (this.count + 2 > this.buffer.length) return // nobody takes them: drop
    // Four channels add up to ±4 at most: that, with headroom, is full scale.
    this.buffer[this.count++] = Math.max(-32767, Math.min(32767, Math.round(left * 6000)))
    this.buffer[this.count++] = Math.max(-32767, Math.min(32767, Math.round(right * 6000)))
  }

  /** The samples made since the last call (interleaved stereo), and forgets them. */
  take() {
    const samples = this.buffer.slice(0, this.count)
    this.count = 0
    return samples
  }
}
