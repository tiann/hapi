import { describe, test, expect } from 'bun:test'
import {
    float32ToPcm16,
    pcm16ToFloat32,
    arrayBufferToBase64,
    base64ToArrayBuffer
} from './pcmUtils'

describe('pcmUtils', () => {
    describe('float32ToPcm16 / pcm16ToFloat32 round-trip', () => {
        test('preserves signal within quantization error', () => {
            const input = new Float32Array([0, 0.5, -0.5, 1.0, -1.0])
            const pcm16 = float32ToPcm16(input)
            const output = pcm16ToFloat32(pcm16)

            expect(output.length).toBe(input.length)
            for (let i = 0; i < input.length; i++) {
                expect(Math.abs(output[i] - input[i])).toBeLessThan(0.001)
            }
        })

        test('clamps values outside [-1, 1]', () => {
            const input = new Float32Array([2.0, -2.0])
            const pcm16 = float32ToPcm16(input)
            const output = pcm16ToFloat32(pcm16)

            expect(Math.abs(output[0] - 1.0)).toBeLessThan(0.001)
            expect(Math.abs(output[1] - (-1.0))).toBeLessThan(0.001)
        })

        test('handles empty input', () => {
            const input = new Float32Array(0)
            const pcm16 = float32ToPcm16(input)
            expect(pcm16.byteLength).toBe(0)
            const output = pcm16ToFloat32(pcm16)
            expect(output.length).toBe(0)
        })
    })

    describe('arrayBufferToBase64 / base64ToArrayBuffer round-trip', () => {
        test('preserves binary data', () => {
            const original = new Uint8Array([0, 1, 127, 128, 255])
            const base64 = arrayBufferToBase64(original.buffer)
            const restored = new Uint8Array(base64ToArrayBuffer(base64))

            expect(restored.length).toBe(original.length)
            for (let i = 0; i < original.length; i++) {
                expect(restored[i]).toBe(original[i])
            }
        })

        test('handles empty buffer', () => {
            const empty = new ArrayBuffer(0)
            const base64 = arrayBufferToBase64(empty)
            expect(base64).toBe('')
            const restored = base64ToArrayBuffer(base64)
            expect(restored.byteLength).toBe(0)
        })
    })
})
