import { describe, expect, it } from 'vitest'
import { isAbandoningSpawnFlow } from './spawnFlowAbandonment'

describe('isAbandoningSpawnFlow', () => {
    it('is false while staying on the same leg (e.g. a search-param-only change)', () => {
        expect(isAbandoningSpawnFlow('/sessions/new', '/sessions/new', {}, {})).toBe(false)
        expect(isAbandoningSpawnFlow('/browse', '/browse', {}, {})).toBe(false)
    })

    it('is false crossing to the other leg when nothing is actually being tracked (no stash to leak)', () => {
        expect(isAbandoningSpawnFlow('/sessions/new', '/browse', {}, {})).toBe(false)
        expect(isAbandoningSpawnFlow('/browse', '/sessions/new', {}, {})).toBe(false)
    })

    it('is false crossing to the other leg when the destination carries the same briefingId forward (the real "Choose folder" round trip)', () => {
        expect(isAbandoningSpawnFlow('/sessions/new', '/browse', { briefingId: 'b1' }, { briefingId: 'b1' })).toBe(false)
        expect(isAbandoningSpawnFlow('/browse', '/sessions/new', { briefingId: 'b1' }, { briefingId: 'b1' })).toBe(false)
    })

    it('is false crossing to the other leg when the destination carries the same shareTransferId forward', () => {
        expect(isAbandoningSpawnFlow('/sessions/new', '/browse', { shareTransferId: 's1' }, { shareTransferId: 's1' })).toBe(false)
    })

    it('is true crossing to /browse when tracking a briefingId but the destination carries none — the sidebar\'s own unrelated global Browse button (Codex review)', () => {
        // Regression: this used to be pathname-only, treating ANY navigation
        // from /sessions/new to /browse as a continuation — including the
        // left sidebar's always-visible, unrelated "Browse" action, which
        // carries no transfer ids at all. That orphaned the briefing in
        // sessionStorage instead of cleaning it up.
        expect(isAbandoningSpawnFlow('/sessions/new', '/browse', { briefingId: 'b1' }, {})).toBe(true)
    })

    it('is true crossing to /browse when the destination carries a DIFFERENT briefingId (a stale one lingering in a toggled search)', () => {
        expect(isAbandoningSpawnFlow('/sessions/new', '/browse', { briefingId: 'b1' }, { briefingId: 'b2' })).toBe(true)
    })

    it('is true staying on the same pathname when the destination carries no tracked ids forward — the sidebar\'s own unrelated New Session button (Codex review, fourth pass)', () => {
        // Regression: an unconditional toPathname === fromPathname early
        // return treated the sidebar's "New Session" button (navigates to a
        // bare /sessions/new with no search params) as "staying in the
        // flow" whenever a board-spawn compose with a briefingId was already
        // open at that same pathname — orphaning the briefing instead of
        // cleaning it up, the exact same failure mode already fixed for the
        // cross-leg case but missed here.
        expect(isAbandoningSpawnFlow('/sessions/new', '/sessions/new', { briefingId: 'b1' }, {})).toBe(true)
    })

    it('is false staying on the same pathname when the destination carries the same briefingId forward (an in-flow search update)', () => {
        expect(isAbandoningSpawnFlow('/sessions/new', '/sessions/new', { briefingId: 'b1' }, { briefingId: 'b1' })).toBe(false)
    })

    it('is true for any other destination, including browser-history-driven navigation', () => {
        expect(isAbandoningSpawnFlow('/sessions/new', '/sessions', {}, {})).toBe(true)
        expect(isAbandoningSpawnFlow('/sessions/new', '/sessions/some-id', {}, {})).toBe(true)
        expect(isAbandoningSpawnFlow('/browse', '/sessions', {}, {})).toBe(true)
        expect(isAbandoningSpawnFlow('/browse', '/sessions/some-id', {}, {})).toBe(true)
        expect(isAbandoningSpawnFlow('/sessions/new', '/settings', {}, {})).toBe(true)
    })
})
