/**
 * server.js
 *
 * Production-ready LLM Analysis Quiz endpoint.
 * - Browser pool (Playwright) with concurrency limit
 * - JSON parse error -> 400
 * - /health and /metrics endpoints
 * - In-memory dedupe for short window
 * - fetchWithRetry, per-request timeout
 * - Graceful shutdown
 *
 * Secrets/env:
 *  - SECRET (required)
 *  - PORT (optional, default 3000)
 *  - GEMINI_API_KEY (optional)
 *  - BROWSER_POOL_SIZE (optional, default 1)
 *  - MAX_CONCURRENCY (optional, default 1)
 *
 * Keep .env out of source control.
 */

require('dotenv').config();

const express = require('express');
const { chromium } = require('playwright');
const solvers = require('./solvers');
const fetchLib = (...args) => import('node-fetch').then(m => m.default(...args));

let GoogleGenAI = null;
try { GoogleGenAI = require('@google/genai'); } catch (e) { GoogleGenAI = null; }

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.SECRET || 'TDS-23f2-s3cr3t!';
const GEMINI_KEY = process.env.GEMINI_API_KEY || null;
const BROWSER_POOL_SIZE = Math.max(1, Number(process.env.BROWSER_POOL_SIZE || 1));
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY || 1));

/* ---------- Middleware ---------- */
app.use(express.json({ limit: '1mb' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  next();
});

/* ---------- Health & Metrics ---------- */
const metrics = {
  requests: 0,
  suppressedDuplicates: 0,
  successes: 0,
  failures: 0,
  avgProcessingMs: 0
};
app.get('/health', (req, res) => res.status(200).json({ ok: true }));
app.get('/metrics', (req, res) => res.status(200).json(metrics));

/* ---------- Dedupe store ---------- */
const dedupe = new Map();
function dedupeKey(email, url) { return `${email}::${url}`; }
function isDuplicate(email, url) {
  const key = dedupeKey(email, url);
  const now = Date.now();
  if (dedupe.has(key)) {
    const ts = dedupe.get(key);
    if (now - ts < 30_000) {
      dedupe.set(key, now); // refresh TTL
      return true;
    }
  }
  dedupe.set(key, now);
  if (dedupe.size > 2000) { // cleanup occasional
    for (const [k, v] of dedupe) if (now - v > 60_000) dedupe.delete(k);
  }
  return false;
}

/* ---------- Browser pool & concurrency semaphore ---------- */
const browserPool = [];
let browserInitPromise = null;
async function ensureBrowserPool() {
  if (browserInitPromise) return browserInitPromise;
  browserInitPromise = (async () => {
    for (let i = 0; i < BROWSER_POOL_SIZE; i++) {
      const b = await chromium.launch({ args: ['--no-sandbox'] });
      browserPool.push(b);
    }
    return true;
  })();
  return browserInitPromise;
}
function getBrowser() {
  if (!browserPool.length) throw new Error('Browser pool not initialized');
  const idx = Math.floor(Math.random() * browserPool.length);
  return browserPool[idx];
}
async function shutdownBrowserPool() {
  for (const b of browserPool) {
    try { await b.close(); } catch (e) { /* ignore */ }
  }
}

// semaphore
const semaphore = {
  capacity: MAX_CONCURRENCY,
  current: 0,
  queue: [],
  async acquire() {
    if (this.current < this.capacity) {
      this.current += 1;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
    this.current += 1;
  },
  release() {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) next();
  }
};

/* ---------- Utilities: sleep, withTimeout, fetchWithRetry ---------- */
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
async function fetchWithRetry(url, opts = {}, tries = 3, baseMs = 400) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const resp = await fetchLib(url, opts);
      if (resp.status >= 500 && resp.status < 600 && attempt < tries - 1) {
        await sleep(baseMs * Math.pow(2, attempt));
        continue;
      }
      return resp;
    } catch (e) {
      if (attempt === tries - 1) throw e;
      await sleep(baseMs * Math.pow(2, attempt));
    }
  }
}
function withTimeout(promise, ms, failValue = null) {
  return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(failValue), ms))]);
}

