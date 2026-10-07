// Uint8Array base64 (ES2026), which the mod's environment has but older
// TypeScript libs do not declare.
interface Uint8Array {
  toBase64(): string
}
interface Uint8ArrayConstructor {
  fromBase64(text: string): Uint8Array
}
