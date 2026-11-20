// Offline check that the Chat SDK exports and methods src/exulu/channels/chat-instance.ts
// relies on exist in the installed packages. Not part of jest (the packages are ESM only).
// No network call and no database connection: the pg Pool is never connected and
// nothing is initialized. Run: node scripts/check-chat-sdk.mjs
import assert from "node:assert/strict";
import pg from "pg";

const { Chat } = await import("chat");
const { createWhatsAppAdapter } = await import("@chat-adapter/whatsapp");
const { createPostgresState } = await import("@chat-adapter/state-pg");

const results = [];
const check = (label, condition) => {
  assert.ok(condition, label);
  results.push(`ok  ${label}`);
};

check("chat exports Chat (class)", typeof Chat === "function");
check("@chat-adapter/whatsapp exports createWhatsAppAdapter", typeof createWhatsAppAdapter === "function");
check("@chat-adapter/state-pg exports createPostgresState", typeof createPostgresState === "function");

const silent = { child: () => silent, debug() {}, info() {}, warn() {}, error() {} };

const adapter = createWhatsAppAdapter({
  accessToken: "dummy-access-token",
  appSecret: "dummy-app-secret",
  phoneNumberId: "111",
  verifyToken: "dummy-verify-token",
  userName: "exulu-agent",
  logger: silent,
});
for (const method of ["postMessage", "startTyping", "markAsRead", "handleWebhook", "splitMessage"]) {
  check(`adapter.${method} is a function`, typeof adapter[method] === "function");
}
check("adapter.persistThreadHistory (typing target needs inbound history)", adapter.persistThreadHistory === true);
check(
  "thread id format whatsapp:<phoneNumberId>:<userWaId>",
  adapter.encodeThreadId({ phoneNumberId: "111", userWaId: "49151" }) === "whatsapp:111:49151",
);
check("adapter splits at 4096 characters", adapter.splitMessage("a\n".repeat(3000)).every((c) => c.length <= 4096));

const pool = new pg.Pool({ connectionString: "postgres://unused@127.0.0.1:1/unused" });
const state = createPostgresState({ client: pool, keyPrefix: "exulu-channel", autoCreateSchema: false, logger: silent });
check("state.connect / disconnect are functions", typeof state.connect === "function" && typeof state.disconnect === "function");

const chat = new Chat({
  userName: "exulu-agent",
  adapters: { whatsapp: adapter },
  state,
  concurrency: "concurrent",
  logger: silent,
});
for (const method of ["onDirectMessage", "initialize", "shutdown"]) {
  check(`chat.${method} is a function`, typeof chat[method] === "function");
}
check("chat.webhooks.whatsapp is a function", typeof chat.webhooks?.whatsapp === "function");

// GET verification is answered by the adapter alone. Calling it through chat.webhooks
// would connect state first, so the adapter is called directly: still offline.
const challenge = await adapter.handleWebhook(
  new Request(
    "https://example.invalid/hook?hub.mode=subscribe&hub.verify_token=dummy-verify-token&hub.challenge=42",
  ),
);
check("verify-token challenge answered offline", challenge.status === 200 && (await challenge.text()) === "42");
const unsigned = await adapter.handleWebhook(
  new Request("https://example.invalid/hook", { method: "POST", body: "{}" }),
);
check("unsigned POST rejected with 401", unsigned.status === 401);

await pool.end();
console.log(results.join("\n"));
console.log(`\n${results.length} checks passed`);
