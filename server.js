// server.js
// Complete updated server with direct JSON solver integration and improved solver selection.
// Place your secrets in a .env file (SECRET, PORT, GEMINI_API_KEY, TEST_EMAIL).
// Example .env:
// SECRET=TDS-23f2-s3cr3t!
// PORT=3000
// GEMINI_API_KEY=your_gemini_api_key_here
// TEST_EMAIL=23f2002722@ds.study.iitm.ac.in

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');
const solvers = require('./solvers');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

// Attempt to require Google GenAI client if installed; otherwise skip gracefully
let GoogleGenAI = null;
try { GoogleGenAI = require('@google/genai'); } catch (e) { GoogleGenAI = null; }

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

const SECRET = process.env.SECRET || 'TDS-23f2-s3cr3t!';
const PORT = process.env.PORT || 3000;

// Helpers
function badRequest(res, msg) { return res.status(400).json({ error: msg }); }
function forbidden(res, msg) { return res.status(403).json({ error: msg }); }

// Entrypoint
app.post('/api/quiz', async (req, res) => {
  if (!req.is('application/json')) return badRequest(res, 'Expected application/json');
  const { email, secret, url } = req.body || {};
  if (!email || !secret || !url) return badRequest(res, 'Missing email/secret/url');

  if (secret !== SECRET) return forbidden(res, 'Invalid secret');

  // Immediately acknowledge (required by spec) and then process the quiz
  res.status(200).json({ received: true });

  try {
    // Do not defer processing — must run now and complete within grader window
    await processQuiz({ email, secret, url, _depth: 0 });
  } catch (err) {
    console.error('Error in processing quiz (top-level):', err);
  }
});

// Optional Gemini (GenAI) helper — best-effort, skip if client missing
async function callGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not set — skipping Gemini call.');
    return null;
  }
  // Prefer official client if available
  if (GoogleGenAI && GoogleGenAI.GoogleGenAI) {
    try {
      const client = new GoogleGenAI.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      // NOTE: the exact usage may vary by client version; adapt if necessary.
      const result = await client.models.generateContent({
        model: 'gemini-1.5-preview', // adapt model name if needed
        contents: prompt
      });
      // The client shape may differ; try to return text gracefully
      if (result && result.output && Array.isArray(result.output) && result.output.length > 0) {
        // attempt to extract text content
        const textParts = result.output
          .map(o => (typeof o === 'string' ? o : (o.content?.text ?? '')))
          .filter(Boolean);
        return textParts.join('\n').trim() || null;
      } else if (result && result.text) {
        return result.text;
      } else {
        return JSON.stringify(result).slice(0, 2000);
      }
    } catch (err) {
      console.error('Gemini client call failed:', err);
      return null;
    }
  } else {
    console.warn('Google GenAI client not installed; skipping Gemini SDK call.');
    return null;
  }
}

