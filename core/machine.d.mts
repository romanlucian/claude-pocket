// Types for the plain-JavaScript console, as the tests use it.
export const WIDTH: 160
export const HEIGHT: 144
export const SHADES: readonly number[]
export const BUTTONS: readonly string[]

export class Machine {
  constructor(rom: Uint8Array)
  readonly title: string
  readonly frame: Uint8Array
  readonly hasSave: boolean
  readonly apu: { take(): Int16Array }
  runFrame(): Uint8Array
  setButton(name: string, isDown: boolean): void
  read8(addr: number): number
  takeSave(): Uint8Array | null
  loadSave(bytes: Uint8Array): void
}
