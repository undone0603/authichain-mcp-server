import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════
// AUTHICHAIN MCP SERVER — Product Authentication API for AI Agents
// Monetization: Every tool call = billable API event via Stripe
// ═══════════════════════════════════════════════════════════════

const API_BASE = process.env.AUTHICHAIN_API_URL || "https://authichain-api.undone-k.workers.dev";
const API_KEY = process.env.AUTHICHAIN_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://nhdnkzhtadfkkluiulhs.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "";

// ─── API Client ───────────────────────────────────────────────

async function apiRequest<T>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" = "GET",
  body?: Record<string, unknown>,
  params?: Record<string, string>
): Promise<T> {
  // Endpoints are paths under the deployed authichain-api Worker, e.g.
  // "/api/v1/verify". The old root paths (/verify, /products/register, ...)
  // do not exist and always returned 404.
  const url = new URL(`${API_BASE.replace(/\/+$/, "")}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
    "User-Agent": "authichain-mcp-server/1.0.0",
  };

  const res = await fetch(url.toString(), {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Unknown error");
    throw new Error(`AuthiChain API error (${res.status}): ${errorText}`);
  }

  return res.json() as Promise<T>;
}

async function supabaseQuery<T>(
  table: string,
  query: string = "",
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>
): Promise<T> {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ""}`;

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Prefer": method === "POST" ? "return=representation" : "count=exact",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Unknown error");
    throw new Error(`Supabase error (${res.status}): ${errorText}`);
  }

  return res.json() as Promise<T>;
}

