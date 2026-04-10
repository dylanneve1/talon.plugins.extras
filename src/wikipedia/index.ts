/**
 * Wikipedia MCP plugin — wraps the wikipedia-mcp Python package.
 *
 * Provides Wikipedia search, article retrieval, summaries, sections,
 * and link extraction via the official wikipedia-mcp MCP server.
 *
 * @see https://github.com/Rudra-ravi/wikipedia-mcp
 */

const PYTHON_PATH =
  process.env.TALON_WIKIPEDIA_PYTHON ??
  `${process.env.HOME}/.talon/wikipedia-mcp-venv/bin/python`;

const plugin = {
  name: "wikipedia",
  description: "Wikipedia search, articles, summaries, sections, and links",
  version: "1.0.0",

  mcpServer: {
    command: PYTHON_PATH,
    args: ["-m", "wikipedia_mcp"],
  },

  getSystemPromptAddition(): string {
    return `## Wikipedia
You have access to Wikipedia tools for searching and reading articles. These are provided by the wikipedia-mcp server:
- Search Wikipedia articles by keyword
- Get full article content or concise summaries
- Extract specific sections from articles
- Find internal links and related topics
Multi-language support available.`;
  },
} as const;

export default plugin;
