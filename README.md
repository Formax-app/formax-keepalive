# formax-keepalive

Keeps the Formax backend on Render from spinning down.

Render puts a free web service to sleep after 15 minutes with no traffic, and the next visitor
waits about 50 seconds while it wakes up. [`keep-awake.yml`](.github/workflows/keep-awake.yml)
sends a request every 10 minutes so that window never elapses.

## Why this repo is public

GitHub bills **every job as a whole minute**, even one that runs for three seconds. A private
repo gets 2,000 free Actions minutes a month:

| | |
|---|---|
| Runs per month (every 10 min) | ~4,320 |
| Billed minutes | ~4,320 |
| Free allowance (private repo) | 2,000 |
| Overage | 2,320 × $0.006 ≈ **$14/month** |

Public repositories get unlimited Actions minutes, so here it costs nothing. That is the only
reason this is a separate repo rather than a workflow in the backend.

For reference, Render's Starter tier — which never sleeps — is **$7/month**. If this ever
becomes something worth maintaining, paying Render is both cheaper and more reliable than the
private-repo version of this workflow.

Nothing secret lives here. The backend URL is a repository secret, and the workflow only makes
an unauthenticated GET.

## The Render side of the maths

Render gives **750 instance-hours per month, per workspace**, shared across every free service
in it. Kept awake continuously:

```
30-day month   720 hours     ✓ under 750
31-day month   744 hours     ✓ under 750, with 6 to spare
```

So one always-on free service fits — but it consumes essentially the whole allowance. **Adding
a second free service to this Render workspace will exceed the 750 hours and take both down.**
If that happens, this workflow is the first thing to switch off.

## What it does not guarantee

GitHub's scheduler is best effort. Runs are frequently delayed, sometimes by 20–40 minutes,
particularly on the hour — which is why the cron fires at `:04, :14, :24…` rather than `:00`.
A delay longer than 15 minutes means the service sleeps anyway and the next visitor pays the
cold start.

This reduces cold starts. It does not eliminate them. For that, use a paid Render tier.

## Setup

The URL lives in a repository secret:

```bash
gh secret set BACKEND_URL --repo Formax-app/formax-keepalive --body 'https://backend-oqui.onrender.com/'
```

Run it by hand from the Actions tab, or:

```bash
gh workflow run keep-awake.yml --repo Formax-app/formax-keepalive
```

## Health endpoint

The backend has no health route, so the ping hits `/` and gets a 404. That still proves the
instance is awake — the app answered. A real `/health` endpoint on the backend would make the
check meaningful rather than incidental, and would let the workflow distinguish "awake" from
"awake and working".
