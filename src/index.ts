/**
 * SiteProof MCP Server — Cloudflare Worker
 *
 * Exposes WCAG accessibility scanning as MCP tools for AI agents
 * (Claude Desktop, ChatGPT, Cursor, etc.)
 *
 * Uses McpAgent (Durable Objects) for session handling.
 * Proxies to siteproof-public-api for actual scanning.
 *
 * Tools:
 *   scan_accessibility  — Run WCAG + UX scan on a URL
 *   scan_aeo            — AI Engine Optimization scan
 *   scan_agentproof     — AI agent config security scan
 *   get_compliance_status — EAA compliance estimate
 *   get_fix_suggestion  — Code fix for a specific WCAG rule
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── Types ──────────────────────────────────────────────

interface Env {
  SITEPROOF_API_KEY: string;
  SITEPROOF_API_URL: string;
  SiteProofMCP: DurableObjectNamespace;
}

// ── Helpers ────────────────────────────────────────────

function txt(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function apiCall(env: Env, path: string, body?: object): Promise<any> {
  const url = `${env.SITEPROOF_API_URL}${path}`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.SITEPROOF_API_KEY,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json();
  if (!data.success) {
    throw new Error(data.error?.message || `API error: ${res.status}`);
  }
  return data;
}

// ── Fix suggestions knowledge base ─────────────────────

const FIX_SUGGESTIONS: Record<string, { title: string; wcag: string; snippet: string; explanation: string }> = {
  missing_alt_text: {
    title: "Missing Image Alt Text",
    wcag: "1.1.1 Non-text Content (A)",
    snippet: `<!-- Before -->\n<img src="hero.jpg">\n\n<!-- After -->\n<img src="hero.jpg" alt="Team collaborating around a whiteboard">`,
    explanation: "Every <img> needs an alt attribute. Use descriptive text for informative images, or alt=\"\" for decorative ones.",
  },
  empty_links: {
    title: "Empty Links",
    wcag: "2.4.4 Link Purpose (A)",
    snippet: `<!-- Before -->\n<a href="/about"><i class="icon-arrow"></i></a>\n\n<!-- After -->\n<a href="/about" aria-label="About us"><i class="icon-arrow"></i></a>`,
    explanation: "Links must have discernible text. Add inner text, aria-label, or aria-labelledby.",
  },
  empty_buttons: {
    title: "Empty Buttons",
    wcag: "4.1.2 Name, Role, Value (A)",
    snippet: `<!-- Before -->\n<button><svg>...</svg></button>\n\n<!-- After -->\n<button aria-label="Close dialog"><svg>...</svg></button>`,
    explanation: "Buttons need accessible names. Add visible text or aria-label for icon-only buttons.",
  },
  missing_form_labels: {
    title: "Missing Form Labels",
    wcag: "1.3.1 Info and Relationships (A)",
    snippet: `<!-- Before -->\n<input type="email" placeholder="Email">\n\n<!-- After -->\n<label for="email">Email</label>\n<input type="email" id="email" placeholder="you@example.com">`,
    explanation: "Every form input needs an associated <label> with a matching for/id pair. Placeholder alone is not sufficient.",
  },
  color_contrast: {
    title: "Insufficient Color Contrast",
    wcag: "1.4.3 Contrast Minimum (AA)",
    snippet: `/* Before: ratio 2.5:1 */\n.text { color: #999; background: #fff; }\n\n/* After: ratio 4.6:1 */\n.text { color: #595959; background: #fff; }`,
    explanation: "Normal text needs 4.5:1 contrast ratio; large text (18pt+) needs 3:1. Use a contrast checker tool.",
  },
  missing_lang: {
    title: "Missing Language Attribute",
    wcag: "3.1.1 Language of Page (A)",
    snippet: `<!-- Before -->\n<html>\n\n<!-- After -->\n<html lang="en">`,
    explanation: "The <html> element must have a valid lang attribute so screen readers use the correct pronunciation.",
  },
  heading_hierarchy: {
    title: "Heading Hierarchy Issues",
    wcag: "1.3.1 Info and Relationships (A)",
    snippet: `<!-- Before: skips h2 -->\n<h1>Page Title</h1>\n<h3>Section</h3>\n\n<!-- After: proper hierarchy -->\n<h1>Page Title</h1>\n<h2>Section</h2>`,
    explanation: "Headings must follow a logical hierarchy (h1 → h2 → h3). Never skip levels.",
  },
  missing_document_title: {
    title: "Missing Document Title",
    wcag: "2.4.2 Page Titled (A)",
    snippet: `<!-- Add to <head> -->\n<title>Products - SiteProof Accessibility Scanner</title>`,
    explanation: "Every page needs a unique, descriptive <title> element. Format: 'Page Name - Site Name'.",
  },
  skip_navigation: {
    title: "Missing Skip Navigation",
    wcag: "2.4.1 Bypass Blocks (A)",
    snippet: `<!-- Add as first child of <body> -->\n<a href="#main-content" class="skip-link">Skip to main content</a>\n\n<!-- Target element -->\n<main id="main-content">...</main>\n\n<style>\n.skip-link {\n  position: absolute;\n  top: -40px;\n  left: 0;\n  padding: 8px;\n  z-index: 100;\n}\n.skip-link:focus {\n  top: 0;\n}\n</style>`,
    explanation: "Keyboard users need a skip link to bypass repetitive navigation. Make it visible on focus.",
  },
  landmark_regions: {
    title: "Missing Landmark Regions",
    wcag: "1.3.1 Info and Relationships (A)",
    snippet: `<header>...</header>\n<nav aria-label="Main navigation">...</nav>\n<main>...</main>\n<footer>...</footer>`,
    explanation: "Use HTML5 landmark elements (<header>, <nav>, <main>, <footer>) so screen readers can navigate by region.",
  },
  autoplay_media: {
    title: "Auto-playing Media",
    wcag: "1.4.2 Audio Control (A)",
    snippet: `<!-- Before -->\n<video autoplay>\n\n<!-- After: muted autoplay is acceptable -->\n<video autoplay muted>`,
    explanation: "Audio that plays automatically for more than 3 seconds must have a pause/stop mechanism. Muted autoplay is generally acceptable.",
  },
  viewport_zoom: {
    title: "Viewport Zoom Disabled",
    wcag: "1.4.4 Resize Text (AA)",
    snippet: `<!-- Before -->\n<meta name="viewport" content="width=device-width, maximum-scale=1, user-scalable=no">\n\n<!-- After -->\n<meta name="viewport" content="width=device-width, initial-scale=1">`,
    explanation: "Never set user-scalable=no or maximum-scale=1. Users must be able to zoom to 200%.",
  },
  aria_attributes: {
    title: "Invalid ARIA Attributes",
    wcag: "4.1.2 Name, Role, Value (A)",
    snippet: `<!-- Before: invalid role -->\n<div role="main-nav">\n\n<!-- After: valid ARIA role -->\n<nav aria-label="Main">`,
    explanation: "ARIA attributes must use valid roles, states, and properties. Prefer native HTML semantics over ARIA.",
  },
  duplicate_ids: {
    title: "Duplicate Element IDs",
    wcag: "4.1.1 Parsing (A)",
    snippet: `<!-- Before: duplicate id -->\n<div id="nav">...</div>\n<div id="nav">...</div>\n\n<!-- After: unique ids -->\n<div id="main-nav">...</div>\n<div id="footer-nav">...</div>`,
    explanation: "Every id attribute must be unique on the page. Duplicates break label associations and ARIA references.",
  },
  table_headers: {
    title: "Missing Table Headers",
    wcag: "1.3.1 Info and Relationships (A)",
    snippet: `<!-- Before -->\n<table>\n  <tr><td>Name</td><td>Price</td></tr>\n</table>\n\n<!-- After -->\n<table>\n  <thead>\n    <tr><th scope="col">Name</th><th scope="col">Price</th></tr>\n  </thead>\n  <tbody>...</tbody>\n</table>`,
    explanation: "Data tables need <th> elements with scope attributes so screen readers can associate headers with cells.",
  },
  focus_indicators: {
    title: "Missing Focus Indicators",
    wcag: "2.4.7 Focus Visible (AA)",
    snippet: `/* Never do this without a replacement */\n/* :focus { outline: none; } */\n\n/* Better: custom focus style */\n:focus-visible {\n  outline: 2px solid #4f46e5;\n  outline-offset: 2px;\n}`,
    explanation: "Interactive elements must have a visible focus indicator. Use :focus-visible for keyboard-only styling.",
  },
};

