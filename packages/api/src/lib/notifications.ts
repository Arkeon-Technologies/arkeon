import { createSql } from "./sql";

export interface NotificationActivity {
  entity_id: string;
  commons_id?: string | null;
  actor_id: string;
  action: string;
  detail?: Record<string, unknown>;
  ts?: string;
}

export async function fanOutNotifications(
  activity: NotificationActivity,
) {
  const sql = createSql();
  const ts = activity.ts ?? new Date().toISOString();
  const detail = activity.detail ?? {};

  const [, ownerRows, grantRows, targetOwnerRows, commonsOwnerRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', '', true)`,
    sql`SELECT owner_id FROM entities WHERE id = ${activity.entity_id} LIMIT 1`,
    sql`SELECT DISTINCT actor_id FROM entity_access WHERE entity_id = ${activity.entity_id}`,
    ["relationship_created", "relationship_removed", "relationship_updated"].includes(activity.action) &&
    typeof detail.target_id === "string"
      ? sql`SELECT owner_id FROM entities WHERE id = ${detail.target_id} LIMIT 1`
      : sql`SELECT NULL::text AS owner_id LIMIT 0`,
    activity.action === "entity_created" && activity.commons_id
      ? sql`SELECT owner_id FROM entities WHERE id = ${activity.commons_id} LIMIT 1`
      : sql`SELECT NULL::text AS owner_id LIMIT 0`,
  ]);

  const recipients = new Set<string>();
  const owner = (ownerRows as Array<{ owner_id: string }>)[0]?.owner_id;
  if (owner && owner !== activity.actor_id) {
    recipients.add(owner);
  }
  for (const row of grantRows as Array<{ actor_id: string }>) {
    if (row.actor_id !== activity.actor_id) {
      recipients.add(row.actor_id);
    }
  }
  for (const row of targetOwnerRows as Array<{ owner_id: string }>) {
    if (row.owner_id && row.owner_id !== activity.actor_id) {
      recipients.add(row.owner_id);
    }
  }
  for (const row of commonsOwnerRows as Array<{ owner_id: string }>) {
    if (row.owner_id && row.owner_id !== activity.actor_id) {
      recipients.add(row.owner_id);
    }
  }
  if (activity.action === "access_granted" && typeof detail.target_actor_id === "string") {
    if (detail.target_actor_id !== activity.actor_id) {
      recipients.add(detail.target_actor_id);
    }
  }

  const values = [...recipients];
  if (!values.length) {
    return;
  }

  await sql.transaction(
    values.map((recipientId) =>
      sql`
        INSERT INTO notifications (recipient_id, entity_id, actor_id, action, detail, ts)
        VALUES (
          ${recipientId},
          ${activity.entity_id},
          ${activity.actor_id},
          ${activity.action},
          ${JSON.stringify(detail)}::jsonb,
          ${ts}::timestamptz
        )
      `,
    ),
  );
}
