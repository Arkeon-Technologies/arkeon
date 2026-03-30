-- =============================================================================
-- Actor Update Guard (BEFORE UPDATE trigger)
-- =============================================================================
--
-- RLS on actors allows self-updates (id = current_actor_id()), but it cannot
-- distinguish WHICH columns changed. The app layer restricts non-admins to
-- updating only `properties`, but a direct SQL client or a future route bug
-- could bypass that. This trigger is the database-level safety net.
--
-- Rules for non-admin self-updates:
--   - properties, updated_at     — freely changeable
--   - max_read_level             — can only lower (self-demotion)
--   - max_write_level            — can only lower (self-demotion)
--   - is_admin                   — immutable
--   - can_publish_public         — immutable
--   - status                     — immutable
--   - kind                       — immutable
--   - owner_id                   — immutable
--
-- System admins and admin-updating-another-actor are unrestricted.
--
-- =============================================================================


-- =============================================================================
-- TRIGGER FUNCTION: actor_update_guard()
-- =============================================================================

CREATE OR REPLACE FUNCTION actor_update_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Admins are unrestricted
  IF current_actor_is_admin() THEN
    RETURN NEW;
  END IF;

  -- Only restrict self-updates by non-admins
  IF NEW.id <> current_actor_id() THEN
    RETURN NEW;
  END IF;

  -- Privilege columns: can only lower, never raise
  IF NEW.max_read_level > OLD.max_read_level THEN
    RAISE EXCEPTION 'non-admin actors cannot escalate max_read_level';
  END IF;

  IF NEW.max_write_level > OLD.max_write_level THEN
    RAISE EXCEPTION 'non-admin actors cannot escalate max_write_level';
  END IF;

  -- Immutable columns: cannot change at all
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
    RAISE EXCEPTION 'non-admin actors cannot change is_admin';
  END IF;

  IF NEW.can_publish_public IS DISTINCT FROM OLD.can_publish_public THEN
    RAISE EXCEPTION 'non-admin actors cannot change can_publish_public';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'non-admin actors cannot change status';
  END IF;

  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'non-admin actors cannot change kind';
  END IF;

  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'non-admin actors cannot change owner_id';
  END IF;

  RETURN NEW;
END;
$$;


-- =============================================================================
-- TRIGGER: attach to actors table
-- =============================================================================

CREATE TRIGGER actor_update_guard
  BEFORE UPDATE ON actors
  FOR EACH ROW
  EXECUTE FUNCTION actor_update_guard();
