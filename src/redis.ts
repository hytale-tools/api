import type Redis from "ioredis";

interface RatelimitRedis {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, options?: { ex?: number }) => Promise<unknown>;
  sadd: <TData>(key: string, ...members: TData[]) => Promise<number>;
  eval: <TArgs extends unknown[], TData = unknown>(
    script: string,
    keys: string[],
    args: TArgs
  ) => Promise<TData>;
  scriptLoad: (script: string) => Promise<unknown>;
  smismember: (key: string, members: unknown[]) => Promise<(0 | 1)[]>;
  evalsha: <TData>(sha1: string, keys: string[], args: unknown[]) => Promise<TData>;
  hset: <TData>(key: string, kv: Record<string, TData>) => Promise<number>;
}

export function createIoRedisAdapter(client: Redis): RatelimitRedis {
  return {
    get: async (key: string) => client.get(key),
    set: async (key: string, value: string, options?: { ex?: number }) => {
      if (options?.ex) {
        return client.set(key, value, 'EX', options.ex);
      }
      return client.set(key, value);
    },
    sadd: async <TData>(key: string, ...members: TData[]) =>
      client.sadd(key, ...members.map(String)),
    eval: async <TArgs extends unknown[], TData = unknown>(
      script: string,
      keys: string[],
      args: TArgs
    ) => client.eval(script, keys.length, ...keys, ...(args ?? []).map(String)) as Promise<TData>,
    scriptLoad: async (script: string) => client.script('LOAD', script),
    smismember: async (key: string, members: unknown[]) =>
      client.smismember(key, ...(members as string[])) as Promise<(0 | 1)[]>,
    evalsha: async <TData>(sha1: string, keys: string[], args: unknown[]) =>
      client.evalsha(sha1, keys.length, ...keys, ...(args as string[])) as Promise<TData>,
    hset: async <TData>(key: string, kv: Record<string, TData>) => client.hset(key, kv),
  };
} 