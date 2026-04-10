/**
 * Search scale test: measures Meilisearch performance at increasing index sizes.
 *
 * Tests:
 *   1. Seed entities in batches, measuring index throughput
 *   2. Query latency at 1K, 5K, 10K, 25K, 50K entities
 *   3. Write-to-search delay (sync lag)
 *   4. Permission filtering correctness at scale
 *   5. Pagination through large result sets
 *
 * Usage:
 *   PORT=8001 MEILI_URL=http://localhost:7700 MEILI_MASTER_KEY=meili_dev_master_key \
 *     npm run dev -w packages/api &
 *   node packages/api/test/stress/search-scale.mjs
 */

const API = `http://localhost:${process.env.PORT ?? 8001}`;
const KEY = "ApiKey ak_test_admin_key_e2e";
const MEILI_URL = process.env.MEILI_URL ?? "http://localhost:7700";
const MEILI_KEY = process.env.MEILI_MASTER_KEY ?? "meili_dev_master_key";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(method, path, body) {
  const opts = {
    method,
    headers: { Authorization: KEY, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${API}${path}`, opts);
}

async function search(q, params = {}) {
  const url = new URL(`${API}/search`);
  url.searchParams.set("q", q);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const start = performance.now();
  const res = await fetch(url, { headers: { Authorization: KEY } });
  const elapsed = performance.now() - start;
  const data = await res.json();
  return { elapsed, data, status: res.status };
}

async function searchUnauth(q, params = {}) {
  const url = new URL(`${API}/search`);
  url.searchParams.set("q", q);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const start = performance.now();
  const res = await fetch(url);
  const elapsed = performance.now() - start;
  const data = await res.json();
  return { elapsed, data, status: res.status };
}

async function meiliStats() {
  const res = await fetch(`${MEILI_URL}/indexes/entities/stats`, {
    headers: { Authorization: `Bearer ${MEILI_KEY}` },
  });
  return res.json();
}

async function waitForMeiliProcessing() {
  while (true) {
    const res = await fetch(`${MEILI_URL}/tasks?statuses=enqueued,processing&limit=1`, {
      headers: { Authorization: `Bearer ${MEILI_KEY}` },
    });
    const data = await res.json();
    if (data.total === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---------------------------------------------------------------------------
// Data generation
// ---------------------------------------------------------------------------

const TOPICS = [
  "climate change", "machine learning", "quantum computing", "neuroscience",
  "cryptography", "renewable energy", "gene editing", "urban planning",
  "philosophy", "economics", "agriculture", "cybersecurity", "robotics",
  "astrophysics", "linguistics", "archaeology", "oceanography", "genetics",
  "nanotechnology", "epidemiology", "anthropology", "volcanology", "seismology",
  "paleontology", "meteorology", "glaciology", "taxonomy", "enzymology",
];

const ADJECTIVES = [
  "comprehensive", "introductory", "advanced", "comparative", "experimental",
  "theoretical", "applied", "systematic", "preliminary", "longitudinal",
  "cross-sectional", "meta-analytic", "qualitative", "quantitative", "mixed-method",
];

const NOUNS = [
  "study", "analysis", "review", "survey", "investigation", "assessment",
  "framework", "model", "simulation", "dataset", "protocol", "methodology",
  "experiment", "observation", "measurement", "benchmark", "evaluation",
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateEntity(i) {
  const topic = randomFrom(TOPICS);
  const adj = randomFrom(ADJECTIVES);
  const noun = randomFrom(NOUNS);
  const readLevel = Math.random() < 0.5 ? 0 : Math.random() < 0.5 ? 1 : Math.random() < 0.5 ? 2 : 3;
  return {
    type: Math.random() < 0.8 ? "document" : "person",
    read_level: readLevel,
    write_level: readLevel,
    properties: {
      label: `${adj.charAt(0).toUpperCase() + adj.slice(1)} ${topic} ${noun} #${i}`,
      description: `A ${adj} ${noun} examining ${topic} with focus on recent developments in the field. Entity number ${i} in the scale test dataset.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Test phases
// ---------------------------------------------------------------------------

async function seedBatch(startIdx, count) {
  const entities = [];
  for (let i = startIdx; i < startIdx + count; i++) {
    entities.push(generateEntity(i));
  }

  // Create entities via API (sequentially to avoid overwhelming)
  const CONCURRENT = 20;
  const start = performance.now();
  for (let i = 0; i < entities.length; i += CONCURRENT) {
    const batch = entities.slice(i, i + CONCURRENT);
    await Promise.all(batch.map((e) => api("POST", "/entities", e)));
  }
  const elapsed = performance.now() - start;
  return { count, elapsed };
}

async function runSearchBenchmark(label, queries) {
  console.log(`\n--- ${label} ---`);
  const stats = await meiliStats();
  console.log(`Index size: ${stats.numberOfDocuments} documents`);

  for (const { q, params, desc } of queries) {
    const times = [];
    // Warm up
    await search(q, params);
    // 5 runs
    for (let i = 0; i < 5; i++) {
      const r = await search(q, params);
      times.push(r.elapsed);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    const r = await search(q, params);
    console.log(
      `  ${desc}: avg=${avg.toFixed(1)}ms min=${min.toFixed(1)}ms max=${max.toFixed(1)}ms results=${r.data.results?.length ?? 0} total=${r.data.estimatedTotalHits ?? "?"}`,
    );
  }
}

async function testSyncLag() {
  console.log("\n--- Sync lag test ---");
  const uniqueLabel = `sync-lag-test-${Date.now()}`;

  // Create entity
  const createStart = performance.now();
  await api("POST", "/entities", {
    type: "document",
    read_level: 0,
    write_level: 0,
    properties: { label: uniqueLabel, description: "Testing write-to-search delay" },
  });
  const createElapsed = performance.now() - createStart;

  // Poll until it appears in search
  const pollStart = performance.now();
  let found = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const r = await search(uniqueLabel);
    if (r.data.results?.length > 0) {
      found = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const syncLag = performance.now() - pollStart;

  if (found) {
    console.log(`  Create: ${createElapsed.toFixed(0)}ms, Sync lag: ${syncLag.toFixed(0)}ms`);
  } else {
    console.log(`  Create: ${createElapsed.toFixed(0)}ms, Sync lag: >5000ms (NOT FOUND)`);
  }
}

async function testPermissions() {
  console.log("\n--- Permission filtering at scale ---");

  // Authenticated (admin) - should see all levels
  const authResult = await search("study");
  // Unauthenticated - should only see read_level=0
  const unauthResult = await searchUnauth("study");

  const authLevels = {};
  for (const r of authResult.data.results) {
    authLevels[r.read_level] = (authLevels[r.read_level] || 0) + 1;
  }
  const unauthLevels = {};
  for (const r of unauthResult.data.results) {
    unauthLevels[r.read_level] = (unauthLevels[r.read_level] || 0) + 1;
  }

  console.log(`  Authenticated: ${authResult.data.results.length} results, levels: ${JSON.stringify(authLevels)}`);
  console.log(`  Unauthenticated: ${unauthResult.data.results.length} results, levels: ${JSON.stringify(unauthLevels)}`);

  // Verify no leak
  const leaked = unauthResult.data.results.filter((r) => r.read_level > 0);
  if (leaked.length > 0) {
    console.log(`  *** LEAK DETECTED: ${leaked.length} entities with read_level > 0 visible to unauthenticated user ***`);
  } else {
    console.log(`  No permission leaks detected`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const BENCHMARK_QUERIES = [
  { q: "climate", params: {}, desc: "common keyword" },
  { q: "quantum computing", params: {}, desc: "two words" },
  { q: "xyznonexistent", params: {}, desc: "no results" },
  { q: "clmate", params: {}, desc: "typo (climate)" },
  { q: "neuro", params: {}, desc: "prefix search" },
  { q: "study", params: { type: "document" }, desc: "keyword + type filter" },
  { q: "study", params: { read_level: "0" }, desc: "keyword + read_level=0" },
  { q: "analysis", params: { limit: "200" }, desc: "large page (200)" },
];

const MILESTONES = [1000, 5000, 10000, 25000];

async function main() {
  console.log("==============================================");
  console.log("  MEILISEARCH SCALE TEST");
  console.log("==============================================");

  // Check API is up
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    console.error("API not reachable at", API);
    process.exit(1);
  }

  // Reindex existing data
  console.log("\nReindexing existing data...");
  const reindex = await api("POST", "/admin/reindex");
  const reindexData = await reindex.json();
  console.log(`  Existing: ${reindexData.indexed} entities`);

  let totalSeeded = 0;
  let nextMilestone = 0;

  for (const milestone of MILESTONES) {
    const toSeed = milestone - totalSeeded;
    if (toSeed <= 0) continue;

    console.log(`\n=== Seeding to ${milestone} entities (${toSeed} new) ===`);
    const batchSize = 500;
    const seedStart = performance.now();
    for (let i = 0; i < toSeed; i += batchSize) {
      const count = Math.min(batchSize, toSeed - i);
      await seedBatch(totalSeeded + i, count);
      process.stdout.write(`  ${totalSeeded + i + count}/${milestone}\r`);
    }
    totalSeeded = milestone;

    // Wait for Meilisearch to finish processing
    await waitForMeiliProcessing();
    const seedElapsed = performance.now() - seedStart;
    console.log(`  Seeded ${milestone} total in ${(seedElapsed / 1000).toFixed(1)}s (${(toSeed / (seedElapsed / 1000)).toFixed(0)} entities/sec)`);

    // Run benchmark at this milestone
    await runSearchBenchmark(`Search at ${milestone} entities`, BENCHMARK_QUERIES);
  }

  // Sync lag test
  await testSyncLag();

  // Permission test
  await testPermissions();

  console.log("\n==============================================");
  console.log("  SCALE TEST COMPLETE");
  console.log("==============================================");
}

main().catch((err) => {
  console.error("Scale test failed:", err);
  process.exit(1);
});
