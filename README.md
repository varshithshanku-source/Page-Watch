# Page Watch

Page Watch is a local-first service for tracking meaningful changes on public web pages. It renders pages in headless Chromium, saves a text-and-screenshot version when normalized content changes, and can deliver change summaries to webhooks or email.

## Run locally

Requirements: Node.js 22.5 or newer and the Linux libraries required by Playwright Chromium.

```sh
npm install
npm run install-browser
npm start
```

Open `http://localhost:3000`. On Linux hosts missing Chromium libraries, install Playwright's system dependencies with `npx playwright install-deps chromium` (this may require administrator privileges), then restart the service. The dashboard shows when the browser runtime is unavailable.

SQLite data and screenshots are stored in `data/` by default. Set `PAGEWATCH_DATA_DIR` to move them, and `PORT` to change the listen port.

## What it does

- Checks public HTTP/HTTPS URLs from 15 minutes to 24 hours. Local/private IPs, credentials in page URLs, and non-web protocols are rejected.
- Coalesces due monitors for the same canonical URL into one browser fetch. Jobs run sequentially, with at least five seconds between requests to an origin, 30-second navigation timeouts, and two retries.
- Treats HTTP errors and CAPTCHA/access challenges as status changes, not page-content changes. Those checks do not create snapshots or change alerts.
- Normalizes whitespace, timestamps, and long tokens by default; lower sensitivity also filters common counters and volatile page regions. Per-monitor CSS selectors can narrow the watched content or exclude a region.
- The visual picker previews a public page and lets you choose a region to populate those selectors.
- Keeps a version timeline with word-level text diffs and side-by-side screenshots. A snapshot is recorded only when its normalized content hash differs from the last saved version.
- Supports Discord-style webhooks and Telegram Bot API `sendMessage` URLs (include a `chat_id` in the URL). One webhook URL per line. Email uses `SMTP_URL` and the configured recipient; `MAIL_FROM` is optional.
- Keyword-only alerts are available per monitor. Alerts are sent once per saved version and destination.

## Operational notes

This starter runs as one Node process with an in-process sequential queue and SQLite storage. Sharing a URL coalesces checks within this service instance; it does not coordinate across multiple replicas. Webhook URLs and email recipients are stored locally in SQLite. Watched pages are never asked for or given login credentials. There is no daily digest or AI summary in this version.

To use email, set `SMTP_URL` before starting the service, for example `smtp://user:password@mail.example:587`, and configure a recipient in Alert settings. Keep service settings private if the machine is reachable by other users.