'use strict';
// Whole-file writes that a crash or a reader never sees half done: the data goes to a temp file next to the target, which is
// then renamed over it. On Windows a rename onto a file that an antivirus scanner, the search indexer or a reader holds open
// fails for a moment with EPERM, EACCES or EBUSY, so those are retried a few times, with a short wait, before giving up.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RENAME_TRIES = 5;
const RENAME_WAIT_MS = 20; // times the attempt number: 20, 40, 60 and 80 ms between the five tries
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Rename from over to, retrying a transient lock. Throws the last error when every try failed, or the first error that is not
// a lock. rename and wait are for tests.
function renameWithRetry(from, to, { rename = fs.renameSync, wait = pause } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return attempt;
    } catch (err) {
      if (!RETRYABLE.has(err && err.code) || attempt >= RENAME_TRIES) throw err;
      wait(RENAME_WAIT_MS * attempt);
    }
  }
}

// Write data to file through a temp file in the same directory and a rename. A failed write removes the temp file.
function writeAtomic(file, data, options) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    renameWithRetry(tmp, file, options);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

module.exports = { writeAtomic, renameWithRetry, RENAME_TRIES };
