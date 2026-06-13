/**
 * Configuration & fail-fast startup checks.
 *
 * The Alpha Vantage API key is required. We deliberately do NOT fall back to
 * the "demo" key: that key only serves a handful of hard-coded symbols and
 * silently turns every real request into a confusing rate-limit message. It is
 * far better to refuse to start than to run in a broken state.
 */

/** The placeholder key shipped in Alpha Vantage docs — never acceptable for real use. */
const DEMO_KEY = "demo";

/** Cached, validated key so we only resolve/validate once. */
let cachedKey: string | undefined;

/**
 * Validate and return the Alpha Vantage API key.
 *
 * If the key is unset, blank, or the literal "demo" placeholder, this prints a
 * clear, actionable message to stderr and exits the process with code 1.
 * Call it once at startup (fail-fast) and freely thereafter (it caches).
 */
export function requireApiKey(): string {
  if (cachedKey) return cachedKey;

  const key = process.env.ALPHAVANTAGE_API_KEY?.trim();

  if (!key || key.toLowerCase() === DEMO_KEY) {
    const reason = !key
      ? "ALPHAVANTAGE_API_KEY is not set."
      : 'ALPHAVANTAGE_API_KEY is the "demo" placeholder, which only works for a few sample symbols.';

    console.error(
      [
        `FATAL: ${reason}`,
        "",
        "mcp-finance-server needs a real Alpha Vantage API key to start.",
        "Get a free key at: https://www.alphavantage.co/support/#api-key",
        "",
        "Then provide it via one of:",
        "  • .env file:          ALPHAVANTAGE_API_KEY=YOUR_REAL_KEY",
        '  • PowerShell:          $env:ALPHAVANTAGE_API_KEY = "YOUR_REAL_KEY"',
        "  • bash/zsh:            export ALPHAVANTAGE_API_KEY=YOUR_REAL_KEY",
        '  • Claude Desktop:      add it to the server\'s "env" block in claude_desktop_config.json',
      ].join("\n"),
    );
    process.exit(1);
  }

  cachedKey = key;
  return cachedKey;
}
