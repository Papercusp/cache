import { describe, expect, it } from 'vitest';
import { Cache } from './cache';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('Cache — getOrSet basics', () => {
  it('runs the factory once and serves the cached value on repeat gets', async () => {
    const c = new Cache();
    let calls = 0;
    const f = (): string => {
      calls++;
      return 'v';
    };
    expect(await c.getOrSet('w1', 'k', f)).toBe('v');
    expect(await c.getOrSet('w1', 'k', f)).toBe('v');
    expect(calls).toBe(1);
    expect(c.stats.hits).toBe(1);
    expect(c.stats.misses).toBe(1);
  });

  it('requires a workspaceId (cross-workspace leak guard)', async () => {
    const c = new Cache();
    await expect(c.getOrSet('', 'k', () => 'x')).rejects.toThrow(/workspaceId/);
    expect(() => c.invalidateByTag('', 't')).toThrow(/workspaceId/);
  });
});

describe('Cache — workspace isolation (D-010)', () => {
  it('keeps identical keys independent across workspaces', async () => {
    const c = new Cache();
    expect(await c.getOrSet('w1', 'k', () => 'a')).toBe('a');
    expect(await c.getOrSet('w2', 'k', () => 'b')).toBe('b');
    // each workspace keeps its own value
    expect(await c.getOrSet('w1', 'k', () => 'X')).toBe('a');
    expect(await c.getOrSet('w2', 'k', () => 'Y')).toBe('b');
  });

  it("a tag invalidation in one workspace does not affect another's entry", async () => {
    const c = new Cache();
    await c.getOrSet('w1', 'k', () => 'a1', { tags: ['T'] });
    await c.getOrSet('w2', 'k', () => 'b1', { tags: ['T'] });
    c.invalidateByTag('w1', 'T');
    expect(await c.getOrSet('w1', 'k', () => 'a2', { tags: ['T'] })).toBe('a2'); // w1 rebuilt
    expect(await c.getOrSet('w2', 'k', () => 'b2', { tags: ['T'] })).toBe('b1'); // w2 untouched
  });
});

describe('Cache — tag invalidation', () => {
  it('rebuilds an entry after its tag is invalidated', async () => {
    const c = new Cache();
    expect(await c.getOrSet('w', 'k', () => 'v1', { tags: ['T'] })).toBe('v1');
    c.invalidateByTag('w', 'T');
    expect(await c.getOrSet('w', 'k', () => 'v2', { tags: ['T'] })).toBe('v2');
  });

  it('a bump DURING a build marks the result stale on next read (no masking — D-014)', async () => {
    const c = new Cache();
    const d = deferred<string>();
    const p1 = c.getOrSet('w', 'k', () => d.promise, { tags: ['T'] });
    // invalidate while the factory is in-flight (generation was snapshotted before the build)
    c.invalidateByTag('w', 'T');
    d.resolve('v1');
    expect(await p1).toBe('v1');
    // next read sees the bumped generation > the stamped one ⇒ rebuilds
    expect(await c.getOrSet('w', 'k', () => 'v2', { tags: ['T'] })).toBe('v2');
  });
});

describe('Cache — single-flight', () => {
  it('shares one factory run across concurrent gets of the same key', async () => {
    const c = new Cache();
    let calls = 0;
    const d = deferred<string>();
    const f = (): Promise<string> => {
      calls++;
      return d.promise;
    };
    const a = c.getOrSet('w', 'k', f);
    const b = c.getOrSet('w', 'k', f);
    d.resolve('v');
    expect(await a).toBe('v');
    expect(await b).toBe('v');
    expect(calls).toBe(1);
    expect(c.stats.singleFlightJoins).toBe(1);
  });
});

