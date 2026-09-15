/**
 * Keeps the Formax backend on Render from spinning down.
 *
 * Render sleeps a free web service after 15 minutes with no traffic, and the next visitor waits
 * ~40 seconds for it to wake. This pings often enough that the window never elapses.
 *
 * This used to be a GitHub Actions cron. It did not work: over its first 55 hours GitHub fired
 * 18 of the 333 scheduled runs (5%), the shortest gap between two runs was 1h47m, and five of
 * the last six pings paid a full cold start — the workflow was waking the service, not keeping
 * it awake. GitHub's scheduler drops high-frequency crons on free public repos rather than
 * queuing them, so no cron expression could have fixed it. Cloudflare honours the schedule.
 */

/** Render cold starts land around 40s, so the ceiling has to sit well past that. */
const PING_TIMEOUT_MS = 90_000
const ATTEMPTS = 3
const RETRY_DELAY_MS = 10_000

/** Slower than this means the service had already slept and this ping paid the wake-up. */
const COLD_START_THRESHOLD_S = 10

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function pingOnce(target) {
  const startedAt = Date.now()

  const response = await fetch(target, {
    method: 'GET',
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    headers: { 'user-agent': 'formax-keepalive (Cloudflare Worker)' },
    // Without this a repeat request can be served from Cloudflare's own cache and never reach
    // Render at all — which would leave the service asleep while every ping reported success.
    cf: { cacheTtl: 0, cacheEverything: false }
  })

  return { status: response.status, seconds: (Date.now() - startedAt) / 1000 }
}

async function ping(env) {
  const target = env.BACKEND_URL

  if (!target) {
    throw new Error('BACKEND_URL is not set. Run: npx wrangler secret put BACKEND_URL')
  }

  let lastError

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const { status, seconds } = await pingOnce(target)

      console.log(`HTTP ${status} in ${seconds.toFixed(1)}s (attempt ${attempt}/${ATTEMPTS})`)

      // Any HTTP status proves the instance answered, 404 included — the backend has no health
      // route, and what is being tested is whether it is awake, not whether the path exists.
      if (status >= 500) {
        console.warn(`Backend responded ${status} — awake, but returning a server error.`)
      }

      if (seconds > COLD_START_THRESHOLD_S) {
        console.warn(`Took ${seconds.toFixed(1)}s — the service had spun down before this ping.`)
      }

      return { status, seconds }
    } catch (error) {
      lastError = error
      console.warn(`Attempt ${attempt}/${ATTEMPTS} failed: ${error.message}`)
      if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS)
    }
  }

  // Thrown rather than swallowed: a throw is what marks the run failed in the Worker's Cron
  // Events table, which is the only place a silent outage would otherwise show up.
  throw new Error(`No response from the backend after ${ATTEMPTS} attempts — ${lastError?.message}`)
}

/** Last run, written to KV so it outlives the isolate and any `wrangler tail` session. */
async function record(env, entry) {
  if (!env.STATE) return
  try {
    await env.STATE.put('last-run', JSON.stringify(entry))
  } catch (error) {
    console.warn(`Could not record the run: ${error.message}`)
  }
}

export default {
  async scheduled(controller, env, _ctx) {
    const firedAt = new Date().toISOString()
    console.log(`Cron ${controller.cron} fired at ${new Date(controller.scheduledTime).toISOString()}`)

    try {
      const { status, seconds } = await ping(env)
      await record(env, { firedAt, ok: true, status, seconds: Number(seconds.toFixed(1)) })
    } catch (error) {
      await record(env, { firedAt, ok: false, error: error.message })
      throw error
    }
  },

  /**
   * Deploying gives the Worker a public workers.dev URL whether or not it is wanted, and a Worker
   * with no fetch handler answers it with an error. This reports configuration and deliberately
   * does NOT ping: a public URL that triggers a backend request is a free amplifier for anyone
   * who finds it. Ping by hand from the dashboard's "Trigger Cron Event" or `npm run dev`.
   */
  async fetch(_request, env) {
    const host = env.BACKEND_URL ? new URL(env.BACKEND_URL).host : '(BACKEND_URL is not set)'
    const raw = env.STATE ? await env.STATE.get('last-run') : null
    const last = raw ? JSON.parse(raw) : null

    const lastLine = last
      ? `${last.firedAt} — ${last.ok ? `HTTP ${last.status} in ${last.seconds}s` : `FAILED: ${last.error}`}` +
        ` (${Math.round((Date.now() - Date.parse(last.firedAt)) / 60000)} min ago)`
      : 'never — no scheduled run has completed yet'

    return new Response(
      ['formax-keepalive', '', `target:    ${host}`, 'schedule:  every 10 minutes', `last run:  ${lastLine}`, ''].join('\n'),
      { headers: { 'content-type': 'text/plain; charset=utf-8' } }
    )
  }
}