// ── MCP Agent ──────────────────────────────────────────

export class SiteProofMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "siteproof",
    version: "1.0.0",
  });

  async init() {
    // ── Tool 1: scan_accessibility ─────────────────

    this.server.tool(
      "scan_accessibility",
      "Scan a website for WCAG 2.1 accessibility issues and UX problems. Returns score, grade, and specific issues with fix suggestions.",
      {
        url: z.string().url().describe("The URL to scan (e.g. 'https://example.com')"),
        depth: z
          .enum(["quick", "deep"])
          .default("quick")
          .describe("'quick' = regex-based (~2s), 'deep' = browser-based with axe-core (~15s, Pro only)"),
      },
      async ({ url, depth }) => {
        try {
          const data = await apiCall(this.env, "/v1/scan", { url, depth });
          const d = data.data;

          const summary = [
            `## Accessibility Scan: ${d.url}`,
            "",
            `**Overall Score:** ${d.score.overall}/100 (Grade: ${d.grade})`,
            `**WCAG Score:** ${d.score.wcag ?? "N/A"} | **UX Score:** ${d.score.human ?? "N/A"}`,
            `**Scan Depth:** ${d.scan_depth} | **Duration:** ${d.duration_ms}ms`,
            `**Coverage:** ${d.coverage}`,
            "",
          ];

          const issues = d.issues || [];

          if (issues.length > 0) {
            summary.push(`### Issues Found (${issues.length})`);
            summary.push("");
            for (const issue of issues) {
              const severity = issue.severity || "moderate";
              const icon = severity === "critical" ? "🔴" : severity === "serious" ? "🟠" : "🟡";
              summary.push(`${icon} **${issue.rule}** — ${issue.title} (${severity})`);
              if (issue.detail) summary.push(`   ${issue.detail}`);
              if (issue.wcag) summary.push(`   WCAG: ${issue.wcag}`);
              if (issue.fix) summary.push(`   💡 Fix: ${issue.fix}`);
              summary.push("");
            }
          }

          if (d.passes > 0) {
            summary.push(`### Passing: ${d.passes} checks`);
          }

          if (d.recommendations?.length > 0) {
            summary.push("");
            summary.push(`### Top Recommendations`);
            for (const rec of d.recommendations) {
              summary.push(`- [${rec.priority}] **${rec.title}** — ${rec.detail}`);
            }
          }

          summary.push("");
          summary.push(`*Scans remaining today: ${data.meta.scans_remaining}*`);

          return txt(summary.join("\n"));
        } catch (err: any) {
          return txt(`Error scanning ${url}: ${err.message}`);
        }
      }
    );

    // ── Tool 2: scan_aeo ───────────────────────────

    this.server.tool(
      "scan_aeo",
      "Scan a website for AI Engine Optimization (AEO). Measures how well a page is optimized to be cited by AI search engines like ChatGPT, Perplexity, and Google AI Overviews. Scores across 5 categories: Structured Data, Content Structure, Technical SEO, Authority, and Citation Readiness (each 0-20, total 0-100).",
      {
        url: z.string().url().describe("The URL to scan for AI-readiness (e.g. 'https://example.com')"),
      },
      async ({ url }) => {
        try {
          const data = await apiCall(this.env, "/v1/aeo", { url });
          const d = data.data;
          const cats = d.score.categories;

          const summary = [
            `## AEO Scan: ${d.url}`,
            "",
            `**Overall Score:** ${d.score.total}/100 (Grade: ${d.grade})`,
            "",
            "### Category Breakdown",
            `| Category | Score |`,
            `|----------|-------|`,
            `| Structured Data | ${cats.structuredData}/20 |`,
            `| Content Structure | ${cats.contentStructure}/20 |`,
            `| Technical SEO | ${cats.technical}/20 |`,
            `| Authority | ${cats.authority}/20 |`,
            `| Citation Readiness | ${cats.citationReadiness}/20 |`,
            "",
          ];

          const checks = d.checks || [];
          if (checks.length > 0) {
            summary.push("### Checks");
            summary.push("");
            for (const check of checks) {
              const icon = check.passed ? "✅" : "❌";
              summary.push(`${icon} **${check.name}** — ${check.description || ""}`);
              if (check.details) summary.push(`   ${check.details}`);
            }
            summary.push("");
          }

          const recs = d.recommendations || [];
          if (recs.length > 0) {
            summary.push("### Recommendations");
            for (const rec of recs) {
              summary.push(`- **${rec.title || rec.category}** — ${rec.description || rec.detail || ""}`);
            }
            summary.push("");
          }

          summary.push(`**Duration:** ${d.duration_ms}ms`);
          summary.push(`*Scans remaining today: ${data.meta.scans_remaining}*`);

          return txt(summary.join("\n"));
        } catch (err: any) {
          return txt(`Error scanning ${url} for AEO: ${err.message}`);
        }
      }
    );

    // ── Tool 3: scan_agentproof ─────────────────────

    this.server.tool(
      "scan_agentproof",
      "Scan an AI agent configuration (OpenClaw format) for security vulnerabilities. Checks 18 rules across 4 categories: Secrets Management, Access Control, Sandbox Isolation, and Network Security (each 0-25, total 0-100). Use this to audit AI agent deployments before production.",
      {
        config: z
          .record(z.any())
          .describe("OpenClaw AI agent configuration object to scan for security vulnerabilities"),
      },
      async ({ config }) => {
        try {
          const data = await apiCall(this.env, "/v1/agentproof", { config });
          const d = data.data;
          const cats = d.score.categories;

          const summary = [
            `## AgentProof Security Scan`,
            "",
            `**Overall Score:** ${d.score.total}/100 (Grade: ${d.grade})`,
            "",
            "### Category Breakdown",
            `| Category | Score |`,
            `|----------|-------|`,
            `| Secrets Management | ${cats.secrets}/25 |`,
            `| Access Control | ${cats.access}/25 |`,
            `| Sandbox Isolation | ${cats.sandbox}/25 |`,
            `| Network Security | ${cats.network}/25 |`,
            "",
          ];

          if (d.summary) {
            summary.push(`**Summary:** ${d.summary}`);
            summary.push("");
          }

          const checks = d.checks || [];
          if (checks.length > 0) {
            summary.push("### Checks");
            summary.push("");
            for (const check of checks) {
              const icon = check.passed ? "✅" : check.severity === "critical" ? "🔴" : check.severity === "high" ? "🟠" : "❌";
              summary.push(`${icon} **${check.name || check.id}** — ${check.description || ""}`);
              if (check.details) summary.push(`   ${check.details}`);
            }
            summary.push("");
          }

          const recs = d.recommendations || [];
          if (recs.length > 0) {
            summary.push("### Recommendations");
            for (const rec of recs) {
              summary.push(`- **${rec.title || rec.category}** — ${rec.description || rec.detail || ""}`);
            }
            summary.push("");
          }

          summary.push(`*Scans remaining today: ${data.meta.scans_remaining}*`);

          return txt(summary.join("\n"));
        } catch (err: any) {
          return txt(`Error scanning agent config: ${err.message}`);
        }
      }
    );

    // ── Tool 4: get_compliance_status ──────────────

    this.server.tool(
      "get_compliance_status",
      "Check a website's compliance with the European Accessibility Act (EAA) based on EN 301 549 / WCAG 2.1 AA requirements.",
      {
        url: z.string().url().describe("The URL to check for EAA compliance"),
      },
      async ({ url }) => {
        try {
          const data = await apiCall(this.env, "/v1/compliance", { url });
          const d = data.data;

          const summary = [
            `## EAA Compliance: ${d.url}`,
            "",
            `**Compliant:** ${d.eaa_compliant ? "✅ Yes" : "❌ No"}`,
            `**EAA Score:** ${d.eaa_score}/100`,
            `**WCAG Score:** ${d.wcag_score}/100`,
            "",
            `**Summary:** ${d.summary}`,
            "",
          ];

          const criteria = d.failing_criteria || {};
          for (const [principle, failures] of Object.entries(criteria)) {
            const items = failures as any[];
            if (items.length > 0) {
              summary.push(`### ${principle.charAt(0).toUpperCase() + principle.slice(1)} (${items.length} issues)`);
              for (const f of items) {
                summary.push(`- **${f.rule}** (${f.wcag}) [${f.severity}] — ${f.title}`);
              }
              summary.push("");
            }
          }

          summary.push(`*Scanned at: ${d.scanned_at}*`);

          return txt(summary.join("\n"));
        } catch (err: any) {
          return txt(`Error checking compliance for ${url}: ${err.message}`);
        }
      }
    );

    // ── Tool 3: get_fix_suggestion ─────────────────

    this.server.tool(
      "get_fix_suggestion",
      "Get a code fix suggestion for a specific WCAG accessibility issue. Returns before/after code examples and explanation.",
      {
        rule: z
          .string()
          .describe(
            "The WCAG rule name (e.g. 'missing_alt_text', 'color_contrast', 'empty_links', 'missing_form_labels')"
          ),
        context: z
          .string()
          .optional()
          .describe("Optional context about the specific element or page to tailor the suggestion"),
      },
      async ({ rule, context }) => {
        const key = rule.toLowerCase().replace(/[-\s]/g, "_");
        const fix = FIX_SUGGESTIONS[key];

        if (!fix) {
          const available = Object.keys(FIX_SUGGESTIONS).join(", ");
          return txt(
            `No fix suggestion found for rule "${rule}".\n\nAvailable rules:\n${available}`
          );
        }

        const lines = [
          `## Fix: ${fix.title}`,
          "",
          `**WCAG Criterion:** ${fix.wcag}`,
          "",
          "### Code Example",
          "```html",
          fix.snippet,
          "```",
          "",
          `### Explanation`,
          fix.explanation,
        ];

        if (context) {
          lines.push("", `### Context`, `Applied to your case: ${context}`);
        }

        return txt(lines.join("\n"));
      }
    );

    // ── Tool 4: get_fix_recipe ──────────────────────

    this.server.tool(
      "get_fix_recipe",
      "Get a structured, machine-readable fix recipe for accessibility issues. Provide either a URL to scan, or bring your own axe-core violations JSON (BYOV). Auto-detects the site's framework (React, Vue, Next.js, Angular, Svelte, etc.) and returns framework-specific before/after code. You can also specify a framework explicitly. Returns prioritized steps with validation selectors, effort estimates, and cross-pillar impact. Designed for automated remediation.",
      {
        url: z
          .string()
          .url()
          .optional()
          .describe("URL to scan and generate a fix recipe for. Required if violations is not provided."),
        violations: z
          .array(
            z.object({
              id: z.string().describe("axe-core rule ID (e.g. 'image-alt')"),
              impact: z.enum(["critical", "serious", "moderate", "minor"]),
              nodes: z.array(z.any()).describe("Array of affected DOM elements"),
              description: z.string().optional(),
              help: z.string().optional(),
              helpUrl: z.string().optional(),
              tags: z.array(z.string()).optional(),
            })
          )
          .optional()
          .describe(
            "Bring your own axe-core violations JSON instead of scanning. Pass the violations array directly from axe.run() results."
          ),
        issues: z
          .array(z.string())
          .optional()
          .describe("Optional: filter to specific rule IDs (e.g. ['image-alt', 'color-contrast'])"),
        framework: z
          .string()
          .optional()
          .describe("Optional: target framework hint (e.g. 'react', 'vue', 'angular')"),
      },
      async ({ url, violations, issues, framework }) => {
        if (!url && (!violations || violations.length === 0)) {
          return txt("Error: Provide either a url to scan or a violations array (BYOV).");
        }
        try {
          const body: any = { issues, framework };
          if (violations && violations.length > 0) {
            body.violations = violations;
            if (url) body.url = url; // optional: for context in the response
          } else {
            body.url = url;
          }
          const data = await apiCall(this.env, "/v1/recipe", body);
          const d = data.data;
          const recipe = d.recipe;

          const summary = [
            `## Fix Recipe: ${d.url}`,
            "",
            `**Current Score:** ${d.current_score}/100`,
            `**Estimated After Fix:** ${recipe.estimated_score_after}/100 (${recipe.estimated_grade_after})`,
            `**Total Issues:** ${recipe.total_issues} | **Total Credits:** ${recipe.total_credits}`,
            "",
          ];

          if (recipe.steps.length > 0) {
            summary.push("### Steps (priority order)");
            summary.push("");
            for (const step of recipe.steps) {
              const icon = step.severity === "critical" ? "🔴" : step.severity === "serious" ? "🟠" : "🟡";
              summary.push(`#### ${step.order}. ${icon} ${step.rule_id} (${step.severity})`);
              if (step.title) summary.push(`**${step.title}**`);
              summary.push(`Effort: ${step.fix.effort} | Confidence: ${step.fix.confidence} | Points: +${step.fix.points_gain}`);
              summary.push("");
              summary.push("```");
              summary.push(`// Before:`);
              summary.push(step.fix.before);
              summary.push("");
              summary.push(`// After:`);
              summary.push(step.fix.after);
              summary.push("```");
              if (step.fix.explanation) {
                summary.push("");
                summary.push(step.fix.explanation);
              }
              if (step.fix.validation) {
                summary.push("");
                summary.push(`Validation: \`${step.fix.validation.selector}\` should match ${step.fix.validation.expectedCount ?? "as expected"}`);
              }
              summary.push("");
            }
          } else {
            summary.push("No fixable issues found — site looks good!");
          }

          // Also return raw JSON for machine consumption
          summary.push("");
          summary.push("---");
          summary.push("### Raw Recipe JSON");
          summary.push("```json");
          summary.push(JSON.stringify(d, null, 2));
          summary.push("```");

          return txt(summary.join("\n"));
        } catch (err: any) {
          return txt(`Error generating recipe for ${url}: ${err.message}`);
        }
      }
    );
  }
}

// ── Worker entrypoint ──────────────────────────────────

const mcpApp = SiteProofMCP.serve("/mcp", {
  binding: "SiteProofMCP",
  corsOptions: {
    origin: "*",
    methods: "GET, POST, OPTIONS, DELETE",
    headers: "Content-Type, Authorization, mcp-session-id",
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Health / info
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        status: "ok",
        server: "siteproof-mcp",
        version: "1.0.0",
        description: "WCAG accessibility, AI Engine Optimization, and AI agent security scanning for AI agents",
        mcp_endpoint: "/mcp",
        tools: ["scan_accessibility", "scan_aeo", "scan_agentproof", "get_compliance_status", "get_fix_suggestion", "get_fix_recipe"],
      });
    }

    // MCP protocol
    return mcpApp.fetch(request, env, ctx);
  },
};
