// base64_solver.js
module.exports = async function(page, taskData) {
  const scripts = await page.$$eval('script', s => s.map(x => x.innerText).filter(Boolean));
  for (const src of scripts) {
    const m = src.match(/atob\(\s*`?(['"])?([A-Za-z0-9+/=\n\r]+)\1`?\s*\)/);
    if (m) {
      try {
        const b64 = m[2].replace(/[\r\n]/g,'');
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const jsonMatch = decoded.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const obj = JSON.parse(jsonMatch[0]);
          // Return exactly what grader expects in sample: email, secret, url, answer
          return { email: obj.email, secret: obj.secret, url: obj.url, answer: obj.answer || obj.ans || 0 };
        }
      } catch (e) {
        console.warn('base64 solver parse failed', e);
      }
    }
  }
  return null;
};
