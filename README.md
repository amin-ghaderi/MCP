# Mini Finance MCP — Cursor demo

A local MCP server exposing **two tools** to Cursor, backed by a real **SQLite** file:

- `list_invoices` — read invoices (optional filters: customer, status)
- `create_invoice_draft` — store a new **draft** invoice (never sends or finalizes)

Built for a live technical interview: show how an AI Agent calls MCP tools that perform actual database operations.

## Requirements

- Node.js **22.13+** (Node 24 LTS recommended). Check with `node -v`.
- Cursor IDE.

## Quick setup

1. Open this folder in Cursor (`File → Open Folder`).
2. In the terminal:

   ```bash
   npm install
   npm run test:mcp
   ```

3. Ensure Cursor detects `mini-finance` under **Settings → MCP** (or **Customize → MCP**). Enable it if needed, then start a **new Agent chat**.

## Live demo prompt (new Agent chat)

> Use only the **mini-finance** MCP tools (do not use the terminal or edit files).  
> 1) Call `list_invoices`.  
> 2) Call `create_invoice_draft` for customer `C101`, amount `2500`, currency `SEK`, description `MCP_INTERVIEW_DEMO`.  
> 3) Call `list_invoices` again (optionally with status `draft`).  
> Tell me which tools you invoked and the invoice ID.

## Independent SQLite check

```bash
npm run inspect-db
```

You should see a draft row for `MCP_INTERVIEW_DEMO` with amount `2500` SEK.

## Architecture

```
Cursor Agent → MCP Client (Cursor) → mini-finance MCP Server (Node stdio) → finance-demo.sqlite
```

- stdout is reserved for MCP protocol messages; diagnostics go to stderr.
- The database file persists across server restarts.
- Re-running the demo create for the same customer/amount/currency/description returns the existing draft (no duplicates).

## Troubleshooting

- Tools not visible: open this folder as the workspace root, confirm `.cursor/mcp.json` exists, enable `mini-finance` in MCP settings, then **Reload Window** or restart Cursor and open a new Agent chat.
- Do not leave `npm start` running yourself — Cursor launches the stdio server.
- Reset seed data: stop the MCP server, delete `finance-demo.sqlite`, then reconnect.

This is an educational local demo, **not** a connection to Spiris and **not** a production accounting system.
