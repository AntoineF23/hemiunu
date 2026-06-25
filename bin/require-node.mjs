// Friendly Node version guard. Hemiunu uses Node's built-in `node:sqlite`, which
// landed in Node 24. On older Node the app otherwise dies deep in startup with a
// cryptic "No such built-in module: node:sqlite" — useless to a non-coder. This
// turns that into a clear, actionable message before anything else runs.
const MIN_MAJOR = 24;

export function requireNode(min = MIN_MAJOR) {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < min) {
    console.error(
      `\nHemiunu needs Node ${min} or newer — you're on Node ${process.versions.node}.\n` +
        `(It uses Node's built-in SQLite, which was added in Node ${min}.)\n\n` +
        `Install a newer Node from https://nodejs.org, or with nvm:\n` +
        `  nvm install ${min} && nvm use ${min}\n`,
    );
    process.exit(1);
  }
}