// Tools whose backing endpoint does not exist on authichain-api yet return
// this instead of calling a path that would 404.
function notYetAvailable(tool: string, detail: string) {
  const text =
    `${tool} is not yet available: the AuthiChain API (${API_BASE}) has no endpoint for it. ${detail}`.trim();
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

// ─── Server Initialization ────────────────────────────────────

const server = new McpServer({
  name: "authichain-mcp-server",
  version: "1.0.0",
});

// ═══════════════════════════════════════════════════════════════
// TOOL 1: Verify Product Authenticity
// Revenue: $0.01–0.05 per verification call
// ═══════════════════════════════════════════════════════════════

server.registerTool(
  "authichain_verify_product",
  {
    title: "Verify Product Authenticity",
    description: `Verify a product against the AuthiChain registry (POST /api/v1/verify).

Looks the identifier up by TrueMark ID, serial number, SKU, or product UUID. Returns whether it is verified, a status (verified / unverified / ambiguous / not_found), a trust score (0-100) computed from the evidence on record, the evidence checks, and — when the API has a signing key configured — an Ed25519-signed certificate (JWS) verifiable against the API's JWKS.

Args:
  - product_id (string): TrueMark ID, serial number, SKU, or product UUID
  - include_history (boolean): Not supported by the API yet; ignored

Use when: A user asks "Is this product authentic?", "Verify this item", or needs to check product provenance.`,
    inputSchema: {
      product_id: z.string().min(1).describe("Product ID, certificate hash, or QR code payload"),
      include_history: z.boolean().default(false).describe("Include full scan/verification history"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ product_id, include_history }) => {
    try {
      const result = await apiRequest<any>("/api/v1/verify", "POST", {
        serial: product_id,
      });

      const output = {
        product_id,
        verified: result.verified === true,
        status: result.status ?? "unknown",
        trust_score: result.trust_score ?? 0,
        message: result.message ?? null,
        product: result.product ?? null,
        blockchain: result.blockchain ?? null,
        evidence: result.evidence ?? [],
        certificate: result.certificate ?? null,
        ...(result.candidates ? { candidates: result.candidates } : {}),
        ...(include_history
          ? { history_note: "Verification history is not available from the API yet." }
          : {}),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Verification failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// TOOL 2: Register Product
// Revenue: $0.10–1.00 per registration
// ═══════════════════════════════════════════════════════════════

server.registerTool(
  "authichain_register_product",
  {
    title: "Register Product for Authentication",
    description: `Register a new product in the AuthiChain registry (POST /api/v1/register). Returns the product ID, its TrueMark ID, and QR payload URLs. The product is stored as pending blockchain anchoring; no NFT is minted and no on-chain transaction is made by this call.

Args:
  - name (string): Product name
  - brand (string): Brand or manufacturer name
  - category (string): Product category (e.g., 'cannabis', 'luxury', 'electronics', 'pharma', 'textile', 'food')
  - description (string): Product description
  - metadata (object, optional): Additional product metadata (batch, serial, origin, etc.)
  - mint_nft (boolean): Not supported by the API yet; ignored
  - generate_qr (boolean): Not supported by the API yet; ignored (QR payload URLs are always returned)

Returns: Product ID, TrueMark ID, anchoring status, and QR payload URLs.

Use when: A brand wants to register a product for authentication, or a user asks to "add a product to AuthiChain".`,
    inputSchema: {
      name: z.string().min(1).max(200).describe("Product name"),
      brand: z.string().min(1).max(100).describe("Brand or manufacturer name"),
      category: z.enum(["cannabis", "luxury", "electronics", "pharma", "textile", "food", "automotive", "other"])
        .describe("Product category"),
      description: z.string().max(1000).default("").describe("Product description"),
      metadata: z.record(z.string(), z.any()).optional().describe("Additional metadata (batch, serial, origin)"),
      mint_nft: z.boolean().default(false).describe("Not supported yet; ignored"),
      generate_qr: z.boolean().default(false).describe("Not supported yet; ignored"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ name, brand, category, description, metadata }) => {
    try {
      const result = await apiRequest<any>("/api/v1/register", "POST", {
        name,
        brand,
        category,
        description,
        ...(metadata ? { metadata } : {}),
      });

      const product = result.product ?? {};
      const output = {
        product_id: product.id ?? null,
        truemark_id: product.truemark_id ?? null,
        anchoring_status: product.blockchain_tx_hash ?? null,
        scan_url: result.qrPayload?.scan_url ?? null,
        verify_url: result.qrPayload?.verify_url ?? null,
        status: result.success ? "registered" : "failed",
        registered_at: product.registered_at ?? null,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Registration failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// TOOL 3: Search Products
// Revenue: $0.01 per search
// ═══════════════════════════════════════════════════════════════

server.registerTool(
  "authichain_search_products",
  {
    title: "Search Authenticated Products",
    description: `List registered products from the AuthiChain registry (GET /api/v1/products), optionally by category. The API has no text search yet, so the query and brand filters are applied by this server to the returned page only.

Args:
  - query (string): Search query (matches name, brand, description)
  - category (string, optional): Filter by category
  - brand (string, optional): Filter by brand name
  - limit (number): Max results (1-50, default: 20)
  - offset (number): Pagination offset (default: 0)

Returns: Registered products on the requested page that match the query/brand filters.`,
    inputSchema: {
      query: z.string().min(1).max(200).describe("Search query"),
      category: z.string().optional().describe("Category filter"),
      brand: z.string().optional().describe("Brand filter"),
      limit: z.number().int().min(1).max(50).default(20).describe("Max results"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, category, brand, limit, offset }) => {
    try {
      const params: Record<string, string> = {
        limit: String(limit),
        offset: String(offset),
      };
      if (category) params.category = category;

      const result = await apiRequest<any>("/api/v1/products", "GET", undefined, params);

      const q = query.toLowerCase();
      const b = brand?.toLowerCase();
      const page: any[] = Array.isArray(result.products) ? result.products : [];
      const matches = page.filter((p: any) => {
        const hay = `${p.name ?? ""} ${p.brand ?? ""} ${p.truemark_id ?? ""}`.toLowerCase();
        return hay.includes(q) && (!b || String(p.brand ?? "").toLowerCase() === b);
      });

      const output = {
        count: matches.length,
        page_size: page.length,
        offset,
        products: matches.map((p: any) => ({
          product_id: p.id,
          name: p.name,
          brand: p.brand,
          category: p.category,
          truemark_id: p.truemark_id ?? null,
          blockchain_tx_hash: p.blockchain_tx_hash ?? null,
          registered_at: p.created_at ?? null,
        })),
        has_more: result.has_more === true,
        note: "Text/brand filtering is done client-side on this page; the API has no search endpoint yet.",
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Search failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// TOOL 4: EU DPP Compliance Check
// Revenue: $0.50–5.00 per compliance check
// ═══════════════════════════════════════════════════════════════

server.registerTool(
  "authichain_check_eu_dpp",
  {
    title: "Check EU Digital Product Passport Compliance",
    description: `NOT YET AVAILABLE — the AuthiChain API has no endpoint for this tool; calling it returns an error without contacting the API.

Check whether a product meets EU Digital Product Passport (DPP) requirements under ESPR Regulation (EU) 2024/1781.

The EU DPP is mandatory from February 2027 for batteries, with textiles, electronics, furniture following through 2030. Products without a DPP cannot be sold in the EU market.

AuthiChain evaluates compliance across:
- Material composition & origin data
- Environmental impact / carbon footprint
- Repairability & end-of-life handling
- Supply chain traceability
- QR code data carrier (ESPR Article 10)
- GS1 Digital Link compatibility
- JSON-LD Schema.org structured data

Args:
  - product_id (string): AuthiChain product ID to check
  - category (string): EU DPP product category for sector-specific rules
  - generate_passport (boolean): Generate a compliant DPP document (default: false)

Returns: Compliance score (0-100), missing fields, remediation steps, and optionally a generated DPP document.

Use when: A manufacturer asks about EU compliance, DPP readiness, or needs to generate a Digital Product Passport.`,
    inputSchema: {
      product_id: z.string().min(1).describe("AuthiChain product ID"),
      category: z.enum(["battery", "textile", "electronics", "furniture", "tyre", "steel", "aluminum", "detergent", "other"])
        .describe("EU DPP product category"),
      generate_passport: z.boolean().default(false).describe("Generate compliant DPP document"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ product_id, category, generate_passport }) => {
    return notYetAvailable(
      "EU DPP compliance check",
      `No DPP endpoint exists yet (requested: product ${product_id}, category ${category}${generate_passport ? ", passport generation" : ""}).`
    );
  }
);

// ═══════════════════════════════════════════════════════════════
// TOOL 5: Truth Network Query
// Revenue: $0.05 per query
// ═══════════════════════════════════════════════════════════════

server.registerTool(
  "authichain_truth_network",
  {
    title: "Query the AuthiChain Truth Network",
    description: `NOT YET AVAILABLE — the AuthiChain API has no endpoint for this tool; calling it returns an error without contacting the API.

Query the AuthiChain Truth Network — a 5-agent AI consensus system that evaluates product authenticity using independent analysis from specialized AI agents.

Agents and their roles:
- Guardian (35% consensus weight): Primary authentication engine. Analyzes physical markers, metadata consistency, and provenance claims.
- Archivist (20%): Historical verification. Cross-references product history, ownership chain, and manufacturing records.
- Sentinel (25%): Fraud detection. Pattern matching against known counterfeit signatures, anomaly detection.
- Scout (8%): Market intelligence. Compares against market pricing, availability, and distribution patterns.
- Arbiter (12%): Final consensus. Weighs all agent assessments and produces the final trust score.

Args:
  - query (string): Natural language query about a product or authentication scenario
  - context (object, optional): Additional context (product details, images, certificates)

Returns: Consensus analysis with individual agent assessments and recommendations.

Use when: A user needs expert analysis on product authenticity, supply chain integrity, or counterfeit risk assessment.`,
    inputSchema: {
      query: z.string().min(1).max(2000).describe("Natural language authentication query"),
      context: z.record(z.string(), z.any()).optional().describe("Additional context (product details, images, certs)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ query, context }) => {
    void context;
    return notYetAvailable(
      "Truth Network query",
      `No Truth Network endpoint exists yet (query: ${JSON.stringify(query.slice(0, 200))}). For registry lookups use authichain_verify_product.`
    );
  }
);

// ═══════════════════════════════════════════════════════════════
// TOOL 6: Get API Pricing & Usage
// Revenue: Discovery tool (drives paid usage)
// ═══════════════════════════════════════════════════════════════

server.registerTool(
  "authichain_get_pricing",
  {
    title: "Get AuthiChain API Pricing",
    description: `Get current AuthiChain API pricing tiers and usage information.

Returns pricing for all tiers: Starter ($99/mo), Growth ($499/mo), Enterprise ($2,499/mo), and pay-as-you-go rates.

Use when: A user asks about pricing, costs, or wants to compare plans.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const output = {
      currency: "USD",
      pay_as_you_go: {
        verification: "$0.05/call",
        registration: "$1.00/product",
        dpp_check: "$2.00/check",
        dpp_generation: "$10.00/passport",
        truth_network: "$0.10/query",
        search: "$0.01/call",
      },
      tiers: [
        {
          name: "Starter",
          price: "$99/month",
          includes: "1,000 verifications, 100 registrations, 50 DPP checks, API key, email support",
          best_for: "Small brands, startups, testing",
        },
        {
          name: "Growth",
          price: "$499/month",
          includes: "10,000 verifications, 1,000 registrations, 500 DPP checks, priority support, analytics dashboard",
          best_for: "Growing brands, mid-market manufacturers",
        },
        {
          name: "Enterprise",
          price: "$2,499/month",
          includes: "Unlimited verifications, 10,000 registrations, unlimited DPP, dedicated support, custom AI models, SLA",
          best_for: "Large manufacturers, EU DPP compliance at scale",
        },
        {
          name: "Custom",
          price: "Contact sales",
          includes: "Volume pricing, on-premise deployment, custom verticals, white-label options",
          best_for: "Fortune 500, government agencies, industry consortiums",
        },
      ],
      eu_dpp_packages: {
        smb: { price: "$2,000 setup + $99/mo", includes: "Up to 100 products, QR generation, basic DPP" },
        midmarket: { price: "$10,000 setup + $499/mo", includes: "Up to 5,000 products, full DPP, GS1 integration" },
        enterprise: { price: "$50,000 setup + $2,499/mo", includes: "Unlimited products, custom DPP, supply chain integration" },
      },
      polygon_gas: "< $0.001 per transaction (paid by AuthiChain, included in pricing)",
      stripe_billing: "Automated via Stripe (acct_1SXIyEGqTruSqV8T)",
    };

    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  }
);

// ═══════════════════════════════════════════════════════════════
// TOOL 7: Mint Authentication Certificate
// Revenue: $0.10–1.00 per mint
// ═══════════════════════════════════════════════════════════════

server.registerTool(
  "authichain_mint_certificate",
  {
    title: "Mint Authentication Certificate NFT",
    description: `NOT YET AVAILABLE — the AuthiChain API has no endpoint for this tool; calling it returns an error without contacting the API.

Mint a blockchain authentication certificate as an NFT on Polygon for a registered product.

The certificate is minted on Polygon (contract: 0x4da4D2675e52374639C9c954f4f653887A9972BE) and includes:
- Product identity hash
- Manufacturer attestation
- Trust Network consensus score
- Timestamp and chain of custody
- QR code link for consumer scanning

Args:
  - product_id (string): AuthiChain product ID (must be registered first)
  - metadata_uri (string, optional): IPFS URI for extended metadata

Returns: Transaction hash, token ID, certificate URL, and QR code for consumer verification.

Use when: A brand wants to create a blockchain-backed proof of authenticity for a product.`,
    inputSchema: {
      product_id: z.string().min(1).describe("AuthiChain product ID"),
      metadata_uri: z.string().optional().describe("IPFS URI for extended metadata"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ product_id, metadata_uri }) => {
    void metadata_uri;
    return notYetAvailable(
      "Certificate minting",
      `No mint endpoint exists yet; nothing was minted for product ${product_id}. authichain_verify_product returns a signed (off-chain) verification certificate when the API has a signing key configured.`
    );
  }
);

// ═══════════════════════════════════════════════════════════════
// TOOL 8: Cannabis Verification (StrainChain)
// Revenue: $0.50–2.00 per cannabis verification
// ═══════════════════════════════════════════════════════════════

server.registerTool(
  "authichain_verify_cannabis",
  {
    title: "Verify Cannabis Product (StrainChain)",
    description: `NOT YET AVAILABLE — the AuthiChain API has no endpoint for this tool; calling it returns an error without contacting the API.

Verify a cannabis product through StrainChain — AuthiChain's cannabis-specific vertical.

Checks product against 1,001+ registered Michigan cannabis products including:
- Strain authenticity and genetics
- Lab test results (COA verification)
- Supply chain from cultivator to dispensary
- METRC compliance status
- Terpene and cannabinoid profiles

Args:
  - product_id (string): StrainChain product ID or QR code payload
  - include_lab_results (boolean): Include full COA/lab test data (default: false)

Returns: Cannabis-specific verification with strain info, lab data, and compliance status.

Use when: A consumer or dispensary asks about cannabis product authenticity or lab results.`,
    inputSchema: {
      product_id: z.string().min(1).describe("StrainChain product ID or QR payload"),
      include_lab_results: z.boolean().default(false).describe("Include full lab test / COA data"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ product_id, include_lab_results }) => {
    void include_lab_results;
    return notYetAvailable(
      "StrainChain cannabis verification",
      `No StrainChain endpoint exists yet (product ${product_id}). authichain_verify_product can look up registered products, but it has no lab/COA or METRC data.`
    );
  }
);

// ═══════════════════════════════════════════════════════════════
// TRANSPORT — Stdio (local) or Streamable HTTP (remote/deployed)
// ═══════════════════════════════════════════════════════════════

const transportMode = process.env.TRANSPORT_MODE || "stdio";

if (transportMode === "http") {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.setHeader("Content-Type", "application/json");
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "authichain-mcp-server",
      version: "1.0.0",
      tools: 8,
      uptime: process.uptime(),
    });
  });

  const PORT = parseInt(process.env.PORT || "3847", 10);
  app.listen(PORT, () => {
    console.log(`AuthiChain MCP Server running on http://localhost:${PORT}/mcp`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Tools: 8 (4 backed by the API, 4 not yet available)`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AuthiChain MCP Server running on stdio");
}
