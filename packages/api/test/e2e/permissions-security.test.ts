import { describe, expect, test } from "vitest";
import {
  apiRequest,
  createCommons,
  createEntity,
  createGrant,
  generateSigningKeyPair,
  jsonRequest,
  registerAgent,
  signText,
  uniqueName,
} from "./helpers";

const adminApiKey = process.env.E2E_ADMIN_KEY ?? process.env.ADMIN_BOOTSTRAP_KEY;

// Helpers
async function createGroup(apiKey: string, name: string, opts: Record<string, unknown> = {}) {
  return jsonRequest("/groups", { method: "POST", apiKey, json: { name, ...opts } });
}
async function addMember(apiKey: string, groupId: string, actorId: string) {
  return jsonRequest(`/groups/${groupId}/members`, { method: "POST", apiKey, json: { actor_id: actorId } });
}
async function removeMember(apiKey: string, groupId: string, actorId: string) {
  return apiRequest(`/groups/${groupId}/members/${actorId}`, { method: "DELETE", apiKey });
}
async function createPermissionRule(apiKey: string, opts: Record<string, unknown>) {
  return jsonRequest("/permission-rules", { method: "POST", apiKey, json: opts });
}
async function deletePermissionRule(apiKey: string, ruleId: string) {
  return apiRequest(`/permission-rules/${ruleId}`, { method: "DELETE", apiKey });
}
async function createInvitation(apiKey: string, opts: Record<string, unknown> = {}) {
  return jsonRequest("/invitations", { method: "POST", apiKey, json: opts });
}
async function updateNetwork(apiKey: string, opts: Record<string, unknown>) {
  return jsonRequest("/network", { method: "PUT", apiKey, json: opts });
}
async function getMyGroups(apiKey: string) {
  return apiRequest("/auth/me/groups", { apiKey });
}

