import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { createTransport } from 'nodemailer';
import { diffWords } from 'diff';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = resolve(process.env.PAGEWATCH_DATA_DIR || join(root, 'data'));
const port = Number(process.env.PORT || 3000);
await mkdir(join(dataDir, 'screenshots'), { recursive: true });
const db = new DatabaseSync(join(dataDir, 'pagewatch.sqlite'));
const queue = [];
const activeOrigins = new Set();
const lastOriginRequest = new Map();
let browser;
let browserError = null;
let processing = false;

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, canonical_url TEXT NOT NULL,
    interval_minutes INTEGER NOT NULL, sensitivity TEXT NOT NULL DEFAULT 'medium',
    watch_selector TEXT NOT NULL DEFAULT '', ignore_selector TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, next_check_at TEXT NOT NULL, last_checked TEXT,
    last_changed TEXT, status TEXT NOT NULL DEFAULT 'queued', last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL REFERENCES monitors(id), created_at TEXT NOT NULL,
    content_hash TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
    screenshot TEXT NOT NULL, status_code INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS snapshots_monitor_date ON snapshots(monitor_id, created_at);
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, channel TEXT NOT NULL,
    created_at TEXT NOT NULL, UNIQUE(snapshot_id, channel)
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const statements = {
  monitors: db.prepare('SELECT * FROM monitors ORDER BY created_at DESC'),
  getMonitor: db.prepare('SELECT * FROM monitors WHERE id = ?'),
  snapshots: db.prepare('SELECT id, monitor_id, created_at, content_hash, title, text, screenshot, status_code FROM snapshots WHERE monitor_id = ? ORDER BY created_at DESC'),
  latest: db.prepare('SELECT content_hash FROM snapshots WHERE monitor_id = ? ORDER BY created_at DESC LIMIT 1'),
  insertSnapshot: db.prepare('INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  due: db.prepare("SELECT * FROM monitors WHERE enabled = 1 AND next_check_at <= ? ORDER BY next_check_at LIMIT 100"),
  setCheck: db.prepare('UPDATE monitors SET last_checked = ?, status = ?, last_error = ?, next_check_at = ? WHERE id = ?'),
  changed: db.prepare('UPDATE monitors SET last_changed = ?, status = ?, last_error = NULL WHERE id = ?'),
  setting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  saveSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  logAlert: db.prepare('INSERT OR IGNORE INTO alerts VALUES (?, ?, ?, ?)')
};

function nowIso() {
  return new Date().toISOString();
}

function privateIp(address) {
  if (address.startsWith('::ffff:')) return privateIp(address.slice(7));
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224;
  }
  const ip = address.toLowerCase();
  return ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') ||
    ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
}

async function publicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid public URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP and HTTPS URLs are supported.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Private and local network addresses cannot be monitored.');
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => privateIp(address))) {
    throw new Error('This address does not resolve to a public IP.');
  }
  url.hash = '';
  return url;
}

function normalizeText(text, sensitivity) {
  let normalized = text.normalize('NFKC').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  if (sensitivity !== 'high') {
    normalized = normalized
      .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, '[date]')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?\b/gi, '[time]')
      .replace(/\b(?:updated|published|posted|checked)\s*:?\s*.{0,32}(?:ago|today|yesterday|\d{1,2}:\d{2})\b/gi, '[timestamp]')
      .replace(/\b[a-f\d]{20,}\b/gi, '[token]');
  }
  if (sensitivity === 'low') {
    normalized = normalized
      .replace(/\b\d[\d,.]*\s*(?:views?|likes?|followers?|comments?|shares?|visitors?|items?)\b/gi, '[count]')
      .replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g, '[date]');
  }
  return normalized;
}

