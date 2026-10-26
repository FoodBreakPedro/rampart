'use strict';
// Waits a few seconds, then exits 0. The audit recipe runs it while a Workflow run is in progress, so the session keeps
// waiting for the run's completion notice instead of ending its turn.
//   node scripts/wait.cjs <seconds>     a whole number from 1 to 60. Exit 0 after waiting, 2 for a bad argument.

const USAGE = 'usage: node scripts/wait.cjs <seconds>   (a whole number from 1 to 60)';

function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const seconds = argv.length === 1 && /^[0-9]{1,2}$/.test(argv[0]) ? Number(argv[0]) : NaN;
  if (!(seconds >= 1 && seconds <= 60)) {
    stderr.write(`wait: ${argv.length === 1 ? `not a whole number of seconds from 1 to 60: ${argv[0].slice(0, 20)}` : 'one argument is required'}\n${USAGE}\n`);
    return Promise.resolve(2);
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      stdout.write(`waited ${seconds}s\n`);
      resolve(0);
    }, seconds * 1000);
  });
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { main };