describe('Cache — TTL + stale-while-revalidate', () => {
  it('serves stale past softTtl and revalidates in the background', async () => {
    let now = 0;
    const c = new Cache({ clock: () => now });
    let n = 0;
    const f = (): string => `v${++n}`;
    expect(await c.getOrSet('w', 'k', f, { softTtlMs: 100 })).toBe('v1');
    now = 150; // past soft
    // stale served immediately; background revalidate kicks off
    expect(await c.getOrSet('w', 'k', f, { softTtlMs: 100 })).toBe('v1');
    expect(c.stats.staleServed).toBe(1);
    await tick(); // let the background rebuild settle
    expect(await c.getOrSet('w', 'k', f, { softTtlMs: 100 })).toBe('v2');
  });

  it('forces a blocking rebuild past hardTtl', async () => {
    let now = 0;
    const c = new Cache({ clock: () => now });
    let n = 0;
    const f = (): string => `v${++n}`;
    expect(await c.getOrSet('w', 'k', f, { hardTtlMs: 100 })).toBe('v1');
    now = 150;
    expect(await c.getOrSet('w', 'k', f, { hardTtlMs: 100 })).toBe('v2');
  });
});

describe('Cache — L1 + negative caching + cold-bust', () => {
  it('evicts the least-recently-used entry past maxL1Entries', async () => {
    const c = new Cache({ maxL1Entries: 2 });
    let calls = 0;
    const f = (v: string) => (): string => {
      calls++;
      return v;
    };
    await c.getOrSet('w', 'a', f('a')); // a
    await c.getOrSet('w', 'b', f('b')); // a,b
    await c.getOrSet('w', 'a', f('a')); // touch a -> a most-recent (b oldest)
    await c.getOrSet('w', 'c', f('c')); // evicts b
    expect(calls).toBe(3);
    await c.getOrSet('w', 'b', f('b2')); // b was evicted -> rebuilds
    expect(calls).toBe(4);
  });

  it('caches empty results only when cacheEmpty is set', async () => {
    const c = new Cache();
    let calls = 0;
    const f = (): null => {
      calls++;
      return null;
    };
    await c.getOrSet('w', 'k', f); // not cached (cacheEmpty default false)
    await c.getOrSet('w', 'k', f);
    expect(calls).toBe(2);
    let c2calls = 0;
    const c2 = new Cache();
    const g = (): null => {
      c2calls++;
      return null;
    };
    await c2.getOrSet('w', 'k', g, { cacheEmpty: true });
    await c2.getOrSet('w', 'k', g, { cacheEmpty: true });
    expect(c2calls).toBe(1);
  });

  it('clearL1 (cold-bust) forces every entry to rebuild', async () => {
    const c = new Cache();
    let calls = 0;
    const f = (): string => {
      calls++;
      return 'v';
    };
    await c.getOrSet('w', 'k', f);
    c.clearL1();
    await c.getOrSet('w', 'k', f);
    expect(calls).toBe(2);
  });
});

describe('Cache — kill-switch bypass (P-018)', () => {
  it('bypass=true ⇒ getOrSet always runs the factory (no L1 read/write/single-flight)', async () => {
    let disabled = false;
    const c = new Cache({ bypass: () => disabled });
    let calls = 0;
    const f = (): string => {
      calls++;
      return 'v';
    };

    // Enabled: cached after the first build.
    expect(await c.getOrSet('w', 'k', f)).toBe('v');
    expect(await c.getOrSet('w', 'k', f)).toBe('v');
    expect(calls).toBe(1);

    // Disabled: every getOrSet re-runs the factory, ignoring the warm entry.
    disabled = true;
    expect(await c.getOrSet('w', 'k', f)).toBe('v');
    expect(await c.getOrSet('w', 'k', f)).toBe('v');
    expect(calls).toBe(3);
    // No L1 reads/writes happened while bypassed — stats untouched past the warm build.
    expect(c.stats.builds).toBe(1);

    // Re-enabling serves the still-warm pre-bypass entry (bypass never evicted it).
    disabled = false;
    expect(await c.getOrSet('w', 'k', f)).toBe('v');
    expect(calls).toBe(3);
  });

  it('bypass still enforces the workspace-scope guard (D-010)', async () => {
    const c = new Cache({ bypass: () => true });
    await expect(c.getOrSet('', 'k', () => 'x')).rejects.toThrow(/workspaceId/);
  });
});