describe("permission security", () => {
  // Skip all if no admin key
  const runAdmin = Boolean(adminApiKey);

  // =========================================================================
  // 1. Self-escalation: non-admin tries to add themselves to a group
  // =========================================================================
  test.skipIf(!runAdmin)("non-admin cannot add themselves to a group", async () => {
    const attacker = await registerAgent();
    const { body: gBody } = await createGroup(adminApiKey!, uniqueName("sec-self-esc"));
    const groupId = (gBody as any).group.id;

    // Attacker tries to add themselves
    const { response } = await addMember(attacker.apiKey, groupId, attacker.entityId);
    expect(response.status).toBe(403);
  });

  // =========================================================================
  // 2. Non-admin tries to add another user to a group
  // =========================================================================
  test.skipIf(!runAdmin)("non-admin cannot add other actors to groups", async () => {
    const attacker = await registerAgent();
    const victim = await registerAgent();
    const { body: gBody } = await createGroup(adminApiKey!, uniqueName("sec-add-other"));
    const groupId = (gBody as any).group.id;

    const { response } = await addMember(attacker.apiKey, groupId, victim.entityId);
    expect(response.status).toBe(403);
  });

  // =========================================================================
  // 3. Cross-entity admin escalation: admin on entity A cannot grant on entity B
  // =========================================================================
  test.skipIf(!runAdmin)("admin on entity A cannot grant access on entity B", async () => {
    const ownerA = await registerAgent();
    const ownerB = await registerAgent();
    const attacker = await registerAgent();

    const commonsA = await createCommons(ownerA.apiKey, { label: uniqueName("sec-a") });
    const commonsB = await createCommons(ownerB.apiKey, { label: uniqueName("sec-b") });

    const entityA = await createEntity(ownerA.apiKey, commonsA.id, "note", { label: "a" });
    const entityB = await createEntity(ownerB.apiKey, commonsB.id, "note", { label: "b" }, { view_access: "private" });

    // Make attacker admin on entity A
    await createGrant(ownerA.apiKey, entityA.id, attacker.entityId, "admin");

    // Attacker tries to grant themselves view on entity B
    const { response } = await jsonRequest(`/entities/${entityB.id}/access/grants`, {
      method: "POST",
      apiKey: attacker.apiKey,
      json: { actor_id: attacker.entityId, access_type: "view" },
    });
    // Should be 403 (not admin on B) or 404 (can't see B)
    expect([403, 404]).toContain(response.status);

    // Verify attacker still cannot see entity B
    const { response: viewRes } = await apiRequest(`/entities/${entityB.id}`, {
      apiKey: attacker.apiKey,
    });
    expect(viewRes.status).toBe(403);
  });

  // =========================================================================
  // 4. Private entity leakage via broad permission rule
  // =========================================================================
  test.skipIf(!runAdmin)("broad permission rule does not expose private entities to non-members", async () => {
    const owner = await registerAgent();
    const outsider = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("sec-broad") });
    const privateEntity = await createEntity(
      owner.apiKey, commons.id, "secret-doc",
      { label: "classified" },
      { view_access: "private" },
    );

    // Create a group that outsider is NOT in
    const { body: gBody } = await createGroup(adminApiKey!, uniqueName("sec-inner-grp"));
    const groupId = (gBody as any).group.id;

    // Create a broad rule: all "secret-doc" entities visible to this group
    const { body: rBody } = await createPermissionRule(adminApiKey!, {
      match_type: "secret-doc",
      grant_group_id: groupId,
      grant_access: "view",
    });

    // Outsider is NOT in the group — should NOT see the entity
    const { response: viewRes } = await apiRequest(`/entities/${privateEntity.id}`, {
      apiKey: outsider.apiKey,
    });
    expect(viewRes.status).toBe(403);

    // Now add outsider to the group
    await addMember(adminApiKey!, groupId, outsider.entityId);

    // NOW they should see it
    const { response: viewRes2 } = await apiRequest(`/entities/${privateEntity.id}`, {
      apiKey: outsider.apiKey,
    });
    expect(viewRes2.status).toBe(200);

    // Cleanup
    await deletePermissionRule(adminApiKey!, (rBody as any).rule.id);
  });

  // =========================================================================
  // 5. Immediate access revocation on group removal
  // =========================================================================
  test.skipIf(!runAdmin)("removing actor from group immediately revokes access", async () => {
    const owner = await registerAgent();
    const viewer = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("sec-revoke") });
    const privateEntity = await createEntity(
      owner.apiKey, commons.id, "note",
      { label: "secret" },
      { view_access: "private" },
    );

    // Create group and rule
    const { body: gBody } = await createGroup(adminApiKey!, uniqueName("sec-revoke-grp"));
    const groupId = (gBody as any).group.id;
    await addMember(adminApiKey!, groupId, viewer.entityId);

    const { body: rBody } = await createPermissionRule(adminApiKey!, {
      match_type: "note",
      grant_group_id: groupId,
      grant_access: "view",
    });

    // Viewer CAN see it
    const { response: canSee } = await apiRequest(`/entities/${privateEntity.id}`, {
      apiKey: viewer.apiKey,
    });
    expect(canSee.status).toBe(200);

    // Remove viewer from group
    await removeMember(adminApiKey!, groupId, viewer.entityId);

    // Viewer should IMMEDIATELY lose access (next request)
    const { response: cantSee } = await apiRequest(`/entities/${privateEntity.id}`, {
      apiKey: viewer.apiKey,
    });
    expect(cantSee.status).toBe(403);

    // Cleanup
    await deletePermissionRule(adminApiKey!, (rBody as any).rule.id);
  });

  // =========================================================================
  // 6. Invitation code concurrent redemption (race condition)
  // =========================================================================
  test.skipIf(!runAdmin)("invitation code with max_uses=1 cannot be used twice concurrently", async () => {
    const { body: invBody } = await createInvitation(adminApiKey!, { max_uses: 1 });
    const code = (invBody as any).code;

    // Two concurrent registrations
    const kp1 = await generateSigningKeyPair();
    const kp2 = await generateSigningKeyPair();
    const sig1 = await signText(kp1.privateKey, code);
    const sig2 = await signText(kp2.privateKey, code);

    const [res1, res2] = await Promise.all([
      jsonRequest("/auth/register", {
        method: "POST",
        json: {
          public_key: kp1.publicKey,
          invitation_code: code,
          signature: sig1,
          name: uniqueName("race-1"),
        },
      }),
      jsonRequest("/auth/register", {
        method: "POST",
        json: {
          public_key: kp2.publicKey,
          invitation_code: code,
          signature: sig2,
          name: uniqueName("race-2"),
        },
      }),
    ]);

    const statuses = [res1.response.status, res2.response.status].sort();
    // Exactly one should succeed (201), one should fail (410 exhausted)
    expect(statuses).toEqual([201, 410]);
  });

  // =========================================================================
  // 7. Non-admin tries to create permission rules to grant themselves access
  // =========================================================================
  test.skipIf(!runAdmin)("non-admin cannot create permission rules", async () => {
    const attacker = await registerAgent();

    const { response } = await createPermissionRule(attacker.apiKey, {
      grant_access: "view",
    });
    expect(response.status).toBe(403);
  });

  // =========================================================================
  // 8. Non-admin tries to update network to open registration
  // =========================================================================
  test.skipIf(!runAdmin)("non-admin cannot change registration mode", async () => {
    const attacker = await registerAgent();

    const { response } = await updateNetwork(attacker.apiKey, {
      registration_mode: "open",
    });
    expect(response.status).toBe(403);
  });

  // =========================================================================
  // 9. Verify entity_access grant cannot escalate to admin via rule
  // =========================================================================
  test.skipIf(!runAdmin)("permission rules cannot grant admin access", async () => {
    // The DB constraint should prevent this, but test at API level
    const { response, body } = await createPermissionRule(adminApiKey!, {
      grant_access: "admin",
    });
    // Should be rejected (Zod validation or DB constraint)
    expect(response.status).toBe(400);
  });

  // =========================================================================
  // 10. Verify rule deletion cascades entity_access cleanup
  // =========================================================================
  test.skipIf(!runAdmin)("rule deletion removes all materialized grants immediately", async () => {
    const owner = await registerAgent();
    const viewer = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("sec-cascade") });
    const entity = await createEntity(
      owner.apiKey, commons.id, "note",
      { label: "test" },
      { view_access: "private" },
    );

    // Create group, add viewer, create rule
    const { body: gBody } = await createGroup(adminApiKey!, uniqueName("sec-cascade-grp"));
    const groupId = (gBody as any).group.id;
    await addMember(adminApiKey!, groupId, viewer.entityId);

    const { body: rBody } = await createPermissionRule(adminApiKey!, {
      match_type: "note",
      grant_group_id: groupId,
      grant_access: "view",
    });
    const ruleId = (rBody as any).rule.id;

    // Viewer can see
    const { response: canSee } = await apiRequest(`/entities/${entity.id}`, {
      apiKey: viewer.apiKey,
    });
    expect(canSee.status).toBe(200);

    // Delete the rule
    await deletePermissionRule(adminApiKey!, ruleId);

    // Viewer immediately loses access (CASCADE deleted entity_access rows)
    const { response: cantSee } = await apiRequest(`/entities/${entity.id}`, {
      apiKey: viewer.apiKey,
    });
    expect(cantSee.status).toBe(403);
  });

  // =========================================================================
  // 11. Group hierarchy inheritance: child group inherits parent permissions
  // =========================================================================
  test.skipIf(!runAdmin)("child group members can see entities granted to parent group", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("sec-hier") });
    const entity = await createEntity(
      owner.apiKey, commons.id, "report",
      { label: "classified" },
      { view_access: "private" },
    );

    // Create parent and child groups
    const { body: parentBody } = await createGroup(adminApiKey!, uniqueName("sec-parent"));
    const parentId = (parentBody as any).group.id;
    const { body: childBody } = await createGroup(adminApiKey!, uniqueName("sec-child"), {
      parent_group_id: parentId,
    });
    const childId = (childBody as any).group.id;

    // Add viewer to CHILD group only
    const viewer = await registerAgent();
    await addMember(adminApiKey!, childId, viewer.entityId);

    // Create rule granting view to PARENT group
    const { body: rBody } = await createPermissionRule(adminApiKey!, {
      match_type: "report",
      grant_group_id: parentId,
      grant_access: "view",
    });

    // Viewer (in child) should see entity because child inherits parent
    // The materializer expands parent → [parent, child] for entity_access rows
    const { response } = await apiRequest(`/entities/${entity.id}`, {
      apiKey: viewer.apiKey,
    });
    expect(response.status).toBe(200);

    // Create a non-member who should NOT see it
    const outsider = await registerAgent();
    const { response: outsiderRes } = await apiRequest(`/entities/${entity.id}`, {
      apiKey: outsider.apiKey,
    });
    expect(outsiderRes.status).toBe(403);

    // Cleanup
    await deletePermissionRule(adminApiKey!, (rBody as any).rule.id);
  });

  // =========================================================================
  // 12. Verify owner can still access entity even after all rules removed
  // =========================================================================
  test.skipIf(!runAdmin)("owner access is never affected by group/rule changes", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("sec-owner") });
    const entity = await createEntity(
      owner.apiKey, commons.id, "note",
      { label: "mine" },
      { view_access: "private" },
    );

    // Create and delete various rules — owner should always have access
    const { body: rBody } = await createPermissionRule(adminApiKey!, {
      match_type: "note",
      grant_access: "view",
    });
    const ruleId = (rBody as any).rule.id;

    // Owner can see
    const { response: r1 } = await apiRequest(`/entities/${entity.id}`, {
      apiKey: owner.apiKey,
    });
    expect(r1.status).toBe(200);

    // Delete rule
    await deletePermissionRule(adminApiKey!, ruleId);

    // Owner STILL can see
    const { response: r2 } = await apiRequest(`/entities/${entity.id}`, {
      apiKey: owner.apiKey,
    });
    expect(r2.status).toBe(200);
  });

  // =========================================================================
  // 13. Unauthenticated user cannot see private entities even with broad rules
  // =========================================================================
  test.skipIf(!runAdmin)("unauthenticated user cannot see private entities even with everyone rule", async () => {
    const owner = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("sec-unauth") });
    const entity = await createEntity(
      owner.apiKey, commons.id, "note",
      { label: "private" },
      { view_access: "private" },
    );

    // Create a rule granting view to everyone (NULL group = everyone)
    const { body: rBody } = await createPermissionRule(adminApiKey!, {
      match_type: "note",
      grant_access: "view",
    });

    // Unauthenticated request (no apiKey) should still not see private entity
    // because unauthenticated requests have empty actor_groups
    const { response } = await apiRequest(`/entities/${entity.id}`);
    // Should be 403 (entity exists but no access) or 200 if "everyone" includes unauthenticated
    // The "everyone" group is only added to authenticated actors, so this should be 403
    expect(response.status).toBe(403);

    // Cleanup
    await deletePermissionRule(adminApiKey!, (rBody as any).rule.id);
  });

  // =========================================================================
  // 14. Edit access via rule: non-owner can edit entity
  // =========================================================================
  test.skipIf(!runAdmin)("rule-based edit grants allow entity updates", async () => {
    const owner = await registerAgent();
    const editor = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("sec-edit") });
    const entity = await createEntity(
      owner.apiKey, commons.id, "note",
      { label: "editable" },
      { edit_access: "owner" }, // only owner can edit normally
    );

    // Create group, add editor
    const { body: gBody } = await createGroup(adminApiKey!, uniqueName("sec-edit-grp"));
    const groupId = (gBody as any).group.id;
    await addMember(adminApiKey!, groupId, editor.entityId);

    // Create rule granting edit to the group
    const { body: rBody } = await createPermissionRule(adminApiKey!, {
      match_type: "note",
      grant_group_id: groupId,
      grant_access: "edit",
    });

    // Editor should be able to update despite edit_access = "owner"
    // because rule-derived group edit grants bypass the collaborators gate
    const { response } = await jsonRequest(`/entities/${entity.id}`, {
      method: "PUT",
      apiKey: editor.apiKey,
      json: { ver: entity.ver, properties: { label: "edited by non-owner" } },
    });
    expect(response.status).toBe(200);

    // Verify the update took effect
    const { body: getBody } = await apiRequest(`/entities/${entity.id}`, {
      apiKey: owner.apiKey,
    });
    expect((getBody as any).entity.properties.label).toBe("edited by non-owner");

    // Cleanup
    await deletePermissionRule(adminApiKey!, (rBody as any).rule.id);
  });

  // =========================================================================
  // 15. Edit access without rule: viewer cannot edit if edit_access=owner
  // NOTE: This test depends on RLS enforcement. If the local DB role has
  // BYPASSRLS=true, the UPDATE will succeed regardless. This test passes
  // on Neon where the app_user role does NOT bypass RLS.
  // =========================================================================
  test.skipIf(!runAdmin)("manual group view grant does not imply edit access", async () => {
    const owner = await registerAgent();
    const viewer = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("sec-no-edit") });
    const entity = await createEntity(
      owner.apiKey, commons.id, "note",
      { label: "read-only" },
      { view_access: "private", edit_access: "owner" },
    );

    // Grant individual view access to viewer
    await createGrant(owner.apiKey, entity.id, viewer.entityId, "view");

    // Viewer can see it
    const { response: viewRes } = await apiRequest(`/entities/${entity.id}`, {
      apiKey: viewer.apiKey,
    });
    expect(viewRes.status).toBe(200);

    // Viewer cannot edit it (only has view grant, edit_access=owner)
    const { response: editRes } = await jsonRequest(`/entities/${entity.id}`, {
      method: "PUT",
      apiKey: viewer.apiKey,
      json: { ver: entity.ver, properties: { label: "hacked" } },
    });
    expect(editRes.status).toBe(403);

    // Verify content unchanged
    const { body: getBody } = await apiRequest(`/entities/${entity.id}`, {
      apiKey: owner.apiKey,
    });
    expect((getBody as any).entity.properties.label).toBe("read-only");
  });

  // =========================================================================
  // 16. Invitation bound to specific public key cannot be used by another key
  // =========================================================================
  test.skipIf(!runAdmin)("bound invitation cannot be redeemed by different key pair", async () => {
    const intended = await generateSigningKeyPair();
    const attacker = await generateSigningKeyPair();

    const { body: invBody } = await createInvitation(adminApiKey!, {
      bound_public_key: intended.publicKey,
    });
    const code = (invBody as any).code;

    // Attacker tries to register with the code
    const attackerSig = await signText(attacker.privateKey, code);
    const { response, body } = await jsonRequest("/auth/register", {
      method: "POST",
      json: {
        public_key: attacker.publicKey,
        invitation_code: code,
        signature: attackerSig,
        name: uniqueName("attacker"),
      },
    });
    expect(response.status).toBe(403);
    expect((body as any).error.code).toBe("forbidden");
  });

  // =========================================================================
  // 17. Expired invitation code is rejected
  // =========================================================================
  test.skipIf(!runAdmin)("expired invitation code is rejected", async () => {
    // Create invitation that expires in 1 second
    const { body: invBody } = await createInvitation(adminApiKey!, {
      expires_in: 1,
    });
    const code = (invBody as any).code;

    // Wait for it to expire
    await new Promise((r) => setTimeout(r, 2000));

    const kp = await generateSigningKeyPair();
    const sig = await signText(kp.privateKey, code);
    const { response } = await jsonRequest("/auth/register", {
      method: "POST",
      json: {
        public_key: kp.publicKey,
        invitation_code: code,
        signature: sig,
        name: uniqueName("expired-invite"),
      },
    });
    expect(response.status).toBe(410);
  });

  // =========================================================================
  // 18. Non-admin cannot delete other users' invitations
  // =========================================================================
  test.skipIf(!runAdmin)("non-creator non-admin cannot delete invitations", async () => {
    // Create invitation as admin
    const { body: invBody } = await createInvitation(adminApiKey!, {});
    const code = (invBody as any).code;

    // Non-admin tries to delete it
    const attacker = await registerAgent();
    const { response } = await apiRequest(`/invitations/${code}`, {
      method: "DELETE",
      apiKey: attacker.apiKey,
    });
    expect(response.status).toBe(403);
  });

  // =========================================================================
  // 19. Verify group deletion cascades properly
  // =========================================================================
  test.skipIf(!runAdmin)("deleting a group revokes all group-based entity access", async () => {
    const owner = await registerAgent();
    const viewer = await registerAgent();
    const commons = await createCommons(owner.apiKey, { label: uniqueName("sec-grp-del") });
    const entity = await createEntity(
      owner.apiKey, commons.id, "note",
      { label: "test" },
      { view_access: "private" },
    );

    // Setup: group + member + rule
    const { body: gBody } = await createGroup(adminApiKey!, uniqueName("sec-del-grp"));
    const groupId = (gBody as any).group.id;
    await addMember(adminApiKey!, groupId, viewer.entityId);

    const { body: rBody } = await createPermissionRule(adminApiKey!, {
      match_type: "note",
      grant_group_id: groupId,
      grant_access: "view",
    });

    // Viewer can see
    const { response: canSee } = await apiRequest(`/entities/${entity.id}`, {
      apiKey: viewer.apiKey,
    });
    expect(canSee.status).toBe(200);

    // Delete the group (CASCADE should remove memberships + entity_access + rule)
    await apiRequest(`/groups/${groupId}`, {
      method: "DELETE",
      apiKey: adminApiKey!,
    });

    // Viewer loses access
    const { response: cantSee } = await apiRequest(`/entities/${entity.id}`, {
      apiKey: viewer.apiKey,
    });
    expect(cantSee.status).toBe(403);
  });
});
