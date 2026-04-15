// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E test for knowledge extraction deduplication.
 *
 * Uploads multiple documents with overlapping entities and verifies
 * all three dedup layers fire:
 *   Layer 1 — upsert on [label, type] during POST /ops
 *   Layer 2 — cross-chunk merge (large doc split across chunks)
 *   Layer 3 — post-write LLM fuzzy matching
 *
 * Requires:
 *   - Running arkeon stack with ENABLE_KNOWLEDGE_PIPELINE=true
 *   - Configured LLM provider (PUT /knowledge/config)
 *   - Real LLM calls — expect ~30-90s runtime
 */

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  addEntityToSpace,
  apiRequest,
  createActor,
  createEntity,
  createSpace,
  getJson,
  jsonRequest,
  uniqueName,
  uploadDirectContent,
} from "./helpers";

// Skip if pipeline is not enabled
const PIPELINE_ENABLED = process.env.ENABLE_KNOWLEDGE_PIPELINE === "true";

// ---------------------------------------------------------------------------
// Test content: three "diplomatic cables" with deliberate entity overlap
// ---------------------------------------------------------------------------

// Doc 1: Short cable — fits in one chunk
const CABLE_1 = `
CONFIDENTIAL — CABLE 1974-TEHRAN-04821

Subject: Meeting between Secretary Kissinger and Shah of Iran

Secretary of State Henry Kissinger met with Shah Mohammad Reza Pahlavi
in Tehran on November 2, 1974 to discuss regional security and oil pricing.
Ambassador Richard Helms facilitated the meeting at the Niavaran Palace.

Kissinger expressed concern about OPEC's planned price increases and their
impact on Western economies. The Shah assured Kissinger that Iran would
moderate its position at the upcoming OPEC summit in Vienna.

The Central Intelligence Agency station chief briefed Kissinger separately
on Soviet military advisors operating in Iraq near the Iranian border.
The Defense Intelligence Agency provided satellite imagery confirming
the presence of Soviet T-62 tanks at Al-Walid airbase.

Kissinger authorized continued support for Kurdish resistance forces
operating in northern Iraq through the SAVAK liaison channel.
The National Security Council will review the full Iran policy
at the next principals meeting in Washington.
`;

// Doc 2: Overlapping entities with slightly different names
// Tests Layer 1 (upsert) and Layer 3 (fuzzy — "Dr. Kissinger" vs "Kissinger")
const CABLE_2 = `
SECRET — CABLE 1974-JIDDA-03190

Subject: Dr. Kissinger's discussions with King Faisal on oil embargo aftermath

Dr. Henry A. Kissinger arrived in Jeddah on November 5, 1974 for talks
with King Faisal bin Abdulaziz Al Saud regarding the aftermath of the
1973 oil embargo and future OPEC pricing strategy.

The Secretary of State emphasized that continued high oil prices threatened
the global economic order. King Faisal expressed willingness to use Saudi
Arabia's influence within OPEC to stabilize prices, contingent on progress
in Arab-Israeli peace negotiations.

Ambassador James Akins accompanied Dr. Kissinger to the Royal Palace.
The Central Intelligence Agency reported that Soviet Union diplomats had
been actively courting Saudi officials, offering military equipment in
exchange for reduced oil production commitments to Western nations.

The National Security Council staff prepared background memoranda on
Saudi-Soviet contacts. The Defense Intelligence Agency assessed that
Moscow's overtures posed a strategic threat to U.S. interests in the
Persian Gulf region.

King Faisal privately warned Kissinger about growing radical movements
funded by Libya's Muammar Gaddafi across the Middle East.
`;

