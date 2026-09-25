# AuthiChain MCP Server

An MCP (Model Context Protocol) server that lets AI agents check whether a product is registered as authentic with AuthiChain, and lets brands register products and issue certificates on Polygon.

It wraps the AuthiChain REST API. Verification logic and scoring run in the hosted API, not in this repo.

## Tools

| Tool | What it does |
|------|--------------|
| `authichain_verify_product` | Verify a product ID. Returns a trust score (0-100), a verdict, and whether a blockchain certificate exists. |
| `authichain_register_product` | Register a product in the AuthiChain registry. |
| `authichain_mint_certificate` | Issue a certificate for a registered product on Polygon. |
| `authichain_search_products` | Search the registry of authenticated products. |
| `authichain_check_eu_dpp` | Check a product against EU Digital Product Passport requirements. |
| `authichain_truth_network` | Query the scoring service directly for an authenticity assessment. |
| `authichain_verify_cannabis` | Verify a cannabis product (StrainChain). |
| `authichain_get_pricing` | Return current API pricing. |

## Quick start

Requires Node 18 or newer (the server uses the built-in `fetch`). <!-- TODO: confirm the minimum supported Node version and add an "engines" field to package.json. -->

```bash
git clone https://github.com/undone0603/authichain-mcp-server
cd authichain-mcp-server
npm install
npm run build
```

### Get an API key

The hosted API issues free keys. Send a POST to `/api/v1/keys/create` on the API base URL (the `AUTHICHAIN_API_URL` value in [Configuration](#configuration)) with your email:

```bash
export AUTHICHAIN_API_URL=<value from the Configuration table>
curl -X POST "$AUTHICHAIN_API_URL/api/v1/keys/create" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

<!-- TODO: the endpoint and request body are confirmed from the live API's own help text; the response shape (which field holds the key) has not been verified. Document it once confirmed. -->

The server sends the key to the API in the `X-API-Key` header.

### Claude Desktop

Add this to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "authichain": {
      "command": "node",
      "args": ["/absolute/path/to/authichain-mcp-server/dist/index.js"],
      "env": { "AUTHICHAIN_API_KEY": "your_key" }
    }
  }
}
```

Restart Claude and ask it to verify an AuthiChain product ID.

<!-- TODO: add a known demo product ID here once one has been confirmed against the live API with a valid key. -->

### HTTP mode (Node/Express server)

The server can also run as a long-lived Node/Express process that serves MCP over Streamable HTTP. Build first, then start it with `TRANSPORT_MODE=http`:

```bash
npm install
npm run build
AUTHICHAIN_API_KEY=your_key TRANSPORT_MODE=http PORT=3847 npm start
# MCP endpoint: http://localhost:3847/mcp  (POST)
# Health check: http://localhost:3847/health
```

For development without a build step, `npm run dev` runs `src/index.ts` directly with `tsx` (the same environment variables apply).

To host it, run the same commands on any machine or platform that can run a Node process (a VM, a container, or a Node hosting service) and set the environment variables below. This repo has no Cloudflare Workers / `wrangler` configuration, and the server is not currently deployed as a Worker.

<!-- TODO: no hosted MCP endpoint exists yet. Add its URL here once one is deployed. -->

## Example response

<!-- TODO: paste a real response from authichain_verify_product for a confirmed demo product ID. Not yet captured because it requires a valid API key. -->

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `AUTHICHAIN_API_KEY` | none | Your API key |
| `AUTHICHAIN_API_URL` | `https://authichain-api.undone-k.workers.dev` | API base URL |
| `TRANSPORT_MODE` | `stdio` | `stdio` or `http` |
| `PORT` | `3847` | Port for HTTP mode |

## Limitations

- Only products registered with AuthiChain can be verified. An unregistered item returns an unknown result, not a "fake" verdict.
- Scoring happens in the hosted API, so results depend on that service being available.

## License

<!-- TODO: license not chosen yet (Zachary's decision). Add a LICENSE file and update this section. -->

TODO

More at [authichain.com](https://authichain.com).
