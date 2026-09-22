// Reading the controller's prime log. Run with `npm test`.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPrimeRecords, latestPrimeRuns } = require('../lib/prime_log.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prime-'));
const file = path.join(dir, 'prime_events.jsonl');

// No log yet (a fresh machine): empty, not an error.
assert.deepStrictEqual(readPrimeRecords(file), []);

const lines = [];
for (let n = 1; n <= 205; n++) {
  lines.push(JSON.stringify({ machine_id: 'M1', slot: String((n % 6) + 1),
                              seconds: 3, date_created: 'run' + n }));
}
lines.splice(10, 0, '{not json');            // one bad line must not hide the rest
fs.writeFileSync(file, lines.join('\n') + '\n\n');

assert.strictEqual(readPrimeRecords(file).length, 205);
const latest = latestPrimeRuns(file);
assert.strictEqual(latest.length, 200);      // capped
assert.strictEqual(latest[0].date_created, 'run205');   // newest first
assert.strictEqual(latest[199].date_created, 'run6');
assert.strictEqual(latestPrimeRuns(file, 3).length, 3);

fs.rmSync(dir, { recursive: true, force: true });
console.log('prime log: ok');
