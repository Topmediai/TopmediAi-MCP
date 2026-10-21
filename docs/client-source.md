# MCP client identity

`MCP_CLIENT_SOURCE` identifies the host application, independently of the model, operating system, and original backend request-body channel.

| Client | Launch setting | Outbound business HTTP header |
| --- | --- | --- |
| Codex | `MCP_CLIENT_SOURCE=5` | `source: 5` |
| Claude Code | `MCP_CLIENT_SOURCE=6` | `source: 6` |
| Cursor | `MCP_CLIENT_SOURCE=7` | `source: 7` |
| Unknown | Unset or empty | Header omitted |

Other nonempty values are rejected with `INVALID_CONFIG`; they never default to Codex. Identity is not guessed from `clientInfo.name`, model names, OS, tool arguments, or untrusted inbound headers. `get_service_status.mcp_client_source` shows the value, or `null` when unknown.

## Separate stdio processes

The public `src/index.ts` provides a stdio entry point. Each client starts its own process. Put identity in each client's launch settings, not in a shared `.env`. Build first with `npm.cmd run build`, then replace example paths with the actual compiled entry point and local Node path.

Codex `config.toml`:

```toml
[mcp_servers.topmediai]
command = "node"
args = ["C:/path/to/topmediai-mcp-public/dist/src/index.js"]

[mcp_servers.topmediai.env]
MCP_CLIENT_SOURCE = "5"
```

Claude Code project `.mcp.json`:

```json
{
  "mcpServers": {
    "topmediai": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/topmediai-mcp-public/dist/src/index.js"],
      "env": { "MCP_CLIENT_SOURCE": "6" }
    }
  }
}
```

Cursor project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "topmediai": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/topmediai-mcp-public/dist/src/index.js"],
      "env": { "MCP_CLIENT_SOURCE": "7" }
    }
  }
}
```

`install:codex` writes `5`; `setup:cursor` and `install:cursor` write `7`, overriding another inherited client value. Generic `setup:plugin` preserves an explicit value and writes an empty override when unconfigured. To refresh a Codex plugin launch:

```powershell
$env:MCP_CLIENT_SOURCE = '5'
npm.cmd run setup:plugin
```

Reconnect MCP after launch-setting changes and refresh installed plugin caches through their installation workflow. Source changes do not rewrite existing client configuration. Credential refresh does not change a connection's identity.

## Embedded session isolation

There is no public HTTP MCP listener. An embedded host can create one `McpServer` and transport per session, passing identity from trusted routing/deployment configuration as the fourth argument:

```typescript
const codex = createServer(config, reloadCredentials, undefined, { clientSource: 5 });
const claude = createServer(config, reloadCredentials, undefined, { clientSource: 6 });
const cursor = createServer(config, reloadCredentials, undefined, { clientSource: 7 });
const unknown = createServer(config, reloadCredentials, undefined, { clientSource: undefined });
```

Explicit unknown masks any process-level client value. Identity is copied and fixed at creation for login verification, tools, asynchronous requests, and credential refresh. Later mutation of caller configuration/session objects does not change it. Do not mutate shared `process.env` or multiplex different clients through one `McpServer`. The embedding host remains responsible for HTTP authentication and routing; arbitrary inbound headers are not trusted identity.

## Request boundary and compatibility

`src/transport/http.ts` is the common business HTTP layer for account verification, image/balance requests, and multimedia transport. It removes existing `source` headers case-insensitively, then sets one identity value only for configured member, image, music, TTS, upload, and legacy-gateway origins. It adds no identity to CDN, browser, or unrelated origins. Business redirects remain prohibited.

`TOPMEDIAI_SOURCE` retains its original request-body meaning: channels 1-4, default 4. Image/video JSON/form `source` fields and upload form storage-path `source` fields retain their existing meanings. New client numbers affect only the HTTP header; token/Bearer authentication, bodies, content types, timeouts, and retry policies retain their original behavior.

Tests use local HTTP endpoints and in-memory MCP transports to check exact headers, duplicate removal, unknown clients, request-body compatibility, concurrent sessions, credential refresh, and disconnect isolation. They do not call live paid APIs.
