# AI Notetaker MCP

Lets an AI assistant (Claude, Cursor, any MCP client) **search and read your notes**:
summaries, action items and transcripts. It is read-only, and it only sees your own
workspace.

## 1. Create a read-only token

In AI Notetaker open **Settings → Integrations → Extension & API tokens**, choose
**Read-only, for AI assistants (MCP)** and copy the token. It cannot sign in to
anything else and you can revoke it there at any time.

## 2a. Use it remotely (no install)

The server speaks MCP over HTTPS at `https://YOUR-INSTANCE/api/mcp`.

```sh
claude mcp add --transport http ai-notetaker https://YOUR-INSTANCE/api/mcp \
  --header "Authorization: Bearer ant_YOUR_TOKEN"
```

## 2b. Use it locally over stdio

Claude Desktop (`claude_desktop_config.json`) or Cursor:

```json
{
  "mcpServers": {
    "ai-notetaker": {
      "command": "npx",
      "args": ["-y", "ai-notetaker-mcp"],
      "env": { "NOTETAKER_URL": "https://YOUR-INSTANCE", "NOTETAKER_TOKEN": "ant_YOUR_TOKEN" }
    }
  }
}
```

From a checkout: `"command": "node", "args": ["/path/to/repo/mcp/bin/ai-notetaker-mcp.mjs"]`.
Set `NOTETAKER_WORKSPACE_ID` to pick a workspace if you belong to several.

## Tools

| Tool | What it does |
|---|---|
| `search_notes` | Find notes by words; optional folder (id or `Clients / Acme`) |
| `list_recent_notes` | Newest notes |
| `get_note` | One note's summary, action items, folder and link; optional transcript |
| `list_folders` | Folder paths and ids |
| `list_action_items` | Open or done action items with their source note |

## Safety

- Read-only tools only; nothing can be changed or deleted through MCP.
- Notes in the Trash are never returned.
- Note text reaches your assistant as data. Don't connect an assistant you wouldn't trust
  with those notes, and revoke the token if a device is lost.
- Requests are limited to 120 per minute per token.
