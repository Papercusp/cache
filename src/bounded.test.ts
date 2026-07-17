import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Cache } from './cache';
import { getOrSetBounded } from './bounded';

/** A controllable factory: counts calls, resolves/rejects on demand. */
function controlled<V>(defaultValue: V) {
  let calls = 0;
  const releases: Array<{ resolve: (v: V) => void; reject: (e: Error) => void }> = [];
  const factory = (): Promise<V> => {
    calls += 1;
    return new Promise<V>((resolve, reject) => {
      releases.push({ resolve, reject });
    });
  };
  return {
    factory,
    calls: () => calls,
    resolveAll: (v: V = defaultValue) => {
      for (const r of releases.splice(0)) r.resolve(v);
    },
    rejectAll: (e: Error) => {
      for (const r of releases.splice(0)) r.reject(e);
    },
  };
}

describe('getOrSetBounded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves ok with the built value when the factory beats the deadline', async () => {
    const cache = new Cache();
    const c = controlled('V');
    const p = getOrSetBounded(cache, 'ws', 'k', c.factory, { deadlineMs: 1000 });
    c.resolveAll();
    await expect(p).resolves.toEqual({ ok: true, value: 'V' });
    expect(c.calls()).toBe(1);
  });

  it('a fresh hit resolves immediately without re-running the factory', async () => {
    const cache = new Cache();
    const c = controlled('V');
    const p = getOrSetBounded(cache, 'ws', 'k', c.factory, { deadlineMs: 1000, softTtlMs: 60_000 });
    c.resolveAll();
    await p;
    await expect(
      getOrSetBounded(cache, 'ws', 'k', c.factory, { deadlineMs: 1000, softTtlMs: 60_000 }),
    ).resolves.toEqual({ ok: true, value: 'V' });
    expect(c.calls()).toBe(1);
  });

  it('a cold miss past the deadline returns reason:deadline; the build lands for the next caller', async () => {
    const cache = new Cache();
    const c = controlled('LATE');
    const p = getOrSetBounded(cache, 'ws', 'k', c.factory, { deadlineMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    await expect(p).resolves.toEqual({ ok: false, reason: 'deadline' });
    expect(c.calls()).toBe(1);

    c.resolveAll();
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      getOrSetBounded(cache, 'ws', 'k', c.factory, { deadlineMs: 1000, softTtlMs: 60_000 }),
    ).resolves.toEqual({ ok: true, value: 'LATE' });
    expect(c.calls()).toBe(1);
  });

  it('a factory rejection resolves reason:error with the error attached (never rejects)', async () => {
    const cache = new Cache();
    const c = controlled('V');
    const boom = new Error('boom');
    const p = getOrSetBounded(cache, 'ws', 'k', c.factory, { deadlineMs: 1000 });
    c.rejectAll(boom);
    await expect(p).resolves.toEqual({ ok: false, reason: 'error', error: boom });
  });

  it('an abandoned build that later REJECTS is detached (no unhandled rejection)', async () => {
    const cache = new Cache();
    const c = controlled('V');
    const p = getOrSetBounded(cache, 'ws', 'k', c.factory, { deadlineMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    await expect(p).resolves.toEqual({ ok: false, reason: 'deadline' });
    // The late rejection must be swallowed by the detach — vitest fails the
    // test on an unhandled rejection, so settling cleanly IS the assertion.
    c.rejectAll(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('softTtlMs 0 serves stale immediately and revalidates in the background', async () => {
    const cache = new Cache();
    const c1 = controlled('V1');
    const p1 = getOrSetBounded(cache, 'ws', 'k', c1.factory, { deadlineMs: 1000, softTtlMs: 0 });
    c1.resolveAll();
    await expect(p1).resolves.toEqual({ ok: true, value: 'V1' });

    const c2 = controlled('V2');
    // Stale serve is instant — the deadline never comes into play.
    await expect(
      getOrSetBounded(cache, 'ws', 'k', c2.factory, { deadlineMs: 1000, softTtlMs: 0 }),
    ).resolves.toEqual({ ok: true, value: 'V1' });
    expect(c2.calls()).toBe(1); // background revalidate kicked off
    c2.resolveAll();
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      getOrSetBounded(cache, 'ws', 'k', controlled('V3').factory, { deadlineMs: 1000, softTtlMs: 0 }),
    ).resolves.toEqual({ ok: true, value: 'V2' });
  });
});
