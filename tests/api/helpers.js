/* Shared fakes for testing the Vercel-style api/ handlers without network. */

export function makeReq({ method = 'POST', body = {}, headers = {} } = {}) {
  return { method, body, headers };
}

export function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { this.ended = true; return this; },
  };
}

/**
 * Chainable fake for the supabase-js client covering the query shapes the
 * api/ handlers use:
 *   from(t).select(...).eq(...).maybeSingle()
 *   await from(t).select(...).eq(...).order(...)        (thenable builder)
 *   from(t).update(...).eq(...).then(...)               (fire-and-forget)
 *   storage.from(bucket).createSignedUrl(path, ttl)
 *
 * `results` maps table name -> { data, error } returned for any terminal
 * read on that table. `signUrl(bucket, path)` lets tests fail individual
 * signing calls. All calls are recorded for assertions.
 */
export function makeFakeSupabase({ results = {}, signUrl } = {}) {
  const calls = { reads: [], updates: [], signed: [] };

  const client = {
    from(table) {
      const result = () => Promise.resolve(results[table] ?? { data: null, error: null });
      const builder = {
        select(columns) { calls.reads.push({ table, columns }); return builder; },
        eq() { return builder; },
        in() { return builder; },
        order() { return builder; },
        update(payload) { calls.updates.push({ table, payload }); return builder; },
        maybeSingle() { return result(); },
        single() { return result(); },
        then(onFulfilled, onRejected) { return result().then(onFulfilled, onRejected); },
      };
      return builder;
    },
    storage: {
      from(bucket) {
        return {
          createSignedUrl(path, ttl) {
            calls.signed.push({ bucket, path, ttl });
            const make = signUrl
              || ((b, p) => ({ data: { signedUrl: `https://signed.test/${b}/${p}` }, error: null }));
            return Promise.resolve(make(bucket, path));
          },
        };
      },
    },
  };

  return { client, calls };
}
