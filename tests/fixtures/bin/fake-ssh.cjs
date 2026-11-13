'use strict';
// Stand-in for the ssh binary, run through exec.run() as RAMPART_SSH=node:<this file>. It sees only argv: the remote command is
// the last argument. The command is looked up in $FAKE_PROBES/index.json, {"<exact remote command>": "<probeId>" | {probe, exit}},
// and the text of $FAKE_PROBES/<probeId>.txt is printed; a command not in the index exits 127. With {probe, exit} the text is
// printed and the process exits with that code (a probe that fails by design); {exit} alone prints nothing but the exit.
//   FAKE_EXIT       when set, print an ssh-like connection error to stderr and exit with it (255 is a connect failure)
//   FAKE_SLEEP_MS   wait this long before doing anything else (for timeout tests)
//   FAKE_ARGV_OUT   file that receives one JSON line, {tool, argv}, for every invocation

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const env = process.env;

if (env.FAKE_ARGV_OUT) fs.appendFileSync(env.FAKE_ARGV_OUT, `${JSON.stringify({ tool: 'ssh', argv })}\n`);

function finish() {
  if (env.FAKE_EXIT !== undefined) {
    process.stderr.write('ssh: connect to host 192.0.2.10 port 22: Connection refused\n');
    process.exitCode = Number(env.FAKE_EXIT);
    return;
  }
  const index = JSON.parse(fs.readFileSync(path.join(env.FAKE_PROBES, 'index.json'), 'utf8'));
  const entry = index[argv[argv.length - 1]];
  if (entry === undefined) {
    process.stderr.write('fake-ssh: command not found\n');
    process.exitCode = 127;
    return;
  }
  const { probe, exit } = typeof entry === 'string' ? { probe: entry } : entry;
  if (probe) process.stdout.write(fs.readFileSync(path.join(env.FAKE_PROBES, `${probe}.txt`)));
  process.exitCode = exit === undefined ? 0 : exit;
}

const sleep = Number(env.FAKE_SLEEP_MS) || 0;
if (sleep > 0) setTimeout(finish, sleep);
else finish();
