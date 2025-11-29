// pdf_sum_solver.js
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const pdfParse = require('pdf-parse');

module.exports = async function(page, taskData) {
  // find PDF links
  const pdfLinks = await page.$$eval('a[href$=".pdf"]', els => els.map(a => a.href));
  if ((!pdfLinks || pdfLinks.length === 0) && taskData.htmlPreview) {
    const matches = taskData.htmlPreview.match(/https?:\/\/[^\s'"]+\.pdf/gi);
    if (matches) pdfLinks.push(...matches);
  }
  if (!pdfLinks || pdfLinks.length === 0) return null;

  const pdfUrl = pdfLinks[0];
  console.log('pdf solver: found', pdfUrl);
  try {
    const resp = await fetch(pdfUrl, { timeout: 30000 });
    if (!resp.ok) return null;
    const arrayBuf = await resp.arrayBuffer();
    const data = await pdfParse(Buffer.from(arrayBuf));
    // split by form feeds if present
    const pages = (data.text || '').split(/\f/);
    const page2 = pages[1] || pages[0] || data.text;
    // Try to locate a column named "value" and sum numbers nearby; fallback sum of all numbers
    const valueMatch = page2.match(/value[\s\S]*?:[\s\S]*?(-?\d[\d,\.]*)/i);
    let sum = 0;
    if (valueMatch) {
      // crude approach: find all numbers on page2 and sum them
      const numMatches = page2.match(/-?\d{1,3}(?:[,\d]{0,})?(?:\.\d+)?/g);
      if (numMatches) {
        const nums = numMatches.map(s => parseFloat(s.replace(/,/g,''))).filter(n => !isNaN(n));
        sum = nums.reduce((a,b)=>a+b,0);
      }
    } else {
      // fallback sum of all numbers on page 2
      const numMatches = page2.match(/-?\d{1,3}(?:[,\d]{0,})?(?:\.\d+)?/g);
      if (!numMatches) return null;
      const nums = numMatches.map(s => parseFloat(s.replace(/,/g,''))).filter(n => !isNaN(n));
      sum = nums.reduce((a,b)=>a+b,0);
    }

    return { email: process.env.TEST_EMAIL || '23f2002722@ds.study.iitm.ac.in', secret: process.env.SECRET || 'TDS-23f2-s3cr3t!', url: page.url(), answer: sum };
  } catch (err) {
    console.warn('pdf solver error', err);
    return null;
  }
};
