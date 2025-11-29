// csv_solver.js
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const csvParse = (text) => {
  // minimal CSV splitter
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(',').map(c => c.trim()));
  return { headers, rows };
};

module.exports = async function(page, taskData) {
  // find CSV links
  const csvLinks = await page.$$eval('a[href$=".csv"]', els => els.map(a => a.href));
  if ((!csvLinks || csvLinks.length === 0) && taskData.htmlPreview) {
    const matches = taskData.htmlPreview.match(/https?:\/\/[^\s'"]+\.csv/gi);
    if (matches) csvLinks.push(...matches);
  }
  if (!csvLinks || csvLinks.length === 0) return null;

  const csvUrl = csvLinks[0];
  try {
    const resp = await fetch(csvUrl, { timeout: 20000 });
    const txt = await resp.text();
    const { headers, rows } = csvParse(txt);
    // If question asks to sum a column named value or Value
    const idx = headers.findIndex(h => /value/i.test(h));
    if (idx === -1) return null;
    const nums = rows.map(r => parseFloat((r[idx]||'').replace(/,/g,''))).filter(n => !isNaN(n));
    const sum = nums.reduce((a,b)=>a+b,0);
    return { email: process.env.TEST_EMAIL || '23f2002722@ds.study.iitm.ac.in', secret: process.env.SECRET || 'TDS-23f2-s3cr3t!', url: page.url(), answer: sum };
  } catch (err) {
    console.warn('csv solver error', err);
    return null;
  }
};
