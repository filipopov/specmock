# specmock

**Turn any OpenAPI spec into a stateful mock API that your app and your AI assistant share.**

Your app calls the mock over HTTP. Claude or ChatGPT drives the same in-memory state over MCP: seed data, set up an
edge case, inject a fault, then read exactly what the app sent.

```text
You:     Freeze Filip's account with balance 0 and make the next POST /payments return 503.
Claude:  e15c2617-… is now FROZEN with balance 0, and the next POST /payments call will return
         503 {"error":"core banking unavailable"} (fault f1).

$ curl localhost:4010/accounts?owner=Filip%20Test
{"items":[{"id":"e15c2617-…","owner":"Filip Test","balance":0,"status":"FROZEN",…}],"total":1}
$ curl -X POST localhost:4010/payments -d '{"fromAccountId":"a","toAccountId":"b","amount":5,"currency":"CHF"}'
{"error":"core banking unavailable"}                                         [503]
$ curl -X POST localhost:4010/payments -d '{… "amount":-5 …}'
{"error":"Request body does not match the schema","details":[{"path":"/amount","message":"must be > 0"}]}   [400]
```

That exchange is a real run against [`examples/ledger.yaml`](examples/ledger.yaml).

## Why

Static mocks return the same canned response forever. Testing "what does the app do when the account is frozen and
the payment service is flaky?" usually means editing JSON fixtures, or writing a WireMock mapping per case.
specmock reads the spec, infers the resources and keeps real state, so a scenario is one sentence to your assistant.

## Run

```bash
npx specmock path/to/openapi.yaml            # mock on http://127.0.0.1:4010, MCP on stdio and at /mcp
```

From source: `npm install && npm run build && node dist/cli.js examples/ledger.yaml`.

| Option | |
|---|---|
| `--port`, `--host` | HTTP bind (default `127.0.0.1:4010`) |
| `--seed`, `--count` | Deterministic seed data: same seed, same records (default 42, 5 per resource) |
| `--state <file>` | Start from records saved with the `export_state` tool |
| `--token <t>` / `SPECMOCK_TOKEN` | Require a token on `/mcp` (`Authorization: Bearer` or `?token=`) |
| `--no-stdio` | HTTP only |

## Connect an assistant

**Claude Code plugin**: bundles the MCP server and a `/specmock:scenario` command.

```text
/plugin marketplace add filipopov/specmock
/plugin install specmock@specmock
```

Point it at your spec with `SPECMOCK_SPEC=/path/to/openapi.yaml` (and optionally `SPECMOCK_PORT`). Without it, the
plugin serves the bundled Ledger example.

**Claude Code / Claude Desktop without the plugin**: `claude mcp add specmock -- npx -y specmock /path/to/openapi.yaml`

**ChatGPT** (developer mode), **Claude.ai custom connectors** and other remote clients: run
`specmock spec.yaml --no-stdio --token <t>`, expose it with `cloudflared tunnel --url http://localhost:4010` or
`ngrok http 4010`, and add `https://<tunnel>/mcp?token=<t>` as the connector URL.

## Tools

| Tool | |
|---|---|
| `describe_api` | Operations, inferred resources with fields and record counts, base URL |
| `list_records` | Current records of a resource, with exact-match filters |
| `upsert_records` | Create or update records. Missing fields are generated, and the result is validated against the schema |
| `delete_records`, `reset` | Remove records; regenerate the seed data |
| `call_api` | Call the mock as a client would, through validation, faults and state |
| `add_fault`, `list_faults`, `clear_faults` | Status codes, bodies, latency, "next N calls", probability. Match by spec path (`/accounts/{accountId}`), concrete path or glob |
| `request_log` | What clients sent, with status, validation errors and the fault that hit |
| `export_state` | All records as JSON, so you can replay with `--state` |

## How it works

- **Resources** are inferred from paths: `/accounts` + `/accounts/{accountId}` is a collection, and
  `/accounts/{accountId}/transactions` is nested under it. The id field is the path parameter's name or `id`.
- **CRUD semantics**: `GET` list (filters by query params that are fields, `limit`/`offset`, fills wrapper
  `total`), `POST` create (201 + `Location`), `GET`/`PATCH`/`PUT`/`DELETE` on items, 404 for unknown ids or
  parents, 405 for unknown methods. Other operations return generated responses that match their schema.
- **Validation**: request bodies are checked against the spec with Ajv (JSON Schema 2020-12; OpenAPI 3.0
  `nullable` is supported). Failures return 400 with the schema errors.
- **Seed data** follows the schema (enums, formats, min/max, examples) and property names (`email`, `iban`,
  `currency`, `owner`…). `*Id` fields such as `fromAccountId` point at existing records of the matching resource.

## Limits

- State lives in memory and is lost on restart unless you export it.
- Business rules (e.g. "insufficient funds → 422") aren't inferred from a spec. Set them up as data plus faults,
  which is what the assistant is for.
- Auth schemes in the spec aren't enforced, and responses aren't validated against the spec.

## Development

`npm test` runs the vitest suite: spec inference, CRUD, validation, faults, determinism, and MCP over an in-memory
transport.

MIT licensed.
