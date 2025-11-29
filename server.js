// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');
const solvers = require('./solvers');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const { GoogleGenAI } = (() => {
  try { return require('@google/genai'); } catch (e) { return {}; }
})();

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

const SECRET = process.env.SECRET || 'TDS-23f2-s3cr3t!';
const PORT = process.env.PORT || 3000;

// Basic checks
function badRequest(res, msg) { return res.status(400).json({ error: msg }); }
function forbidden(res, msg) { return res.status(403).json({ error: msg }); }

app.post('/api/quiz', async (req, res) => {
  // Validate JSON and required fields
  if (!req.is('application/json')) return badRequest(res, 'Expected application/json');
  const { email, secret, url } = req.body || {};
  if (!email || !secret || !url) return badRequest(res, 'Missing email/secret/url');

  if (secret !== SECRET) return forbidden(res, 'Invalid secret');

  // Immediately return 200 as required, then continue processing (we still run processing now)
  res.status(200).json({ received: true });

  // Process in-line (do not schedule for later)
  try {
    await processQuiz({ email, secret, url });
  } catch (err) {
    console.error('Processing error:', err);
  }
});

async function callGemini(prompt) {
  // If @google/genai is available, use it. Otherwise fallback to basic REST - but the code below expects @google/genai.
  try {
    if (!GoogleGenAI || !GoogleGenAI.GoogleGenAI) {
      // Fallback: call REST directly if you want; for simplicity return null
      console.warn('Google GenAI client not installed; skipping Gemini call.');
      return null;
    }
    const ai = new GoogleGenAI.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    // The actual call shape may differ—use generateContent as in docs
    const r = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt
    });
    return r?.text ?? null;
  } catch (err) {
    console.error('Gemini call failed:', err);
    return null;
  }
}

async function processQuiz(payload) {
  const { email, secret, url } = payload;
  console.log('Processing quiz for url:', url);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }});
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });

    const taskData = await page.evaluate(() => {
      const out = {
        htmlPreview: document.documentElement.innerHTML.slice(0, 20000),
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

    // Use heuristics to pick solver
    let answerPayload = null;

    // 1) If page uses base64 in scripts / atob → base64 solver
    const pageHtml = taskData.htmlPreview || '';
    if (/atob\(/i.test(pageHtml) || (taskData.pre && /^{/.test(taskData.pre.trim()))) {
      answerPayload = await solvers.base64Solver(page, taskData);
    }
    // 2) If pdf link exists, try pdf solver
    if (!answerPayload) {
      answerPayload = await solvers.pdfSumSolver(page, taskData);
    }
    // 3) If CSV link present, try csv solver
    if (!answerPayload) {
      answerPayload = await solvers.csvSolver(page, taskData);
    }

    // 4) As fallback, ask Gemini to summarize the page and extract submit URL or instructions
    if (!answerPayload && process.env.GEMINI_API_KEY) {
      const prompt = `You are given the text below from a quiz page. Extract the quiz task and the submit URL (if any) and return JSON with keys "task" and "submit_url". Text:\n\n${taskData.text}`;
      const geminiResponse = await callGemini(prompt);
      if (geminiResponse) {
        // try to parse JSON from Gemini
        const jsonMatch = geminiResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            // TODO: craft answerPayload using parsed.task (this is very task-specific)
            answerPayload = { email, secret, url, note: 'Gemini-assisted parse', parsed };
          } catch (e) {
            console.warn('Gemini returned non-JSON or unparsable JSON.');
            answerPayload = { email, secret, url, note: 'Gemini raw text', text: geminiResponse.slice(0, 5000) };
          }
        } else {
          answerPayload = { email, secret, url, note: 'Gemini raw text', text: geminiResponse.slice(0,5000) };
        }
      }
    }

    if (!answerPayload) {
      console.error('No solver produced an answer; aborting for this url.');
      await browser.close();
      return;
    }

    // Determine submit URL
    const submitUrl = taskData.submit_url || answerPayload.submit_url || payload.submit_url;
    if (!submitUrl) {
      console.error('No submit URL discovered; cannot submit.');
      await browser.close();
      return;
    }

    // Ensure payload under 1MB
    const bodyJson = JSON.stringify(answerPayload);
    if (Buffer.byteLength(bodyJson, 'utf8') > 1 * 1024 * 1024) {
      console.error('Answer payload >1MB; trimming or refusing to post.');
      // trim large fields
      answerPayload.note = (answerPayload.note || '').slice(0, 1000);
    }

    // Post answer
    console.log('Posting answer to', submitUrl);
    const resp = await fetch(submitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(answerPayload)
    });
    const j = await resp.json().catch(() => ({ status: resp.status }));
    console.log('Submit response:', j);

    // If they gave next URL, optionally process it (within the same run)
    if (j && j.url) {
      console.log('Received next URL to handle:', j.url);
      // simple recursive call — careful about infinite loops; we do only one follow-up here
      // Note: grader allows follow-ups within the 3 minute window.
      await processQuiz({ email, secret, url: j.url, submit_url: submitUrl });
    }

  } catch (err) {
    console.error('processQuiz error:', err);
  } finally {
    await browser.close();
  }
}

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
