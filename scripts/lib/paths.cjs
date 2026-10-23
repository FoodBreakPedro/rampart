'use strict';
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

// Store root. Read at call time so tests can point RAMPART_HOME at a temp dir.
function rampartHome() {
  return process.env.RAMPART_HOME || path.join(os.homedir(), '.rampart');
}

// Stable per-machine key (12 hex of sha256 of the hostname) for machine-specific values in project.json.
function machineId() {
  return crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 12);
}

function projectDir(slug) {
  return path.join(rampartHome(), 'projects', slug);
}

function runDir(slug, runId) {
  return path.join(projectDir(slug), 'runs', runId);
}

// UTC, filesystem-safe: YYYY-MM-DDTHH-mm-ssZ
function newRunId(date = new Date()) {
  return date.toISOString().slice(0, 19).replace(/:/g, '-') + 'Z';
}

module.exports = { rampartHome, machineId, projectDir, runDir, newRunId };
