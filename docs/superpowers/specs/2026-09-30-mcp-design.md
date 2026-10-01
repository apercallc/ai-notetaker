# MCP server for your notes (2026-09-30)

Status: implemented. User guide: [`mcp/README.md`](../../../mcp/README.md).

- **What:** a read-only Model Context Protocol server so AI assistants can search and read a
  person's own notes. Tools: `search_notes`, `list_recent_notes`, `get_note`, `list_folders`,
  `list_action_items`, all annotated read-only. Works for hosted and self-hosted instances.
- **Transport:** stateless Streamable HTTP at `POST /api/mcp` (JSON-RPC 2.0, one request, one
  JSON answer, 202 for notifications; GET is 405 because the server never pushes). Protocol
  versions 2025-06-18, 2025-03-26 and 2024-11-05 are negotiated. A stdio bridge
  (`mcp/bin/ai-notetaker-mcp.mjs`, no dependencies) serves clients that only speak stdio.
- **Auth:** a new token scope `notes_read` (`ant_…`). Resolvers accept exactly one scope each,
  so a read token cannot sign in to the managed API and a managed token cannot call MCP.
  Created in Settings (a "Use" choice), revocable there, sliding 90-day expiry like other
  tokens. The route authenticates itself; `proxy.ts` lets `/api/mcp` through for that reason.
- **Safety:** workspace-scoped (default workspace, or `X-Workspace-Id` checked against
  membership); trashed notes never returned; Origin header must be same-origin when present;
  64 KB request cap; 120 requests per minute per token; note text is returned as data and the
  server instructions and `get_note` output say not to follow instructions found in notes;
  notes are truncated at 40k characters and transcripts at 60k.

## Not built
- OAuth for MCP clients, write tools, MCP resources/prompts, SSE streaming, an Ask-your-notes
  tool (it spends the paid chat quota), per-folder token scopes, and an `ai-notetaker-mcp`
  npm release.