// Main processor
async function processQuiz(payload) {
  const startTime = Date.now();
  const MAX_TOTAL_MS = 2.5 * 60 * 1000; // 2.5 minutes guard (must be within 3 minutes)
  const { email, secret, url } = payload;
  const maxDepth = payload._depth ?? 0;
  if (maxDepth > 4) {
    console.warn('Max recursion depth reached for quiz chain; aborting further follow-ups.');
    return;
  }

  console.log(`Processing quiz for url: ${url} (depth ${maxDepth})`);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }});
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

    // Extract some heuristics about the page
    const taskData = await page.evaluate(() => {
      const out = {
        htmlPreview: document.documentElement.innerHTML.slice(0, 20000),
        text: document.body.innerText.slice(0, 30000)
      };
      const pre = document.querySelector('pre');
      if (pre) out.pre = pre.innerText;
      const form = document.querySelector('form[action]');
      if (form) out.submit_url = form.getAttribute('action');
      // attempt to find a direct submit URL in text
      const match = document.body.innerText.match(/https?:\/\/[^\s'"]+\/submit[^\s'"]*/i);
      if (match && !out.submit_url) out.submit_url = match[0];
      return out;
    });

    // Candidate solver selection (fast -> slow)
    let answerPayload = null;
    let explicitSubmitPath = null; // e.g. "/submit" returned by solver

    // 1) direct JSON solver - handles demo page and similar patterns
    try {
      const direct = await solvers.directJsonSolver(page, taskData, { email, secret, url });
      if (direct && direct.payload) {
        answerPayload = direct.payload;
        explicitSubmitPath = direct.submit_path || null;
        console.log('directJsonSolver produced a payload.');
      }
    } catch (e) {
      console.warn('directJsonSolver error:', e);
    }

    // 2) base64 solver (checks <pre> or atob patterns)
    if (!answerPayload) {
      try {
        if (taskData.pre || /atob\(/i.test(taskData.htmlPreview || '')) {
          answerPayload = await solvers.base64Solver(page, taskData);
          if (answerPayload) console.log('base64Solver produced a payload.');
        }
      } catch (e) {
        console.warn('base64Solver error:', e);
      }
    }

    // 3) CSV solver
    if (!answerPayload) {
      try {
        answerPayload = await solvers.csvSolver(page, taskData);
        if (answerPayload) console.log('csvSolver produced a payload.');
      } catch (e) {
        console.warn('csvSolver error:', e);
      }
    }

    // 4) PDF solver
    if (!answerPayload) {
      try {
        answerPayload = await solvers.pdfSumSolver(page, taskData);
        if (answerPayload) console.log('pdfSumSolver produced a payload.');
      } catch (e) {
        console.warn('pdfSumSolver error:', e);
      }
    }

    // 5) Gemini-assisted fallback (best-effort)
    if (!answerPayload) {
      try {
        const geminiText = await callGemini(`Extract a JSON object or submission instructions from the following quiz page text:\n\n${taskData.text}`);
        if (geminiText) {
          // Attempt to parse JSON from Gemini output
          const m = geminiText.match(/\{[\s\S]*\}/);
          if (m) {
            try {
              const parsed = JSON.parse(m[0]);
              // Make sure required fields exist; fill in email/secret/url if missing
              if (parsed && typeof parsed === 'object') {
                if (!parsed.email) parsed.email = email;
                if (!parsed.secret) parsed.secret = secret;
                if (!parsed.url) parsed.url = url;
                answerPayload = parsed;
                console.log('Gemini-assisted parse produced a payload.');
              }
            } catch (e) {
              console.warn('Unable to JSON-parse Gemini output.');
            }
          } else {
            // If Gemini returns structured instructions but not JSON, wrap as note
            answerPayload = { email, secret, url, note: geminiText.slice(0, 2000) };
            console.log('Gemini returned text; using as note in payload.');
          }
        } else {
          console.log('Gemini returned no helpful output.');
        }
      } catch (e) {
        console.warn('Gemini fallback error:', e);
      }
    }

    if (!answerPayload) {
      console.error('No solver produced an answer; aborting for this url.');
      await browser.close();
      return;
    }

    // Determine the submit URL:
    // Priority: page-provided absolute submit_url > solver-provided explicit path (resolve against base) > answerPayload.submit_url
    let submitUrl = taskData.submit_url || null;
    if (!submitUrl && explicitSubmitPath) {
      try {
        submitUrl = new URL(explicitSubmitPath, url).toString();
      } catch (e) {
        submitUrl = explicitSubmitPath;
      }
    }
    if (!submitUrl && answerPayload.submit_url) submitUrl = answerPayload.submit_url;
    if (!submitUrl) {
      console.error('No submit URL discovered; cannot submit.');
      await browser.close();
      return;
    }

    // Ensure answer payload contains required top-level fields (email, secret, url)
    answerPayload.email = answerPayload.email || email;
    answerPayload.secret = answerPayload.secret || secret;
    answerPayload.url = answerPayload.url || url;

    // Validate size < 1MB
    const bodyJson = JSON.stringify(answerPayload);
    if (Buffer.byteLength(bodyJson, 'utf8') > 1 * 1024 * 1024) {
      console.error('Answer payload exceeds 1MB; trimming large fields.');
      // trim any big fields conservatively
      if (answerPayload.note) answerPayload.note = answerPayload.note.slice(0, 1000);
      if (answerPayload.text) answerPayload.text = answerPayload.text.slice(0, 1000);
    }

    // POST answer
    console.log('Posting answer to', submitUrl);
    let postResp = null;
    try {
      postResp = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(answerPayload),
        // node-fetch will throw on network errors; no explicit timeout here
      });
    } catch (err) {
      console.error('Network error posting answer:', err);
      await browser.close();
      return;
    }

    let postJson = null;
    try {
      postJson = await postResp.json().catch(() => null);
    } catch (e) {
      postJson = null;
    }
    console.log('Submit response status:', postResp.status, 'body:', postJson);

    // If the submit endpoint returns a next URL, follow it only if within time and recursion budget
    if (postJson && postJson.url && (Date.now() - startTime) < MAX_TOTAL_MS) {
      console.log('Received next URL from submit response:', postJson.url);
      // Recursively process next URL — increment depth to avoid infinite loops
      await browser.close();
      await processQuiz({ email, secret, url: postJson.url, _depth: maxDepth + 1 });
      return;
    }

  } catch (err) {
    console.error('processQuiz error:', err);
  } finally {
    await browser.close();
  }
}

app.listen(PORT, () => console.log(`LLM Analysis Quiz endpoint listening on ${PORT}`));
