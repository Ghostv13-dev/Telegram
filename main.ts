/**
 * STOS V2.3.2 — Entry Point
 *
 * Boots Layer 2 Runtime Services and registers webhook handlers.
 * This file only routes inbound requests — all business logic lives in Layer 1 modules.
 *
 * Webhook invariants enforced here:
 *   - Signature verification before any parsing (both Telegram and GitHub)
 *   - HTTP 200 returned only after a successful atomic KV commit
 *   - No Telegram or GitHub API calls inside any webhook handler
 */

const kv = await Deno.openKv();

// ─── Routing ────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  // Health / readiness
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", version: "2.3.2" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Telegram webhook
  if (url.pathname === "/webhook/telegram" && req.method === "POST") {
    return handleTelegramWebhook(req);
  }

  // GitHub App webhook
  if (url.pathname === "/webhook/github" && req.method === "POST") {
    return handleGitHubWebhook(req);
  }

  return new Response("Not Found", { status: 404 });
});

// ─── Telegram Webhook Handler ───────────────────────────────────────────────

async function handleTelegramWebhook(req: Request): Promise<Response> {
  // Step 1: Validate webhook secret before touching the body
  const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== Deno.env.get("TELEGRAM_WEBHOOK_SECRET")) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Step 2: Parse body
  const body = await req.json().catch(() => null);
  if (!body) return new Response("Bad Request", { status: 400 });

  // Step 3: Read idempotency key
  const updateId = String(body.update_id);

  // Step 4: Idempotency check
  const existing = await kv.get(["idempotency", updateId]);
  if (existing.value) return new Response("OK", { status: 200 });

  // Steps 5–11: Build context → invoke Layer 1 → atomic commit → return 200
  // TODO: implement pipeline in src/layers/2-runtime/telegram-pipeline.ts
  console.log("[telegram] update_id:", updateId, "— pipeline not yet implemented");

  return new Response("OK", { status: 200 });
}

// ─── GitHub Webhook Handler ─────────────────────────────────────────────────

async function handleGitHubWebhook(req: Request): Promise<Response> {
  // Step 1: Read raw body — MUST be unmodified for HMAC verification
  const rawBody = await req.arrayBuffer();

  // Step 2: Verify X-Hub-Signature-256 against raw body
  const sigHeader = req.headers.get("X-Hub-Signature-256");
  if (!sigHeader) return new Response("Unauthorized", { status: 401 });

  const valid = await verifyGitHubSignature(rawBody, sigHeader);
  if (!valid) return new Response("Unauthorized", { status: 401 });

  // Step 3: Read X-GitHub-Delivery as idempotency key
  const deliveryGuid = req.headers.get("X-GitHub-Delivery");
  if (!deliveryGuid) return new Response("Bad Request", { status: 400 });

  // Step 4: Idempotency check
  const existing = await kv.get(["idempotency", deliveryGuid]);
  if (existing.value) return new Response("OK", { status: 200 });

  // Parse body only after verification
  const body = JSON.parse(new TextDecoder().decode(rawBody));
  const eventType = req.headers.get("X-GitHub-Event") ?? "unknown";

  // Steps 5–9: Build context → invoke Layer 1 → atomic commit → return 200 → wake worker
  // TODO: implement pipeline in src/layers/2-runtime/github-pipeline.ts
  console.log("[github] delivery:", deliveryGuid, "event:", eventType, "— pipeline not yet implemented");

  return new Response("OK", { status: 200 });
}

// ─── HMAC-SHA-256 Verification ──────────────────────────────────────────────

async function verifyGitHubSignature(
  body: ArrayBuffer,
  sigHeader: string,
): Promise<boolean> {
  const secret = Deno.env.get("GITHUB_WEBHOOK_SECRET");
  if (!secret) return false;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, body);
  const hex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const expected = `sha256=${hex}`;

  // Constant-time comparison to prevent timing attacks
  if (expected.length !== sigHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sigHeader.charCodeAt(i);
  }
  return diff === 0;
}