/* ---------- Gemini helper (best-effort) ---------- */
async function callGemini(prompt) {
  if (!GEMINI_KEY) return null;
  if (GoogleGenAI && GoogleGenAI.GoogleGenAI) {
    try {
      const client = new GoogleGenAI.GoogleGenAI({ apiKey: GEMINI_KEY });
      const result = await client.models.generateContent({
        model: 'gemini-1.5-preview',
        contents: prompt
      });
      if (!result) return null;
      if (result.output && Array.isArray(result.output)) {
        return result.output.map(o => (o?.content?.text ?? '')).join('\n').trim() || null;
      }
      if (result.text) return result.text;
      return JSON.stringify(result).slice(0, 2000);
    } catch (e) {
      console.warn('Gemini call failed', e && (e.message || e));
      return null;
    }
  }
  return null;
}

/* ---------- Main processing logic ---------- */
async function processQuiz({ email, secret, url, _depth = 0, start = Date.now() }) {
  // enforce overall budget
  const MAX_TOTAL_MS = 2.5 * 60 * 1000;
  if (Date.now() - start > MAX_TOTAL_MS) return;
  if (_depth > 4) return;

  await ensureBrowserPool();
  await semaphore.acquire();
  const tickStart = Date.now();
  try {
    const browser = getBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }});
    const page = await context.newPage();

    try {
      await withTimeout(page.goto(url, { waitUntil: 'networkidle' }), 45_000);

      const taskData = await page.evaluate(() => {
        const out = {
          html: document.documentElement.innerHTML.slice(0, 20000),
          text: document.body.innerText.slice(0, 30000)
        };
        const pre = document.querySelector('pre');
        if (pre) out.pre = pre.innerText;
        const form = document.querySelector('form[action]');
        if (form) out.submit_url = form.getAttribute('action');
        const match = document.body.innerText.match(/https?:\/\/[^\s'"]+\/submit[^\s'"]*/i);
        if (match && !out.submit_url) out.submit_url = match[0];
        return out;
      });

      let answerPayload = null;
      let explicitSubmitPath = null;

      // 1) direct JSON solver
      try {
        const direct = await solvers.directJsonSolver(page, taskData, { email, secret, url });
        if (direct && direct.payload) {
          answerPayload = direct.payload;
          explicitSubmitPath = direct.submit_path || null;
        }
      } catch (e) {
        console.warn('directJsonSolver error', e && (e.message || e));
      }

      // 2) base64 solver
      if (!answerPayload) {
        try {
          if (taskData.pre || /atob\(/i.test(taskData.html || '')) {
            answerPayload = await solvers.base64Solver(page, taskData);
          }
        } catch (e) {
          console.warn('base64Solver error', e && (e.message || e));
        }
      }

      // 3) csv solver
      if (!answerPayload) {
        try {
          answerPayload = await solvers.csvSolver(page, taskData);
        } catch (e) {
          console.warn('csvSolver error', e && (e.message || e));
        }
      }

      // 4) pdf solver
      if (!answerPayload) {
        try {
          answerPayload = await solvers.pdfSumSolver(page, taskData);
        } catch (e) {
          console.warn('pdfSumSolver error', e && (e.message || e));
        }
      }

      // 5) Gemini fallback
      if (!answerPayload && GEMINI_KEY) {
        try {
          const gemText = await callGemini(`Extract a JSON answer and submit path from this quiz page text:\n\n${taskData.text}`);
          if (gemText) {
            const m = gemText.match(/\{[\s\S]*\}/);
            if (m) {
              try {
                const parsed = JSON.parse(m[0]);
                parsed.email = parsed.email || email;
                parsed.secret = parsed.secret || secret;
                parsed.url = parsed.url || url;
                answerPayload = parsed;
              } catch (e) {
                answerPayload = { email, secret, url, note: gemText.slice(0, 2000) };
              }
            } else {
              answerPayload = { email, secret, url, note: gemText.slice(0, 2000) };
            }
          }
        } catch (e) {
          console.warn('Gemini fallback error', e && (e.message || e));
        }
      }

      if (!answerPayload) {
        metrics.failures++;
        console.error('No solver produced an answer for', url);
        await page.close();
        await context.close();
        return;
      }

      // determine submit url
      let submitUrl = taskData.submit_url || null;
      if (!submitUrl && explicitSubmitPath) {
        try { submitUrl = new URL(explicitSubmitPath, url).toString(); } catch (e) { submitUrl = explicitSubmitPath; }
      }
      if (!submitUrl && answerPayload.submit_url) submitUrl = answerPayload.submit_url;
      if (!submitUrl) {
        metrics.failures++;
        console.error('No submit URL discovered for', url);
        await page.close();
        await context.close();
        return;
      }

      answerPayload.email = answerPayload.email || email;
      answerPayload.secret = answerPayload.secret || secret;
      answerPayload.url = answerPayload.url || url;

      let bodyJson = JSON.stringify(answerPayload);
      if (Buffer.byteLength(bodyJson, 'utf8') > 1 * 1024 * 1024) {
        if (answerPayload.note) answerPayload.note = answerPayload.note.slice(0, 1000);
        if (answerPayload.text) answerPayload.text = answerPayload.text.slice(0, 1000);
        bodyJson = JSON.stringify(answerPayload);
      }

      // post with retries
      let resp;
      try {
        resp = await fetchWithRetry(submitUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyJson
        }, 3);
      } catch (e) {
        metrics.failures++;
        console.error('Failed to post answer to', submitUrl, e && (e.message || e));
        await page.close();
        await context.close();
        return;
      }

      let j = null;
      try { j = await resp.json().catch(() => null); } catch (e) { j = null; }
      console.log('Submit response status:', resp.status, 'body:', j);

      const procMs = Date.now() - tickStart;
      // update simple metrics
      metrics.requests++;
      metrics.successes++;
      metrics.avgProcessingMs = metrics.avgProcessingMs ? ((metrics.avgProcessingMs + procMs) / 2) : procMs;

      // follow up if next url present
      if (j && j.url && (Date.now() - start) < MAX_TOTAL_MS) {
        await page.close();
        await context.close();
        await processQuiz({ email, secret, url: j.url, _depth: _depth + 1, start });
        return;
      }

      await page.close();
      await context.close();
      return;

    } finally {
      // ensure context closed (in case of early returns)
      try { if (!context.isClosed()) await context.close(); } catch (e) { /* ignore */ }
    }

  } catch (e) {
    metrics.failures++;
    console.error('processQuiz error', e && (e.message || e));
  } finally {
    semaphore.release();
  }
}

