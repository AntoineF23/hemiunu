// Presentation formatters now live in the shared @hemiunu/format package so the
// CLI and the web worker render tool calls/results from ONE source of truth (no
// more hand-kept duplication). Re-exported here to keep existing import paths
// (`../format`) stable.
export {
  clip,
  title,
  prettyTool,
  resultText,
  toolPreview,
  summarizeResult,
  cleanResultPreview,
  shortId,
  shortPath,
} from "@hemiunu/format";
