'use strict';
// Stand-in for the trivy binary, run through exec.run() as RAMPART_TRIVY=node:<this file>.
//   trivy fs --scanners vuln --format json --quiet <path>  -> prints a fixture to stdout and exits; every argument is ignored.
// Behaviour is steered by environment variables:
//   FAKE_EXIT       exit code (default 0, the code of a finished trivy scan)
//   FAKE_REPORT     fixture in tests/fixtures to print (default trivy.json)
//   FAKE_STDOUT     literal text to print instead of a fixture
//   FAKE_NO_REPORT  set to print nothing on stdout
//   FAKE_STDERR     text written to stderr
//   FAKE_SLEEP_MS   wait this long before doing anything else (for timeout tests)
//   FAKE_ARGV_OUT   file that receives one JSON line, {tool, argv, cwd}, for every invocation

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const env = process.env;

if (env.FAKE_ARGV_OUT) fs.appendFileSync(env.FAKE_ARGV_OUT, `${JSON.stringify({ tool: 'trivy', argv, cwd: process.cwd() })}\n`);

function finish() {
  if (env.FAKE_STDOUT !== undefined) process.stdout.write(env.FAKE_STDOUT);
  else if (!env.FAKE_NO_REPORT) process.stdout.write(fs.readFileSync(path.join(__dirname, '..', env.FAKE_REPORT || 'trivy.json')));
  if (env.FAKE_STDERR) process.stderr.write(`${env.FAKE_STDERR}\n`);
  process.exitCode = env.FAKE_EXIT === undefined ? 0 : Number(env.FAKE_EXIT);
}

const sleep = Number(env.FAKE_SLEEP_MS) || 0;
if (sleep > 0) setTimeout(finish, sleep);
else finish();