/* ---------- Route: main endpoint ---------- */
app.post('/api/quiz', async (req, res) => {
  const payload = req.body || {};
  const { email, secret, url } = payload;
  if (!email || !secret || !url) return res.status(400).json({ error: 'Missing email/secret/url' });
  if (secret !== SECRET) return res.status(403).json({ error: 'Invalid secret' });

  if (isDuplicate(email, url)) {
    metrics.suppressedDuplicates++;
    res.status(200).json({ received: true, note: 'duplicate request suppressed' });
    return;
  }

  // immediate ack
  res.status(200).json({ received: true });

  // run processing, bounded by overall timeout
  withTimeout(processQuiz({ email, secret, url, _depth: 0, start: Date.now() }), 2.8 * 60 * 1000)
    .catch(e => console.error('process timeout/uncaught', e && (e.message || e)));
});

/* ---------- Graceful shutdown ---------- */
let shuttingDown = false;
async function shutdownHandler() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down: closing browser pool');
  try { await shutdownBrowserPool(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdownHandler);
process.on('SIGTERM', shutdownHandler);

/* ---------- Start server (init pool early) ---------- */
ensureBrowserPool().catch(e => {
  console.warn('Browser pool initialization failed', e && (e.message || e));
});
app.listen(PORT, () => {
  console.log(`LLM Analysis Quiz endpoint listening on ${PORT}`);
});
