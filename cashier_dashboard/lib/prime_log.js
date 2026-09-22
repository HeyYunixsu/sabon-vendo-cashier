// The controller's prime log (logs/prime_events.jsonl): one JSON object per
// line, {machine_id, slot, seconds, date_created}, appended oldest first.
const fs = require('fs');

// Every record, oldest first. One malformed line must not hide the rest.
function readPrimeRecords(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip one bad line */ }
  }
  return out;
}

// The latest `limit` runs, newest first.
function latestPrimeRuns(file, limit = 200) {
  return readPrimeRecords(file).reverse().slice(0, limit);
}

module.exports = { readPrimeRecords, latestPrimeRuns };
