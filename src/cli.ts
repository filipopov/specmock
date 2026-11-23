#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { MockEngine } from "./engine.js";
import { startHttp } from "./http.js";
import { createMcpServer } from "./mcp.js";
import { loadSpec } from "./spec.js";

const VERSION = "0.1.0";

const USAGE = `Usage: specmock <openapi.yaml|json> [options]

Serves a stateful mock of the API over HTTP and exposes it to AI assistants over MCP.

Options:
  --port <n>        HTTP port for the mock (default 4010)
  --host <h>        Bind address (default 127.0.0.1)
  --seed <n>        Seed for generated data (default 42)
  --count <n>       Records per resource (default 5)
  --state <file>    Load records from a JSON file (from the export_state tool)
  --no-stdio        Don't speak MCP on stdio (HTTP only: mock + MCP at /mcp)
  --token <t>       Require this token on /mcp (Bearer header or ?token=); env SPECMOCK_TOKEN
  -h, --help

MCP endpoints: stdio (Claude Code / Desktop start the process) and http://<host>:<port>/mcp
(ChatGPT developer mode, Claude custom connectors; put a tunnel in front for remote clients).`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4010" },
      host: { type: "string", default: "127.0.0.1" },
      seed: { type: "string", default: "42" },
      count: { type: "string", default: "5" },
      state: { type: "string" },
      "no-stdio": { type: "boolean", default: false },
      token: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 2);
  }

  const spec = await loadSpec(positionals[0]);
  const engine = new MockEngine(spec, { seed: Number(values.seed), count: Number(values.count) });
  if (values.state) engine.restore(JSON.parse(await readFile(values.state, "utf8")));

  const port = Number(values.port);
  const baseUrl = `http://${values.host}:${port}`;
  const token = values.token ?? process.env.SPECMOCK_TOKEN;
  await startHttp(engine, { host: values.host!, port, token, mcp: () => createMcpServer(engine, baseUrl, VERSION) });

  // stdout belongs to MCP in stdio mode: everything for humans goes to stderr.
  console.error(`specmock ${VERSION}: ${spec.title} ${spec.version}`);
  console.error(`  mock API  ${baseUrl}   resources: ${JSON.stringify(engine.counts())}`);
  console.error(`  MCP HTTP  ${baseUrl}/mcp${token ? " (token required)" : ""}`);
  if (!values["no-stdio"]) {
    await createMcpServer(engine, baseUrl, VERSION).connect(new StdioServerTransport());
    console.error("  MCP stdio ready");
  }
}

main().catch((e) => {
  console.error(`specmock: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
