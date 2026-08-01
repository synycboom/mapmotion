// A stand-in for PostHog's ingest API.
//
// The point is to see the actual wire payloads, because the two things worth
// testing about analytics are (a) do the funnel events fire at all and (b)
// does anything the user typed leak into them. Neither is observable from
// inside the app — you have to read what leaves the browser.
import { createServer } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';

/**
 * Recover the event batch from a capture request.
 *
 * We post plain JSON, but decoding is kept permissive — base64 and gzip are
 * both things PostHog clients have used — because a decoder that silently
 * returns nothing would make the leak test pass by finding no secrets in no
 * data.
 */
function decodeBody(raw, contentType = '') {
  const attempts = [];

  attempts.push(() => JSON.parse(raw.toString('utf8')));

  attempts.push(() => JSON.parse(gunzipSync(raw).toString('utf8')));
  attempts.push(() => JSON.parse(inflateSync(raw).toString('utf8')));

  attempts.push(() => {
    const text = raw.toString('utf8');
    const params = new URLSearchParams(text);
    const data = params.get('data');
    if (!data) throw new Error('no data field');
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  });

  attempts.push(() =>
    JSON.parse(Buffer.from(raw.toString('utf8'), 'base64').toString('utf8')),
  );

  for (const attempt of attempts) {
    try {
      const parsed = attempt();
      if (parsed) return parsed;
    } catch {
      /* next */
    }
  }
  return { __undecodable: raw.toString('utf8').slice(0, 200), __contentType: contentType };
}

/**
 * Reject anything PostHog itself would reject.
 *
 * This matters more than it looks. PostHog answers `200 OK` for events it
 * silently discards — a missing or empty top-level `distinct_id` is dropped
 * with no error anywhere. A mock that accepts any well-formed JSON therefore
 * proves only that we SEND something, not that it would ever be INGESTED,
 * and that gap shipped once already.
 *
 * Rules from https://posthog.com/docs/api/capture.
 */
function conformance(e) {
  const problems = [];
  if (!e || typeof e !== 'object') return ['not an object'];
  if (!e.api_key) problems.push('missing api_key');
  if (!e.event || typeof e.event !== 'string') problems.push('missing event name');
  // The one that bit us: it must be top level, and non-empty.
  if (typeof e.distinct_id !== 'string' || e.distinct_id.length === 0) {
    problems.push(
      e.properties && e.properties.distinct_id
        ? 'distinct_id is inside properties instead of top level'
        : 'missing top-level distinct_id',
    );
  }
  if (e.timestamp !== undefined && Number.isNaN(Date.parse(e.timestamp))) {
    problems.push('timestamp is not ISO 8601');
  }
  return problems;
}

export function startMockPosthog(port) {
  /** Every captured event, flattened across batches. */
  const events = [];
  /** Events PostHog would have discarded, with the reason. */
  const rejected = [];
  /** Raw bodies, so a leak test can search text we failed to decode too. */
  const rawBodies = [];
  const paths = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      paths.push(req.url.split('?')[0]);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // posthog-js lazy-loads optional extensions (recorder, surveys,
      // exception autocapture) as SCRIPTS from the api_host. Answering those
      // with JSON makes the browser try to parse `{"status":1}` as JavaScript
      // and throw "Unexpected token ':'" — which looks like an app bug and
      // isn't one.
      if (/\.js(\?|$)/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('/* mock posthog extension */');
        return;
      }

      // Feature-flag / config endpoints. Answer with something valid so the
      // SDK doesn't spend the test retrying.
      if (/\/(decide|flags|array|config)/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ featureFlags: {}, sessionRecording: false, config: { enable_collect_everything: false } }));
        return;
      }

      if (raw.length) {
        rawBodies.push(raw.toString('utf8'));
        const body = decodeBody(raw, req.headers['content-type'] ?? '');
        const batch = Array.isArray(body) ? body : body?.batch ?? [body];
        for (const e of batch) {
          if (!e || typeof e !== 'object') continue;
          const problems = conformance(e);
          if (problems.length) {
            rejected.push({ event: e.event ?? '(none)', problems });
            // Answer 200 anyway — that is precisely what PostHog does, and a
            // mock that returned an error would make the failure easy in a
            // way production is not.
            continue;
          }
          events.push(e);
        }
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 1 }));
    });
  });

  server.listen(port);
  return {
    server,
    host: `http://localhost:${port}`,
    events,
    rejected,
    rawBodies,
    paths,
    /** Names of captured product events, in arrival order. */
    names: () => events.map((e) => e.event).filter(Boolean),
    find: (name) => events.filter((e) => e.event === name),
  };
}
