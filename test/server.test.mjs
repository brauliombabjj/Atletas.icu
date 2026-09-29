import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createServer } from "../server.mjs";

const servers = new Set();

async function startServer(options) {
  const server = createServer(options);
  servers.add(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => {
    server.close(resolve);
  })));
  servers.clear();
});

test("reports missing API configuration without making an upstream request", async () => {
  let called = false;
  const baseUrl = await startServer({
    env: {},
    fetchImpl: async () => { called = true; },
  });
  const response = await fetch(`${baseUrl}/api/dashboard`);
  const result = await response.json();

  assert.equal(response.status, 503);
  assert.equal(result.error.code, "missing_configuration");
  assert.equal(called, false);
});

test("requests the official date-range endpoint with server-side Basic Auth", async () => {
  let requestUrl;
  let requestHeaders;
  const baseUrl = await startServer({
    env: {
      INTERVALS_API_KEY: "test-secret",
      INTERVALS_ATHLETE_ID: "Braulio Murta",
    },
    now: () => new Date("2026-09-28T12:00:00.000Z"),
    fetchImpl: async (url, options) => {
      requestUrl = new URL(url);
      requestHeaders = options.headers;
      return Response.json([{ id: "activity-1" }]);
    },
  });
  const response = await fetch(`${baseUrl}/api/dashboard?days=30`);
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(requestUrl.pathname, "/api/v1/athlete/Braulio%20Murta/activities");
  assert.equal(requestUrl.searchParams.get("oldest"), "2026-08-30");
  assert.equal(requestUrl.searchParams.get("newest"), "2026-09-28");
  assert.equal(requestUrl.searchParams.get("limit"), "100");
  assert.equal(
    requestUrl.searchParams.get("fields"),
    "id,start_date_local,start_date,type,name,distance,moving_time,elapsed_time,total_elevation_gain",
  );
  assert.equal(requestHeaders.Authorization, `Basic ${Buffer.from("API_KEY:test-secret").toString("base64")}`);
  assert.deepEqual(result.activities, [{ id: "activity-1" }]);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
});

test("rejects unsupported periods without contacting the API", async () => {
  let called = false;
  const baseUrl = await startServer({
    env: { INTERVALS_API_KEY: "test-secret" },
    fetchImpl: async () => { called = true; },
  });
  const response = await fetch(`${baseUrl}/api/dashboard?days=365`);

  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("translates invalid credentials to a safe, actionable error", async () => {
  const baseUrl = await startServer({
    env: { INTERVALS_API_KEY: "test-secret" },
    fetchImpl: async () => new Response("private upstream details", { status: 401 }),
  });
  const response = await fetch(`${baseUrl}/api/dashboard`);
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.match(body, /invalid_credentials/);
  assert.equal(body.includes("private upstream details"), false);
  assert.equal(body.includes("test-secret"), false);
});

test("serves the Portuguese dashboard from the root", async () => {
  const baseUrl = await startServer({ env: {} });
  const response = await fetch(baseUrl);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /lang="pt-BR"/);
  assert.match(html, /Volume de treino/);
});
