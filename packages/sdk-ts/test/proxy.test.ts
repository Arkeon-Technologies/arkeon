/**
 * Integration test for SDK proxy support.
 *
 * Spins up a tiny HTTP "origin" server and an HTTP CONNECT proxy,
 * then verifies the SDK routes requests through the proxy.
 *
 * Run: npx tsx test/proxy.test.ts
 */

import http from "node:http";
import net from "node:net";
import { once } from "node:events";

// ---------------------------------------------------------------------------
// 1. Origin server — stands in for the Arkeon API
// ---------------------------------------------------------------------------

let originHits = 0;
const origin = http.createServer((_req, res) => {
  originHits++;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, hits: originHits }));
});

// ---------------------------------------------------------------------------
// 2. Forward proxy (HTTP CONNECT tunnel for HTTPS, plain forward for HTTP)
// ---------------------------------------------------------------------------

let proxyHits = 0;
const proxy = http.createServer((req, res) => {
  // Plain HTTP forward proxy
  proxyHits++;
  const target = new URL(req.url!);
  const proxyReq = http.request(target, { method: req.method, headers: req.headers }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode!, proxyRes.headers);
    proxyRes.pipe(res);
  });
  req.pipe(proxyReq);
});

// CONNECT tunnel for HTTPS (not used in this test, but included for completeness)
proxy.on("connect", (req, clientSocket, head) => {
  proxyHits++;
  const [host, port] = req.url!.split(":");
  const serverSocket = net.connect(Number(port), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
});

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function run() {
  origin.listen(0);
  proxy.listen(0);
  await Promise.all([once(origin, "listening"), once(proxy, "listening")]);

  const originPort = (origin.address() as net.AddressInfo).port;
  const proxyPort = (proxy.address() as net.AddressInfo).port;

  // Set env vars BEFORE importing the SDK (it reads them at import time)
  process.env.ARKE_API_URL = `http://127.0.0.1:${originPort}`;
  process.env.ARKE_API_KEY = "test-key";
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
  // Clear any HTTPS vars so only HTTP_PROXY is active
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;

  // Dynamic import so env vars are set first
  const sdk = await import("../src/index.js");

  // --- Test 1: configure() with explicit proxy ---
  console.log("Test 1: configure({ proxy }) with explicit proxy URL");
  await sdk.configure({ proxy: `http://127.0.0.1:${proxyPort}` });

  const res1 = await sdk.get("/health");
  assert(res1?.ok === true, "Expected ok:true from origin");
  assert(proxyHits > 0, "Expected request to go through proxy");
  console.log("  PASS - request routed through proxy\n");

  // --- Test 2: configure() with custom fetch ---
  console.log("Test 2: configure({ fetch }) with custom fetch");
  let customFetchCalled = false;
  await sdk.configure({
    fetch: async (input, init?) => {
      customFetchCalled = true;
      return globalThis.fetch(input, init);
    },
  });

  const res2 = await sdk.get("/health");
  assert(res2?.ok === true, "Expected ok:true from origin");
  assert(customFetchCalled, "Expected custom fetch to be called");
  console.log("  PASS - custom fetch was invoked\n");

  // --- Test 3: auto-detect proxy env var ---
  console.log("Test 3: auto-detect HTTP_PROXY env var");
  const proxyHitsBefore = proxyHits;

  // Use an async subprocess so the event loop stays open for the proxy server
  const { spawn } = await import("node:child_process");
  const sdkPath = new URL("../dist/index.js", import.meta.url).pathname;
  const script = `
    import("${sdkPath}").then(sdk => sdk.get("/health")).then(r => {
      if (!r?.ok) { process.exit(1); }
      process.exit(0);
    }).catch(e => { console.error(e.message); process.exit(1); });
  `;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn("node", ["--input-type=module", "-e", script], {
      cwd: new URL(".", import.meta.url).pathname,
      stdio: "pipe",
      env: {
        ...process.env,
        ARKE_API_URL: `http://127.0.0.1:${originPort}`,
        ARKE_API_KEY: "test-key",
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        HTTPS_PROXY: "",
        ALL_PROXY: "",
      },
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("subprocess timed out")); }, 5000);
    child.on("close", (code) => { clearTimeout(timer); if (stderr) console.log("  subprocess stderr:", stderr); resolve(code ?? 1); });
  });
  assert(exitCode === 0, `Subprocess exited with code ${exitCode}`);
  assert(proxyHits > proxyHitsBefore, "Expected auto-detected proxy to be used");
  console.log("  PASS - proxy auto-detected from HTTP_PROXY env var\n");

  // --- Cleanup ---
  origin.close();
  proxy.close();

  console.log("All tests passed.");
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

run().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
