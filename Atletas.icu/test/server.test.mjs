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

test("asks the user to connect when there are no credentials, without calling the API", async () => {
  let called = false;
  const baseUrl = await startServer({
    env: {},
    fetchImpl: async () => { called = true; },
  });
  const response = await fetch(`${baseUrl}/api/dashboard`);
  const result = await response.json();

  assert.equal(response.status, 401);
  assert.equal(result.error.code, "not_connected");
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

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function connect(baseUrl, body) {
  return fetch(`${baseUrl}/api/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("connects with valid credentials, keeps them server-side and serves the dashboard", async () => {
  const calls = [];
  const baseUrl = await startServer({
    env: {},
    now: () => new Date("2026-09-28T12:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), headers: options.headers });
      return new URL(url).pathname.endsWith("/activities")
        ? Response.json([{ id: "a1" }])
        : Response.json({ id: "i123" });
    },
  });

  const login = await connect(baseUrl, { athleteId: "i123", apiKey: "chave-secreta" });
  const loginBody = await login.text();
  const setCookie = login.headers.get("set-cookie");
  assert.equal(login.status, 200);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.equal(loginBody.includes("chave-secreta"), false);
  assert.equal(calls[0].url.pathname, "/api/v1/athlete/i123");
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from("API_KEY:chave-secreta").toString("base64")}`);

  const cookie = cookieFrom(login);
  const session = await (await fetch(`${baseUrl}/api/session`, { headers: { cookie } })).json();
  assert.deepEqual(session, { connected: true, athlete: "i123" });

  const dashboard = await fetch(`${baseUrl}/api/dashboard?days=7`, { headers: { cookie } });
  const result = await dashboard.json();
  assert.equal(dashboard.status, 200);
  assert.deepEqual(result.activities, [{ id: "a1" }]);
  assert.equal(JSON.stringify(result).includes("chave-secreta"), false);
});

test("rejects invalid credentials on connect and does not create a session", async () => {
  const baseUrl = await startServer({
    env: {},
    fetchImpl: async () => new Response("detalhes privados", { status: 401 }),
  });
  const login = await connect(baseUrl, { athleteId: "i123", apiKey: "errada" });
  const body = await login.text();

  assert.equal(login.status, 401);
  assert.match(body, /invalid_credentials/);
  assert.equal(body.includes("detalhes privados"), false);
  assert.equal(login.headers.get("set-cookie"), null);

  const dashboard = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(dashboard.status, 401);
});

test("requires both username and password before contacting the API", async () => {
  let called = false;
  const baseUrl = await startServer({ env: {}, fetchImpl: async () => { called = true; } });

  for (const body of [{}, { athleteId: "i123" }, { apiKey: "x" }, { athleteId: " ", apiKey: " " }]) {
    const response = await connect(baseUrl, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "missing_fields");
  }
  assert.equal(called, false);
});

test("disconnect ends the session", async () => {
  const baseUrl = await startServer({ env: {}, fetchImpl: async () => Response.json([]) });
  const login = await connect(baseUrl, { athleteId: "i123", apiKey: "chave" });
  const cookie = cookieFrom(login);

  const out = await fetch(`${baseUrl}/api/disconnect`, { method: "POST", headers: { cookie } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);

  const dashboard = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } });
  assert.equal(dashboard.status, 401);
});

test("blocks cross-origin connect attempts", async () => {
  let called = false;
  const baseUrl = await startServer({ env: {}, fetchImpl: async () => { called = true; } });
  const response = await fetch(`${baseUrl}/api/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ athleteId: "i123", apiKey: "x" }),
  });

  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test("serves the connection form in the page", async () => {
  const baseUrl = await startServer({ env: {} });
  const html = await (await fetch(baseUrl)).text();

  assert.match(html, /id="athlete-input"/);
  assert.match(html, /id="key-input" name="password" type="password"/);
});