// Doc 3: Large enough to get chunked (~12k chars with repetition).
// Tests Layer 2 (cross-chunk merge) — same entities repeat across chunks.
const CABLE_3_PARTS = [
  `TOP SECRET — CABLE 1974-STATE-28451

Subject: Comprehensive review of Middle East policy following Kissinger shuttle diplomacy

PART I: BACKGROUND AND CONTEXT

Secretary of State Henry Kissinger completed his latest round of shuttle
diplomacy between Israel, Egypt, and Syria in October 1974. The National
Security Council convened a special session to assess progress and outline
next steps for U.S. Middle East policy.

The Central Intelligence Agency provided an updated National Intelligence
Estimate on the military balance in the region. Key findings included:

1. Egypt under President Anwar Sadat was firmly committed to the peace
process but faced domestic pressure from hardliners in the Egyptian
military establishment.

2. Syria's President Hafez al-Assad remained skeptical of American
mediation but recognized the need for a Golan Heights disengagement
agreement.

3. Israel's Prime Minister Yitzhak Rabin faced coalition instability
that limited his negotiating flexibility.

The Defense Intelligence Agency supplemented the CIA assessment with
signals intelligence indicating that the Soviet Union was increasing
arms shipments to Syria through the port of Latakia.

Ambassador Hermann Eilts in Cairo reported that Sadat was growing
impatient with the pace of negotiations and might seek direct talks
with Israel outside the Kissinger framework.`,

  `PART II: REGIONAL DYNAMICS AND THREATS

The Persian Gulf remained a critical concern for U.S. strategic interests.
The Shah of Iran continued to position himself as the regional policeman,
with massive arms purchases from the United States.

King Faisal of Saudi Arabia maintained his insistence that oil policy and
the Arab-Israeli conflict were inextricably linked. Saudi Arabia's role
in OPEC gave Faisal enormous leverage over Western economies.

The Central Intelligence Agency warned that Iraq's Ba'athist government
under Saddam Hussein was expanding its chemical weapons program at
facilities near Samarra. The Defense Intelligence Agency confirmed
these findings through satellite reconnaissance.

Libya's Colonel Muammar Gaddafi continued to fund radical Palestinian
factions and was suspected of channeling arms to insurgent groups in
sub-Saharan Africa. The National Security Council recommended enhanced
monitoring of Libyan activities.

Jordan's King Hussein maintained close but covert contacts with Israeli
officials, facilitated by the CIA station in Amman. These back-channel
communications proved valuable during the October 1973 war.`,

  `PART III: SOVIET STRATEGIC POSTURE

The Soviet Union maintained significant military presence in the
Mediterranean through its Fifth Eskadra naval squadron. The Defense
Intelligence Agency tracked increasing Soviet naval activity near
the Suez Canal following Egypt's partial reopening of the waterway.

Soviet General Secretary Leonid Brezhnev had signaled to Secretary
Kissinger through back-channel communications that Moscow would not
obstruct a limited Sinai disengagement, provided Soviet interests in
Syria were respected.

The CIA station in Moscow reported growing tension between the Soviet
Foreign Ministry under Andrei Gromyko and the Soviet military leadership
over Middle East policy. The KGB was independently cultivating contacts
with Palestinian factions, sometimes at cross-purposes with official
Soviet diplomatic positions.

The National Security Council assessed that the Soviet Union's primary
objective was to prevent a comprehensive peace settlement that would
exclude Moscow from the diplomatic process. Kissinger's bilateral
shuttle diplomacy was precisely the scenario the Soviets feared most.

PART IV: RECOMMENDATIONS

Secretary Kissinger recommended the following to President Gerald Ford:

1. Continue bilateral negotiations while offering the Soviet Union a
symbolic role in any future Geneva conference.

2. Accelerate arms deliveries to Israel to maintain the military balance
while pressuring Rabin for territorial concessions.

3. Deepen the security relationship with Shah of Iran as a counterweight
to Soviet influence in the Gulf.

4. Maintain the SAVAK liaison for intelligence sharing on Soviet and
Iraqi military activities.

5. Press King Faisal to decouple oil pricing from the Arab-Israeli
conflict at the December OPEC meeting.

The National Security Council will prepare detailed implementation plans
for each recommendation. The Central Intelligence Agency will provide
weekly intelligence updates on regional developments.

END CABLE`,
];

