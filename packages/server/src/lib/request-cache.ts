import { AsyncLocalStorage } from "node:async_hooks";

const requestCache = new AsyncLocalStorage<{
  promises: Map<string, Promise<unknown>>;
  mediaOrigin?: string;
}>();

export function runWithRequestCache<T>(operation: () => Promise<T>, mediaOrigin?: string): Promise<T> {
  return requestCache.run({ promises: new Map(), mediaOrigin }, operation);
}

export function getRequestMediaOrigin(): string | undefined {
  return requestCache.getStore()?.mediaOrigin;
}

export function getOrCreateRequestPromise<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const store = requestCache.getStore()?.promises;
  if (!store) return factory();
  const existing = store.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const created = Promise.resolve().then(factory);
  store.set(key, created);
  void created.catch(() => {
    if (store.get(key) === created) store.delete(key);
  });
  return created;
}

export function invalidateRequestCachePrefix(prefix: string): void {
  const store = requestCache.getStore()?.promises;
  if (!store) return;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
