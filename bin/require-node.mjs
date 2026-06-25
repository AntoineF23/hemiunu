// Friendly Node version guard. On older Node the app otherwise dies deep in
// startup with a cryptic error about a missing API or an ABI-mismatched native
// module — useless to a non-coder. This turns that into a clear, actionable
// message before anything else runs.
const MIN_MAJOR = 20;

export function requireNode(min = MIN_MAJOR) {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < min) {
    console.error(
      `\nHemiunu needs Node ${min} or newer — you're on Node ${process.versions.node}.\n\n` +
        `Install a newer Node from https://nodejs.org, or with nvm:\n` +
        `  nvm install ${min} && nvm use ${min}\n`,
    );
    process.exit(1);
  }
}
