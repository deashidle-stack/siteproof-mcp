# SiteProof MCP Server

> Connect Claude, ChatGPT, Cursor, and other AI agents directly to [Deveras](https://deveras.no) website quality scanners via the [Model Context Protocol](https://modelcontextprotocol.io/).

**Server URL:** `https://mcp.deveras.no/mcp`

## Quick Start

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "siteproof": {
      "url": "https://mcp.deveras.no/mcp"
    }
  }
}
```

Works with Claude Desktop, ChatGPT, Cursor, Windsurf, and any MCP-compatible client.

## Tools

| Tool | Description |
|------|-------------|
| `scan_accessibility` | Run a WCAG accessibility + UX quality scan on any URL. Returns overall score, grade, and categorized issues with severity levels. |
| `scan_aeo` | AI Engine Optimization scan — checks how well a page is optimized for AI search engines (ChatGPT, Perplexity, Google AI Overviews). |
| `scan_agentproof` | AI agent security scan — verifies robots.txt, ai.txt, llms.txt, and other agent compliance signals. |
| `get_fix_suggestion` | Get a concrete code fix (before/after) for a specific WCAG accessibility rule. Supports 15 common violation types. |
| `get_compliance_status` | Estimate EU Accessibility Act (EAA) compliance readiness based on scan results. |
| `get_fix_recipe` | (Pro) Get structured fix recipes with before/after code, validation selectors, and framework-specific variants for React, Vue, Angular, Svelte, and Next.js. Accepts a URL to scan or raw axe-core violation JSON (BYOV). |

## Example Usage

Ask your AI agent:

- *"Scan https://example.com for accessibility issues"*
- *"How do I fix missing alt text on images?"*
- *"Check if my site is ready for the EU Accessibility Act"*
- *"How well is my site optimized for AI search engines?"*
- *"Scan my site's AI agent security configuration"*

## Architecture

- **Runtime:** Cloudflare Workers + Durable Objects
- **Protocol:** MCP over SSE (Streamable HTTP)
- **Backend:** Proxies to the [SiteProof REST API](https://api.deveras.no/v1/docs)
- **Scanner:** Browser Rendering API + axe-core for WCAG analysis

## Related

- [SiteProof REST API](https://api.deveras.no/v1/docs) — Direct API access
- [SiteProof GitHub Action](https://github.com/deashidle-stack/siteproof-action) — CI/CD quality gate
- [Deveras](https://deveras.no) — AI Truth Stack platform

## License

MIT
