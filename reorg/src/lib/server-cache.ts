type CacheEntry<T> = {
  value?: T;
  expiresAt: number;
  fingerprint: string | null;
  inFlight?: Promise<T>;
};

const globalForServerCache = globalThis as unknown as {
  __reorgServerCache?: Map<string, CacheEntry<unknown>>;
};

const serverCache =
  globalForServerCache.__reorgServerCache ??
  new Map<string, CacheEntry<unknown>>();

if (!globalForServerCache.__reorgServerCache) {
  globalForServerCache.__reorgServerCache = serverCache;
}

export async function getServerCachedValue<T>({
  key,
  ttlMs,
  fingerprint = null,
  loader,
}: {
  key: string;
  ttlMs: number;
  fingerprint?: string | null;
  loader: () => Promise<T>;
}): Promise<T> {
  const now = Date.now();
  const existing = serverCache.get(key) as CacheEntry<T> | undefined;

  if (
    existing?.value !== undefined &&
    existing.expiresAt > now &&
    existing.fingerprint === fingerprint
  ) {
    return existing.value;
  }

  if (
    existing?.inFlight &&
    existing.expiresAt > now &&
    existing.fingerprint === fingerprint
  ) {
    return existing.inFlight;
  }

  const inFlight = loader()
    .then((value) => {
      serverCache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
        fingerprint,
      });
      return value;
    })
    .catch((error) => {
      serverCache.delete(key);
      throw error;
    });

  serverCache.set(key, {
    value: existing?.value,
    expiresAt: now + ttlMs,
    fingerprint,
    inFlight,
  });

  return inFlight;
}
