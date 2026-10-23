'use strict';
// Stand-in for the gitleaks binary, run through exec.run() as RAMPART_GITLEAKS=node:<this file>.
//   gitleaks version  -> prints 8.99.0-fake
//   gitleaks detect ... --report-path <file> ...  -> writes a fixture to <file> and exits; --source and the rest are ignored.
// Behaviour is steered by environment variables:
//   FAKE_EXIT       exit code (default 1, the "leaks found" code)
//   FAKE_REPORT     fixture in tests/fixtures to copy to the report path (default gitleaks.json)
//   FAKE_NO_REPORT  set to write no report at all
//   FAKE_STDERR     text written to stderr
//   FAKE_SLEEP_MS   wait this long before doing anything else (for timeout tests)
//   FAKE_ARGV_OUT   file that receives one JSON line with the argv of every invocation

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const env = process.env;

if (env.FAKE_ARGV_OUT) fs.appendFileSync(env.FAKE_ARGV_OUT, `${JSON.stringify(argv)}\n`);

function finish() {
  if (argv[0] === 'version') {
    process.stdout.write('8.99.0-fake\n');
    return;
  }
  const at = argv.indexOf('--report-path');
  if (at !== -1 && !env.FAKE_NO_REPORT) {
    const fixture = path.join(__dirname, '..', env.FAKE_REPORT || 'gitleaks.json');
    fs.writeFileSync(argv[at + 1], fs.readFileSync(fixture));
  }
  if (env.FAKE_STDERR) process.stderr.write(`${env.FAKE_STDERR}\n`);
  process.exitCode = env.FAKE_EXIT === undefined ? 1 : Number(env.FAKE_EXIT);
}

const sleep = Number(env.FAKE_SLEEP_MS) || 0;
if (sleep > 0) setTimeout(finish, sleep);
else finish();
