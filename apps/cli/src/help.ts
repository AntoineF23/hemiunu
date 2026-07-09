export function printHelp(): void {
  // process.env.HEMIUNU_VERSION is injected at bundle time (see build-release.mjs);
  // undefined when running buildless via tsx in dev.
  const version = process.env.HEMIUNU_VERSION ?? "dev";
  console.log(`hemiunu ${version} — product agent for your terminal

Usage:
  hemiunu                 start, picking a team interactively
  hemiunu owner/repo      start on a specific team (added if new)
  hemiunu local           start with no team (a local workspace)

Options:
  -v, --version           print version and exit
  -h, --help              show this help and exit

First run asks which model provider you want — Anthropic, OpenAI, Gemini, a
gateway (LiteLLM/OpenRouter/vLLM), or a local Ollama (no key) — and only that
credential is required; it's saved to ~/.hemiunu/.env.
Models are bring-your-own. Docs: https://github.com/AntoineF23/hemiunu`);
}
