import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  apiRequest,
  createActor,
  createComment,
  createEntity,
  createRelationship,
  getArkeId,
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Entities CRUD", () => {
  let arkeId: string;
  let actor: Awaited<ReturnType<typeof createActor>>;

  test("setup: get arkeId and create actor", async () => {
    arkeId = await getArkeId();
    actor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
  });

  test("Create entity with properties", async () => {
    const entity = await createEntity(actor.apiKey, arkeId, "note", {
      label: uniqueName("crud-create"),
      description: "A test entity",
    });
    expect(entity.id).toBeTruthy();
    expect(entity.properties.label).toContain("crud-create");
    expect(entity.properties.description).toBe("A test entity");
    expect(entity.ver).toBe(1);
  });

  test("Get entity by ID", async () => {
    const entity = await createEntity(actor.apiKey, arkeId, "note", {
      label: uniqueName("crud-get"),
    });
    const { response, body } = await getJson(`/entities/${entity.id}`, actor.apiKey);
    expect(response.status).toBe(200);
    expect((body as any).entity.id).toBe(entity.id);
    expect((body as any).entity.properties.label).toBe(entity.properties.label);
  });

  test("Update entity with CAS (ver)", async () => {
    const entity = await createEntity(actor.apiKey, arkeId, "note", {
      label: "version-1",
    });
    expect(entity.ver).toBe(1);

    const { response, body } = await jsonRequest(`/entities/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 1, properties: { label: "version-2" } },
    });
    expect(response.status).toBe(200);
    expect((body as any).entity.ver).toBe(2);
    expect((body as any).entity.properties.label).toBe("version-2");
  });

  test("CAS conflict on stale ver returns 409", async () => {
    const entity = await createEntity(actor.apiKey, arkeId, "note", {
      label: "cas-test",
    });

    // First update succeeds
    await jsonRequest(`/entities/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 1, properties: { label: "cas-updated" } },
    });

    // Second update with stale ver=1 should fail with 409
    const { response, body } = await jsonRequest(`/entities/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 1, properties: { label: "cas-stale" } },
    });
    expect(response.status).toBe(409);
    expect((body as any).error?.code).toBe("cas_conflict");
  });

  test("Delete entity", async () => {
    const entity = await createEntity(actor.apiKey, arkeId, "note", {
      label: uniqueName("crud-delete"),
    });

    const { response } = await apiRequest(`/entities/${entity.id}`, {
      method: "DELETE",
      apiKey: actor.apiKey,
    });
    expect(response.status).toBe(204);

    // Verify deleted
    const { response: getRes } = await getJson(`/entities/${entity.id}`, actor.apiKey);
    expect(getRes.status).toBe(404);
  });

  test("Entity versions: list and get specific version", async () => {
    const entity = await createEntity(actor.apiKey, arkeId, "note", {
      label: "v1-label",
    });

    // Update to create v2
    await jsonRequest(`/entities/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 1, properties: { label: "v2-label" }, note: "second edit" },
    });

    // Small delay for background version writes
    await new Promise((r) => setTimeout(r, 500));

    // List versions
    const { response: listRes, body: listBody } = await getJson(
      `/entities/${entity.id}/versions`,
      actor.apiKey,
    );
    expect(listRes.status).toBe(200);
    expect((listBody as any).versions.length).toBeGreaterThanOrEqual(2);

    // Get specific version 1
    const { response: v1Res, body: v1Body } = await getJson(
      `/entities/${entity.id}/versions/1`,
      actor.apiKey,
    );
    expect(v1Res.status).toBe(200);
    expect((v1Body as any).ver).toBe(1);
    expect((v1Body as any).properties.label).toBe("v1-label");
  });

  test("Entity activity log", async () => {
    const entity = await createEntity(actor.apiKey, arkeId, "note", {
      label: uniqueName("activity-log"),
    });

    // Update to generate activity
    await jsonRequest(`/entities/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 1, properties: { label: "activity-updated" } },
    });

    // Small delay for background activity writes
    await new Promise((r) => setTimeout(r, 500));

    const { response, body } = await getJson(
      `/entities/${entity.id}/activity`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    const actions = (body as any).activity.map((a: any) => a.action);
    expect(actions).toContain("entity_created");
  });

  test("Relationships: create, list, delete", async () => {
    const source = await createEntity(actor.apiKey, arkeId, "note", {
      label: uniqueName("rel-source"),
    });
    const target = await createEntity(actor.apiKey, arkeId, "note", {
      label: uniqueName("rel-target"),
    });

    // Create relationship
    const rel = await createRelationship(
      actor.apiKey,
      source.id,
      "references",
      target.id,
      { weight: 1 },
    );
    expect(rel.edge).toBeTruthy();
    expect(rel.edge.predicate).toBe("references");
    expect(rel.edge.source_id).toBe(source.id);
    expect(rel.edge.target_id).toBe(target.id);

    // List relationships
    const { response: listRes, body: listBody } = await getJson(
      `/entities/${source.id}/relationships`,
      actor.apiKey,
    );
    expect(listRes.status).toBe(200);
    expect((listBody as any).relationships.length).toBeGreaterThan(0);
    expect(
      (listBody as any).relationships.some(
        (r: any) => r.target_id === target.id && r.predicate === "references",
      ),
    ).toBe(true);

    // Delete relationship
    const relId = rel.edge.id;
    const { response: deleteRes } = await apiRequest(`/relationships/${relId}`, {
      method: "DELETE",
      apiKey: actor.apiKey,
    });
    expect(deleteRes.status).toBe(204);

    // Verify deleted
    const { response: getRes } = await getJson(`/relationships/${relId}`, actor.apiKey);
    expect(getRes.status).toBe(404);
  });

  test("Relationships: 403 when actor lacks edit access on source entity", async () => {
    // Actor A creates source and target
    const source = await createEntity(actor.apiKey, arkeId, "note", {
      label: uniqueName("rel-perm-source"),
    });
    const target = await createEntity(actor.apiKey, arkeId, "note", {
      label: uniqueName("rel-perm-target"),
    });

    // Actor B has no edit access on source
    const actorB = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });

    const { response, body } = await jsonRequest(
      `/entities/${source.id}/relationships`,
      {
        method: "POST",
        apiKey: actorB.apiKey,
        json: { predicate: "references", target_id: target.id },
      },
    );
    expect(response.status).toBe(403);
    expect((body as any).error.code).toBe("forbidden");
    expect((body as any).error.message).toContain("edit access");
  });

  test("Relationships: 201 when actor has editor grant on source entity", async () => {
    const source = await createEntity(actor.apiKey, arkeId, "note", {
      label: uniqueName("rel-grant-source"),
    });
    const target = await createEntity(actor.apiKey, arkeId, "note", {
      label: uniqueName("rel-grant-target"),
    });

    const actorB = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });

    // Grant editor role to actor B on the source entity
    const { response: grantRes } = await jsonRequest(
      `/entities/${source.id}/permissions`,
      {
        method: "POST",
        apiKey: actor.apiKey,
        json: { grantee_type: "actor", grantee_id: actorB.id, role: "editor" },
      },
    );
    expect(grantRes.status).toBe(201);

    // Actor B should now be able to create a relationship from source
    const { response: relRes } = await jsonRequest(
      `/entities/${source.id}/relationships`,
      {
        method: "POST",
        apiKey: actorB.apiKey,
        json: { predicate: "references", target_id: target.id },
      },
    );
    expect(relRes.status).toBe(201);
  });

  test("Relationships: 404 for nonexistent source entity", async () => {
    const target = await createEntity(actor.apiKey, arkeId, "note", {
      label: uniqueName("rel-404-target"),
    });

    const { response, body } = await jsonRequest(
      `/entities/01AAAAAAAAAAAAAAAAAAAAAAAA/relationships`,
      {
        method: "POST",
        apiKey: actor.apiKey,
        json: { predicate: "references", target_id: target.id },
      },
    );
    expect(response.status).toBe(404);
    expect((body as any).error.code).toBe("not_found");
  });

  test("Filter entities by boolean property", async () => {
    const tag = uniqueName("bool-filter");
    // Create entity with boolean true
    const eTrue = await createEntity(actor.apiKey, arkeId, "note", {
      label: tag,
      extracted: true,
    });
    // Create entity with boolean false
    const eFalse = await createEntity(actor.apiKey, arkeId, "note", {
      label: tag,
      extracted: false,
    });

    // Filter for extracted:true
    const { response, body } = await getJson(
      `/entities?filter=label:${tag},extracted:true`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(eTrue.id);
    expect(ids).not.toContain(eFalse.id);

    // Filter for extracted:false
    const { body: bodyF } = await getJson(
      `/entities?filter=label:${tag},extracted:false`,
      actor.apiKey,
    );
    const idsF = (bodyF as any).entities.map((e: any) => e.id);
    expect(idsF).toContain(eFalse.id);
    expect(idsF).not.toContain(eTrue.id);
  });

  test("Filter entities by numeric property", async () => {
    const tag = uniqueName("num-filter");
    const e1 = await createEntity(actor.apiKey, arkeId, "note", {
      label: tag,
      count: 42,
    });
    const e2 = await createEntity(actor.apiKey, arkeId, "note", {
      label: tag,
      count: 99,
    });

    // Exact match
    const { body } = await getJson(
      `/entities?filter=label:${tag},count:42`,
      actor.apiKey,
    );
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).not.toContain(e2.id);
  });

  test("Filter entities by string property (unchanged behavior)", async () => {
    const tag = uniqueName("str-filter");
    const e1 = await createEntity(actor.apiKey, arkeId, "note", {
      label: tag,
      status: "active",
    });
    const e2 = await createEntity(actor.apiKey, arkeId, "note", {
      label: tag,
      status: "archived",
    });

    const { body } = await getJson(
      `/entities?filter=label:${tag},status:active`,
      actor.apiKey,
    );
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).not.toContain(e2.id);
  });

  test("Filter entities by property negation (!:)", async () => {
    const tag = uniqueName("neg-filter");
    const e1 = await createEntity(actor.apiKey, arkeId, "note", {
      label: tag,
      extracted: true,
    });
    const e2 = await createEntity(actor.apiKey, arkeId, "note", {
      label: tag,
      extracted: false,
    });

    // Negate boolean
    const { body } = await getJson(
      `/entities?filter=label:${tag},extracted!:true`,
      actor.apiKey,
    );
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(e2.id);
    expect(ids).not.toContain(e1.id);
  });

  test("Comments: create, list with threading, delete", async () => {
    const entity = await createEntity(actor.apiKey, arkeId, "note", {
      label: uniqueName("comment-target"),
    });

    // Create top-level comment
    const comment1 = await createComment(actor.apiKey, entity.id, "Top-level comment");
    expect(comment1.id).toBeTruthy();
    expect(comment1.body).toBe("Top-level comment");
    expect(comment1.parent_id).toBeNull();

    // Create reply
    const reply = await createComment(
      actor.apiKey,
      entity.id,
      "Reply to top-level",
      comment1.id,
    );
    expect(reply.parent_id).toBe(comment1.id);

    // List comments -- should have threading
    const { response: listRes, body: listBody } = await getJson(
      `/entities/${entity.id}/comments`,
      actor.apiKey,
    );
    expect(listRes.status).toBe(200);
    const comments = (listBody as any).comments;
    expect(comments.length).toBeGreaterThan(0);

    const topComment = comments.find((c: any) => c.id === comment1.id);
    expect(topComment).toBeTruthy();
    expect(topComment.replies.length).toBeGreaterThan(0);
    expect(topComment.replies[0].id).toBe(reply.id);

    // Delete comment
    const { response: deleteRes } = await apiRequest(
      `/entities/${entity.id}/comments/${comment1.id}`,
      { method: "DELETE", apiKey: actor.apiKey },
    );
    expect(deleteRes.status).toBe(204);
  });
});
