# formax-keepalive

A Cloudflare Worker that pings the Formax backend on Render every 10 minutes so it never spins
down. Render sleeps a free web service after 15 minutes with no traffic, and the next visitor
waits about 40 seconds while it wakes up.

## Why this is not a GitHub Action any more

It was one, and it did not work. Over the workflow's first 55 hours:

| | |
|---|---|
| Scheduled fires expected (6/hour) | 333 |
| Runs GitHub actually started | 18 — **5.4%** |
| Shortest gap between two runs | 1h 47m |
| Median gap | ~2h 35m |
| Longest gap | 5h 25m |
| Render's sleep window | **15m** |

The gap never once came in under 15 minutes, so the service slept before every single ping.
Five of the last six runs reported a 32–43 second response: the workflow was *waking* a sleeping
service, not keeping it awake. Every run was green the whole time.

This was not misconfiguration. The cron was already off the hour (`:04, :14, :24…`), the repo is
public and not a fork, and every run succeeded. GitHub deprioritises high-frequency schedules on
free public repositories and **drops** fires rather than queuing them, so no cron expression
could have fixed it. Cloudflare honours the schedule.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler secret put BACKEND_URL   # https://backend-oqui.onrender.com/
npm run deploy
```

The URL is a Worker secret, not committed. Everything the Worker does is one unauthenticated GET.

Setting up a *new* account also needs its own KV namespace, since the id in `wrangler.jsonc` is
tied to this one:

```bash
npx wrangler kv namespace create STATE   # then paste the id into wrangler.jsonc
```

### The first run can take hours, not minutes

Cloudflare documents "up to 15 minutes to propagate". On this account the trigger was registered
at 12:08 and the first run landed at **22:10** — about ten hours. In between, the API reported
the schedule as registered and `wrangler deploy` printed it back, while `* * * * *` missed
eighteen consecutive slots. Nothing was wrong and no amount of redeploying helped.

So: after the first deploy, **leave it alone and check the next day**. Do not conclude it is
broken, and do not go rewriting the cron expression — that only restarts the propagation window.

## Run it by hand

Local runs read the URL from `.dev.vars` (gitignored) rather than the deployed secret:

```bash
echo 'BACKEND_URL="https://backend-oqui.onrender.com/"' > .dev.vars
npm run dev      # wrangler dev --test-scheduled
# then, in another shell:
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*%2F10+*+*+*+*"
```

Wrangler 4 needs **Node 22+**; Homebrew's `node@20` is not enough.

In production, use **Workers → formax-keepalive → Settings → Trigger Cron Event**. Hitting the
Worker's public URL deliberately does *not* ping — a public endpoint that fires a request at your
backend is a free amplifier for anyone who finds it. It returns the target host and schedule.

## Watching it

**Open the Worker's URL.** Every scheduled run is written to KV, so the page reports the last one
and how long ago it was:

```
target:    backend-oqui.onrender.com
schedule:  every 10 minutes
last run:  2026-09-14T22:40:06.029Z — HTTP 404 in 0.1s (0 min ago)
```

That response time is the whole health check. `0.1s` means the previous ping kept the service
warm, which is the point. `~33s` means it had gone to sleep and this run paid the cold start.
A `last run` more than ~15 minutes old means the schedule is not keeping up.

KV rather than logs because logs are only visible while something is watching: `wrangler tail`
shows nothing after you close it, needs a WebSocket that some networks break, and the dashboard's
Cron Events window is short. 144 writes a day against a 1,000/day free limit.

`npm run tail` still streams live logs, and `observability` is on in `wrangler.jsonc`. Two
warnings are worth watching for:

- `Took 41.2s — the service had spun down before this ping.` The schedule is not keeping up.
- `Backend responded 503 — awake, but returning a server error.` Awake but unwell.

A ping that fails all three attempts throws, which marks the run failed in Cron Events.

## Cost

Free. Workers' free plan covers 100,000 requests a day; this uses 144, plus 144 KV writes
against a 1,000/day limit. Cron invocations are
billed on **CPU** time, and time spent waiting on a `fetch` is not CPU time — so a 40-second
cold start costs essentially nothing against the 10ms limit.

## The Render side of the maths

Render gives **750 instance-hours per month, per workspace**, shared across every free service
in it. Kept awake continuously:

```
30-day month   720 hours     ✓ under 750
31-day month   744 hours     ✓ under 750, with 6 to spare
```

So one always-on free service fits — but it consumes essentially the whole allowance. **Adding
a second free service to this Render workspace will exceed the 750 hours and take both down.**
If that happens, this Worker is the first thing to switch off.

For reference, Render's Starter tier — which never sleeps — is $7/month. That removes the cold
start problem outright rather than papering over it, and removes the 750-hour ceiling with it.

## Health endpoint

The backend has no health route, so the ping hits `/` and gets a 404. That still proves the
instance is awake — the app answered. A real `/health` endpoint would make the check meaningful
rather than incidental, and would let the Worker tell "awake" from "awake and working".
