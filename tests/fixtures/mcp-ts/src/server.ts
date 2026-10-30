// An MCP server for a notes app, on the official TypeScript SDK.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes, addNote } from "./notes.js";

const server = new McpServer({ name: "notes", version: "1.0.0" });

server.tool("list_notes", "Lists every note, newest first.", {}, async () => ({ content: [{ type: "text", text: JSON.stringify(listNotes()) }] }));

server.registerTool("add_note", {
  title: "Add a note",
  description: "Saves a new note with the given text.",
  inputSchema: { text: z.string() },
}, async ({ text }) => ({ content: [{ type: "text", text: addNote(text) }] }));

// Not a tool: a toolbar for some other UI
const toolbar = { tool: (name: string) => name };
toolbar.tool("bold");
