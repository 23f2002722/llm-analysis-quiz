// solvers/direct_json_solver.js
// Detect pages that instruct to "POST this JSON to /submit" or contain an inline JSON block.
// Returns an object { email, secret, url, answer } to be posted by main server.

module.exports = async function(page, taskData, incomingPayload) {
  // incomingPayload contains { email, secret, url }
  const pageText = taskData.text || (await page.evaluate(() => document.body.innerText)) || '';

  // 1) Look for an explicit "POST this JSON to <path>" and an adjacent JSON block
  // Simple pattern: "POST this JSON to /submit" and then a JSON block in the text/html.
  const postPathMatch = pageText.match(/POST\s+this\s+JSON\s+to\s+([^\s]+)/i);
  let submitPath = postPathMatch ? postPathMatch[1].trim() : null;

  // 2) Find first JSON object in the page (between { and } with balancing)
  const jsonMatch = pageText.match(/\{[\s\S]*\}/);
  let parsed = null;
  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      // if JSON parse fails, attempt a lenient fix: replace single quotes, trailing commas
      try {
        const cleaned = jsonMatch[0]
          .replace(/(['"])?([a-zA-Z0-9_]+)\1\s*:/g, '"$2":')    // ensure keys quoted
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']')
          .replace(/'/g, '"');
        parsed = JSON.parse(cleaned);
      } catch (e2) {
        parsed = null;
      }
    }
  }

  // If parsed JSON available, fill placeholders
  if (parsed && typeof parsed === 'object') {
    // Fill with incomingPayload values if keys exist
    if ('email' in parsed) parsed.email = incomingPayload.email;
    if ('secret' in parsed) parsed.secret = incomingPayload.secret;
    if ('url' in parsed) parsed.url = incomingPayload.url || parsed.url;

    // If answer field exists but is placeholder, provide something valid (e.g. a string)
    if (!('answer' in parsed) || parsed.answer === 'anything you want' || parsed.answer === '') {
      parsed.answer = parsed.answer || 'demo-solution';
    }
    // Return the object and a submit_url hint if submitPath discovered
    const submit_hint = submitPath || null;
    return { payload: parsed, submit_path: submit_hint };
  }

  // If no JSON parsed but we found "POST ... to /submit", build a minimal payload
  if (submitPath) {
    const payload = {
      email: incomingPayload.email,
      secret: incomingPayload.secret,
      url: incomingPayload.url,
      answer: 'demo-solution'
    };
    return { payload, submit_path: submitPath };
  }

  // No match
  return null;
};