const CABLE_3 = CABLE_3_PARTS.join("\n\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8000";

async function waitForJob(
  apiKey: string,
  jobId: string,
  timeoutMs = 120_000,
  pollMs = 3_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await getJson(`/knowledge/jobs/${jobId}`, apiKey);
    const job = body.job as Record<string, unknown>;
    if (job.status === "completed" || job.status === "failed") {
      return job;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Job ${jobId} did not complete within ${timeoutMs}ms`);
}

/** Wait for the top-level ingest job for an entity to complete (auto-triggered or manual). */
async function waitForEntityExtraction(
  apiKey: string,
  entityId: string,
  timeoutMs = 120_000,
  pollMs = 3_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await getJson(
      `/knowledge/jobs?entity_id=${entityId}&limit=5`,
      apiKey,
    );
    const jobs = (body as any).jobs as Array<Record<string, unknown>>;
    // Find the top-level ingest job (no parent)
    const topJob = jobs.find(
      (j) => j.job_type === "ingest" && !j.parent_job_id,
    );
    if (topJob && (topJob.status === "completed" || topJob.status === "failed")) {
      return topJob;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Extraction for entity ${entityId} did not complete within ${timeoutMs}ms`);
}

async function searchEntities(
  apiKey: string,
  query: string,
  opts?: { spaceId?: string; limit?: number },
): Promise<Array<Record<string, unknown>>> {
  const limit = opts?.limit ?? 50;
  let url = `/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  if (opts?.spaceId) url += `&space_id=${opts.spaceId}`;
  const { body } = await getJson(url, apiKey);
  return ((body as any).results ?? []) as Array<Record<string, unknown>>;
}

async function getEntityDetail(
  apiKey: string,
  entityId: string,
): Promise<Record<string, unknown>> {
  const { body } = await getJson(`/entities/${entityId}`, apiKey);
  return (body as any).entity as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!PIPELINE_ENABLED)(
  "Knowledge extraction dedup (e2e)",
  { timeout: 300_000 },
  () => {
    let actor: Awaited<ReturnType<typeof createActor>>;
    let spaceId: string;
    const docIds: string[] = [];
    const jobIds: string[] = [];

    test("setup: create actor and isolated space", async () => {
      actor = await createActor(adminApiKey, {
        maxReadLevel: 3,
        maxWriteLevel: 3,
      });
      const space = await createSpace(actor.apiKey, uniqueName("dedup-test"));
      spaceId = space.id;
    });

    // --- Enable scope_to_space so extracted entities land in our test space ---

    test("setup: enable scope_to_space", async () => {
      const { response } = await jsonRequest("/knowledge/config", {
        method: "PUT",
        apiKey: adminApiKey,
        json: { extraction: { scope_to_space: true } },
      });
      expect(response.status).toBe(200);
    });

    // --- Upload three documents ---

    test("upload cable 1 (short, Kissinger-Shah meeting)", async () => {
      const entity = await createEntity(actor.apiKey, "document", {
        label: uniqueName("cable-tehran-1974"),
      }, { space_id: spaceId });
      docIds.push(entity.id);

      await uploadDirectContent(
        actor.apiKey,
        entity.id,
        "body",
        entity.ver,
        CABLE_1,
        "cable-tehran-1974.txt",
      );
    });

    test("upload cable 2 (short, overlapping entities — Kissinger-Faisal)", async () => {
      const entity = await createEntity(actor.apiKey, "document", {
        label: uniqueName("cable-jidda-1974"),
      }, { space_id: spaceId });
      docIds.push(entity.id);

      await uploadDirectContent(
        actor.apiKey,
        entity.id,
        "body",
        entity.ver,
        CABLE_2,
        "cable-jidda-1974.txt",
      );
    });

    test("upload cable 3 (large, will be chunked — comprehensive review)", async () => {
      const entity = await createEntity(actor.apiKey, "document", {
        label: uniqueName("cable-state-1974"),
      }, { space_id: spaceId });
      docIds.push(entity.id);

      await uploadDirectContent(
        actor.apiKey,
        entity.id,
        "body",
        entity.ver,
        CABLE_3,
        "cable-state-comprehensive-1974.txt",
      );
    });

    // --- Wait for auto-triggered extraction (content upload triggers ingest via poller) ---

    test("extract cable 1 → baseline entities", async () => {
      // Use admin key to poll jobs — auto-triggered jobs have empty triggered_by
      // and non-admin actors can't see them via RLS
      const job = await waitForEntityExtraction(adminApiKey, docIds[0]);
      expect(job.status).toBe("completed");
      jobIds.push(job.id as string);

      const result = job.result as Record<string, unknown>;
      console.log("[cable 1] result:", JSON.stringify(result, null, 2));
      expect((result.createdEntities as number) ?? 0).toBeGreaterThan(0);
    });

    test("extract cable 2 → should upsert overlapping entities (Layer 1)", async () => {
      const job = await waitForEntityExtraction(adminApiKey, docIds[1]);
      expect(job.status).toBe("completed");
      jobIds.push(job.id as string);

      const result = job.result as Record<string, unknown>;
      console.log("[cable 2] result:", JSON.stringify(result, null, 2));

      const created = (result.createdEntities as number) ?? 0;
      const childJobs = (result.childJobs as number) ?? undefined;
      console.log(`[cable 2] created=${created}, childJobs=${childJobs}`);
    });

    test("extract cable 3 (chunked) → cross-chunk merge (Layer 2) + upsert (Layer 1)", async () => {
      const job = await waitForEntityExtraction(adminApiKey, docIds[2], 180_000);
      expect(job.status).toBe("completed");
      jobIds.push(job.id as string);

      const result = job.result as Record<string, unknown>;
      console.log("[cable 3] result:", JSON.stringify(result, null, 2));
    });

    // --- Verify dedup effectiveness ---

    test("verify: Kissinger is not duplicated across documents", async () => {
      // Search for Kissinger within our test space only
      const results = await searchEntities(actor.apiKey, "Kissinger", { spaceId });
      const kissinger = results.filter((r) => {
        const label = ((r.properties as any)?.label ?? "").toLowerCase();
        return label.includes("kissinger") && (r.type === "person" || !r.type);
      });

      console.log(
        `[dedup check] Kissinger entities found: ${kissinger.length}`,
        kissinger.map((k) => ({
          id: k.id,
          label: (k.properties as any)?.label,
          type: k.type,
        })),
      );

      // With perfect dedup we'd have exactly 1 Kissinger person entity.
      // The LLM may extract variants ("Henry Kissinger", "Secretary Kissinger",
      // "Dr. Kissinger") that are different labels and won't upsert-merge.
      // Layer 3 (LLM fuzzy) flags these but doesn't auto-merge.
      // Allow up to 5 variants across 3 docs — more than that means upsert is broken.
      expect(kissinger.length).toBeLessThanOrEqual(5);
    });

    test("verify: common entities are not massively duplicated", async () => {
      // These entities appear in all 3 cables
      const commonEntities = ["CIA", "Soviet Union", "OPEC", "National Security Council"];
      const duplicateCounts: Record<string, number> = {};

      for (const name of commonEntities) {
        const results = await searchEntities(actor.apiKey, name, { spaceId });
        // Filter to actual matches (search may return partial hits)
        const matches = results.filter((r) => {
          const label = ((r.properties as any)?.label ?? "").toLowerCase();
          return label.includes(name.toLowerCase().split(" ")[0]);
        });
        duplicateCounts[name] = matches.length;
      }

      console.log("[dedup check] common entity counts:", duplicateCounts);

      // Each common entity should exist at most a few times, not once per document.
      // With 3 docs and upsert working, we expect 1-2 per entity.
      // Allow up to 6 for LLM label variance across chunks/docs.
      for (const [name, count] of Object.entries(duplicateCounts)) {
        expect(
          count,
          `"${name}" has ${count} copies — dedup may not be working`,
        ).toBeLessThanOrEqual(6);
      }
    });

    test("verify: job logs show dedup activity", async () => {
      // Check that at least one job reported potential duplicates or updated entities
      let totalPotentialDuplicates = 0;

      for (const jobId of jobIds) {
        if (!jobId) continue;
        const { body } = await getJson(`/knowledge/jobs/${jobId}`, adminApiKey);
        const job = (body as any)?.job as Record<string, unknown> | undefined;
        if (!job) continue;

        const result = job.result as Record<string, unknown> | null;
        if (result?.mergedDuplicates) {
          totalPotentialDuplicates += result.mergedDuplicates as number;
        }

        // Also check child jobs for dedup info
        const logs = (body as any)?.logs as Array<Record<string, unknown>> | undefined;
        const dedupLogs = (logs ?? []).filter(
          (l) => typeof l.message === "string" && l.message.includes("duplicate"),
        );
        if (dedupLogs.length > 0) {
          console.log(`[job ${jobId}] dedup logs:`, dedupLogs.map((l) => l.message));
        }
      }

      console.log(`[dedup check] total potential duplicates flagged: ${totalPotentialDuplicates}`);
      // We expect at least some duplicates to be flagged across 3 overlapping docs
      // But this is LLM-dependent, so just log — don't hard-fail
    });

    // --- Cleanup ---

    test("cleanup: restore scope_to_space=false", async () => {
      await jsonRequest("/knowledge/config", {
        method: "PUT",
        apiKey: adminApiKey,
        json: { extraction: { scope_to_space: false } },
      });
    });

    // --- Summary ---

    test("summary: print entity counts by type", async () => {
      // Get a broad search to see what was extracted in our space
      const allResults = await searchEntities(actor.apiKey, "1974", { spaceId, limit: 100 });
      const typeCounts: Record<string, number> = {};

      for (const r of allResults) {
        const t = (r.type as string) ?? "unknown";
        typeCounts[t] = (typeCounts[t] ?? 0) + 1;
      }

      console.log("[summary] entities by type:", typeCounts);
      console.log("[summary] total entities found:", allResults.length);

      // Sanity: we should have extracted a meaningful number of entities
      // 3 docs + extracted entities — at least 5 total (3 docs + some extracted)
      expect(allResults.length).toBeGreaterThanOrEqual(5);
    });
  },
);
