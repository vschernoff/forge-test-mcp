// Temporary directories for tests, removed when the test process exits. Integration projects are
// ~24 MB each (forge-std, build output), so leaving them behind filled the OS temp dir with
// gigabytes. Set FORGE_TEST_MCP_KEEP_TMP=1 to keep them for debugging.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const created = new Set()
let hooked = false

function removeAll() {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // A process may still hold it open on Windows; the OS reclaims temp space eventually.
    }
  }
  created.clear()
}

/** A fresh directory under the OS temp dir (real path), removed when this process exits. */
function tempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  if (process.env.FORGE_TEST_MCP_KEEP_TMP === '1') return dir
  created.add(dir)
  if (!hooked) {
    hooked = true
    process.on('exit', removeAll)
  }
  return dir
}

module.exports = { tempDir }