async function captureForUrl(url, monitors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(30000);
  await page.route('**/*', async route => {
    const requestUrl = route.request().url();
    if (!requestUrl.startsWith('http://') && !requestUrl.startsWith('https://')) return route.abort();
    try {
      await publicUrl(requestUrl);
      await route.continue();
    } catch {
      await route.abort();
    }
  });
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);
    const statusCode = response?.status() || 0;
    const content = await Promise.all(monitors.map(async monitor => {
      const result = await page.evaluate(({ watchSelector, ignoreSelector, sensitivity }) => {
        const noiseSelectors = sensitivity === 'high' ? [] : [
          'script', 'style', 'noscript', 'svg', 'iframe', '[aria-hidden="true"]',
          '[class*="advert" i]', '[id*="advert" i]', '[class*="cookie" i]',
          '[class*="carousel" i]', '[class*="swiper" i]', '[class*="ticker" i]'
        ];
        const roots = watchSelector ? [...document.querySelectorAll(watchSelector)] : [document.body];
        if (!roots.length) throw new Error(`Watch selector matched nothing: ${watchSelector}`);
        const ignored = ignoreSelector ? [...document.querySelectorAll(ignoreSelector)] : [];
        return {
          title: document.title || location.hostname,
          text: roots.map(root => {
            if (ignoreSelector && root.matches(ignoreSelector)) return '';
            const clone = root.cloneNode(true);
            for (const selector of noiseSelectors) clone.querySelectorAll(selector).forEach(node => node.remove());
            if (ignoreSelector) clone.querySelectorAll(ignoreSelector).forEach(node => node.remove());
            return clone.innerText || clone.textContent || '';
          }).join('\n')
        };
      }, monitor);
      const normalized = normalizeText(result.text, monitor.sensitivity);
      return { monitor, title: result.title, text: result.text, hash: createHash('sha256').update(normalized).digest('hex') };
    }));
    const pageSignals = await page.evaluate(() => ({
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 12000)
    }));
    const blocked = statusCode === 401 || statusCode === 403 || statusCode === 429 ||
      /captcha|verify you are human|unusual traffic|access denied|bot detection/i.test(`${pageSignals.title}\n${pageSignals.text}`);
    const error = statusCode >= 400 || statusCode === 0;
    let screenshot = null;
    if (!blocked && !error && content.some(item => {
      const last = statements.latest.get(item.monitor.id);
      return !last || last.content_hash !== item.hash;
    })) {
      screenshot = await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 12000 }).catch(() => page.screenshot({ animations: 'disabled' }));
    }
    return { statusCode, blocked, error, content, screenshot };
  } finally {
    await context.close();
  }
}

function getSetting(key, fallback = '') {
  return statements.setting.get(key)?.value ?? fallback;
}

async function sendAlert(monitor, snapshot, previousText) {
  const webhookUrls = getSetting('webhooks').split('\n').map(value => value.trim()).filter(Boolean);
  const changes = diffWords(previousText || '', snapshot.text).filter(part => part.added || part.removed);
  const summary = changes.map(part => `${part.added ? '+' : '-'} ${part.value}`).join('').slice(0, 1800) || 'Page content changed.';
  const payload = { text: `Page Watch: ${monitor.name} changed\n${monitor.url}\n${summary}\n${process.env.PUBLIC_BASE_URL || `http://localhost:${port}`}/?monitor=${monitor.id}` };
  for (const target of webhookUrls) {
    const channel = createHash('sha256').update(target).digest('hex');
    try {
      const response = await fetch(target, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(target.includes('discord.com/api/webhooks') ? { content: payload.text } : payload),
        signal: AbortSignal.timeout(8000)
      });
      if (response.ok) statements.logAlert.run(randomUUID(), snapshot.id, channel, nowIso());
    } catch (error) {
      console.error('Webhook delivery failed:', error.message);
    }
  }
  const emailTo = getSetting('email');
  if (emailTo && process.env.SMTP_URL) {
    try {
      const transport = createTransport(process.env.SMTP_URL);
      await transport.sendMail({ from: process.env.MAIL_FROM || 'Page Watch <pagewatch@localhost>', to: emailTo, subject: `${monitor.name} changed`, text: payload.text });
      statements.logAlert.run(randomUUID(), snapshot.id, 'email', nowIso());
    } catch (error) {
      console.error('Email delivery failed:', error.message);
    }
  }
}

