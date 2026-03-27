import { ApiError } from "./errors";

export type EntityView = "full" | "summary";

export interface Projection {
  view: EntityView;
  fields: string[] | null;
}

export function parseProjection(viewRaw: string | undefined, fieldsRaw: string | undefined): Projection {
  if (fieldsRaw) {
    const fields = fieldsRaw
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);

    if (!fields.length) {
      throw new ApiError(400, "invalid_query", "Invalid fields");
    }

    return {
      view: "full",
      fields,
    };
  }

  if (!viewRaw || viewRaw === "full") {
    return { view: "full", fields: null };
  }

  if (viewRaw === "summary") {
    return { view: "summary", fields: null };
  }

  throw new ApiError(400, "invalid_query", "Invalid view", {
    view: viewRaw,
  });
}

export function projectEntity<T extends Record<string, unknown>>(entity: T, projection: Projection) {
  const properties = (entity.properties ?? {}) as Record<string, unknown>;

  if (projection.fields) {
    const subset: Record<string, unknown> = {};
    for (const field of projection.fields) {
      if (Object.hasOwn(properties, field)) {
        subset[field] = properties[field];
      }
    }

    return {
      ...entity,
      properties: subset,
    };
  }

  if (projection.view === "summary") {
    return {
      id: entity.id,
      kind: entity.kind,
      type: entity.type,
      ver: entity.ver,
      owner_id: entity.owner_id,
      commons_id: entity.commons_id,
      properties: {
        label: properties.label,
      },
      updated_at: entity.updated_at,
    };
  }

  return entity;
}
