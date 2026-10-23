const fs = require('node:fs')
const path = require('node:path')

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Finds the Foundry project root the way forge does (foundry `find_project_root`, v1.8.6
 * crates/config/src/utils.rs:58): the nearest directory, from `start` upwards, that holds a
 * foundry.toml file, without climbing past the enclosing git root.
 * Returns null when there is none: forge would then exit 0 with "Nothing to compile",
 * which must never read as a clean run (FR-35).
 */
function findFoundryRoot(start) {
  let dir = path.resolve(start)
  for (;;) {
    if (isFile(path.join(dir, 'foundry.toml'))) return dir
    const parent = path.dirname(dir)
    if (fs.existsSync(path.join(dir, '.git')) || parent === dir) return null
    dir = parent
  }
}

module.exports = { findFoundryRoot }