async function performGroup(monitors) {
  const origin = new URL(monitors[0].url).origin;
  let result;
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    const delay = Math.max(0, 5000 - (Date.now() - (lastOriginRequest.get(origin) || 0)));
    if (delay) await new Promise(resolveDelay => setTimeout(resolveDelay, delay));
    lastOriginRequest.set(origin, Date.now());
    try {
      result = await captureForUrl(monitors[0].url, monitors);
      if (result.statusCode >= 500 || result.statusCode === 0) throw new Error(`The page returned HTTP ${result.statusCode || 'no response'}.`);
      break;
    } catch (error) {
      failure = error;
      if (attempt < 2) await new Promise(resolveDelay => setTimeout(resolveDelay, 1000 * (2 ** attempt)));
    }
  }
  const checkedAt = nowIso();
  for (const monitor of monitors) {
    const next = new Date(Date.now() + monitor.interval_minutes * 60000).toISOString();
    if (failure || result?.error || result?.blocked) {
      const status = result?.blocked ? 'blocked' : 'error';
      const error = result?.blocked ? 'The page returned a CAPTCHA or access challenge.' : failure?.message || `The page returned HTTP ${result.statusCode}.`;
      statements.setCheck.run(checkedAt, status, error, next, monitor.id);
      continue;
    }
    const item = result.content.find(content => content.monitor.id === monitor.id);
    const latest = statements.latest.get(monitor.id);
    const changed = !latest || latest.content_hash !== item.hash;
    statements.setCheck.run(checkedAt, 'ok', null, next, monitor.id);
    if (!changed) continue;
    const keywords = monitor.keywords.split(',').map(word => word.trim().toLowerCase()).filter(Boolean);
    const previous = statements.snapshots.get(monitor.id)[0];
    const relevant = !keywords.length || (previous && diffWords(previous.text, item.text).some(part => part.added && keywords.some(word => part.value.toLowerCase().includes(word))));
    const snapshotId = randomUUID();
    const filename = `${snapshotId}.png`;
    if (result.screenshot) await writeFile(join(dataDir, 'screenshots', filename), result.screenshot);
    statements.insertSnapshot.run(snapshotId, monitor.id, checkedAt, item.hash, item.title, item.text, result.screenshot ? filename : (previous?.screenshot || ''), result.statusCode);
    statements.changed.run(checkedAt, 'ok', monitor.id);
    if (relevant) await sendAlert(monitor, { ...item, id: snapshotId }, previous?.text || '');
  }
}

async function pump() {
  if (processing || queue.length === 0) return;
  processing = true;
  const group = queue.shift();
  const origin = new URL(group[0].url).origin;
  activeOrigins.add(origin);
  try {
    await performGroup(group);
  } catch (error) {
    console.error('Check failed:', error);
  } finally {
    activeOrigins.delete(origin);
    processing = false;
    setImmediate(pump);
  }
}

async function scheduleDue() {
  const due = statements.due.all(nowIso());
  const groups = new Map();
  for (const monitor of due) {
    const group = groups.get(monitor.canonical_url) || [];
    group.push(monitor);
    groups.set(monitor.canonical_url, group);
  }
  for (const [canonicalUrl, monitors] of groups) {
    if (queue.some(group => group[0].canonical_url === canonicalUrl) || activeOrigins.has(new URL(canonicalUrl).origin)) continue;
    queue.push(monitors);
  }
  pump();
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function bodyJson(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (data.length > 1_000_000) throw new Error('Request body is too large.');
  }
  return JSON.parse(data || '{}');
}

function safeMonitor(monitor) {
  return { ...monitor, enabled: Boolean(monitor.enabled), snapshots: statements.snapshots.get(monitor.id).length };
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url, `http://${request.headers.host}`).pathname;
  try {
    if (request.method === 'POST' && path === '/api/inspect') {
      const body = await bodyJson(request);
      const url = await publicUrl(body.url);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await page.route('**/*', async route => {
        const requestUrl = route.request().url();
        if (!requestUrl.startsWith('http://') && !requestUrl.startsWith('https://')) return route.abort();
        try {
          await publicUrl(requestUrl);
          await route.continue();
        } catch {
          await route.abort();
        }
      });
      try {
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(700);
        const regions = await page.evaluate(() => {
          const selectorFor = element => {
            if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
            const parts = [];
            for (let node = element; node && node.nodeType === Node.ELEMENT_NODE && node !== document.body; node = node.parentElement) {
              let part = node.tagName.toLowerCase();
              if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
                parts.unshift(`#${CSS.escape(node.id)}`);
                break;
              }
              const siblings = [...node.parentElement.children].filter(sibling => sibling.tagName === node.tagName);
              if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
              parts.unshift(part);
            }
            return parts.join(' > ');
          };
          return [...document.querySelectorAll('main, article, section, header, footer, nav, aside, [role="main"], h1, h2, h3, p, li, div')]
            .map(element => {
              const rect = element.getBoundingClientRect();
              const text = (element.innerText || '').trim().replace(/\s+/g, ' ');
              return { selector: selectorFor(element), text: text.slice(0, 100), x: rect.x, y: rect.y, width: rect.width, height: rect.height, length: text.length };
            })
            .filter(region => region.length >= 12 && region.width >= 40 && region.height >= 18 && region.y < 880 && region.y + region.height > 0)
            .filter((region, index, all) => all.findIndex(other => other.selector === region.selector) === index)
            .slice(0, 180);
        });
        const screenshot = await page.screenshot({ animations: 'disabled' });
        return json(response, 200, { screenshot: screenshot.toString('base64'), regions });
      } finally {
        await context.close();
      }
    }
    if (request.method === 'GET' && path === '/api/monitors') {
      return json(response, 200, statements.monitors.all().map(safeMonitor));
    }
    if (request.method === 'POST' && path === '/api/monitors') {
      const body = await bodyJson(request);
      const url = await publicUrl(body.url);
      const interval = Number(body.interval_minutes);
      if (!Number.isInteger(interval) || interval < 15 || interval > 1440) throw new Error('Check interval must be between 15 minutes and 24 hours.');
      if (!String(body.name || '').trim()) throw new Error('Give this monitor a name.');
      if (!browser) throw new Error(`Headless browser unavailable: ${browserError || 'install Playwright browser dependencies and restart the service.'}`);
      const canonicalUrl = url.toString();
      const existing = db.prepare('SELECT * FROM monitors WHERE canonical_url = ? AND name = ?').get(canonicalUrl, body.name.trim());
      if (existing) return json(response, 200, safeMonitor(existing));
      const id = randomUUID();
      const now = nowIso();
      db.prepare(`INSERT INTO monitors (id, name, url, canonical_url, interval_minutes, sensitivity, watch_selector, ignore_selector, keywords, created_at, next_check_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`).run(id, body.name.trim(), canonicalUrl, canonicalUrl, interval,
        ['low', 'medium', 'high'].includes(body.sensitivity) ? body.sensitivity : 'medium', body.watch_selector || '', body.ignore_selector || '', body.keywords || '', now, now);
      scheduleDue();
      return json(response, 201, safeMonitor(statements.getMonitor.get(id)));
    }
    const snapshotsMatch = path.match(/^\/api\/monitors\/([^/]+)\/snapshots$/);
    if (request.method === 'GET' && snapshotsMatch) return json(response, 200, statements.snapshots.get(snapshotsMatch[1]));
    const monitorMatch = path.match(/^\/api\/monitors\/([^/]+)$/);
    if (request.method === 'DELETE' && monitorMatch) {
      const id = monitorMatch[1];
      db.prepare('DELETE FROM alerts WHERE snapshot_id IN (SELECT id FROM snapshots WHERE monitor_id = ?)').run(id);
      db.prepare('DELETE FROM snapshots WHERE monitor_id = ?').run(id);
      db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
      return json(response, 200, { ok: true });
    }
    if (request.method === 'POST' && path === '/api/settings') {
      const body = await bodyJson(request);
      statements.saveSetting.run('webhooks', String(body.webhooks || '').trim());
      statements.saveSetting.run('email', String(body.email || '').trim());
      return json(response, 200, { ok: true });
    }
    if (request.method === 'GET' && path === '/api/settings') {
      return json(response, 200, { webhooks: getSetting('webhooks'), email: getSetting('email'), email_ready: Boolean(process.env.SMTP_URL) });
    }
    if (request.method === 'GET' && path === '/api/health') {
      return json(response, 200, { browser_ready: Boolean(browser), browser_error: browserError });
    }
    if (request.method === 'GET' && path === '/vendor/diff.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      return response.end(await readFile(join(root, 'node_modules', 'diff', 'dist', 'diff.min.js')));
    }
    const screenshotMatch = path.match(/^\/screenshots\/([\da-f-]+\.png)$/i);
    if (request.method === 'GET' && screenshotMatch) {
      const image = await readFile(join(dataDir, 'screenshots', screenshotMatch[1]));
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' });
      return response.end(image);
    }
    if (request.method === 'GET' && path.startsWith('/api/')) return json(response, 404, { error: 'Not found.' });
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (!['index.html', 'app.js', 'styles.css'].includes(file)) return response.writeHead(404).end('Not found.');
    const contentTypes = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8' };
    response.writeHead(200, { 'content-type': contentTypes[file] });
    response.end(await readFile(join(root, 'public', file)));
  } catch (error) {
    json(response, 400, { error: error.message || 'The request could not be completed.' });
  }
});

try {
  browser = await chromium.launch({ headless: true });
} catch (error) {
  browserError = error.message.match(/error while loading shared libraries: [^\n]+/)?.[0] || error.message.split('\n')[0];
  console.error(`Headless browser unavailable: ${browserError}`);
}
server.listen(port, () => console.log(`Page Watch is running at http://localhost:${port}`));
setInterval(scheduleDue, 15000);
process.on('SIGINT', async () => {
  server.close();
  await browser?.close();
  db.close();
  process.exit(0);
});