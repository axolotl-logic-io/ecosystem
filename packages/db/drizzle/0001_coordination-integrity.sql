CREATE FUNCTION coordination_guard_pool() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM coordination_repositories WHERE id = NEW.repository_id FOR UPDATE;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.repository_id, NEW.kind, NEW.issue_number, NEW.created_at)
      IS DISTINCT FROM (OLD.id, OLD.repository_id, OLD.kind, OLD.issue_number, OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_identity_immutable';
    END IF;
    IF NEW.capacity <> OLD.capacity AND EXISTS (
      SELECT 1 FROM coordination_claims WHERE pool_id = NEW.id AND released_at IS NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_capacity_live';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER coordination_pool_integrity BEFORE INSERT OR UPDATE ON coordination_pools
FOR EACH ROW EXECUTE FUNCTION coordination_guard_pool();
--> statement-breakpoint
CREATE FUNCTION coordination_guard_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target coordination_pools%ROWTYPE;
  source coordination_claims%ROWTYPE;
  source_repository uuid;
BEGIN
  SELECT * INTO STRICT target FROM coordination_pools WHERE id = NEW.pool_id;
  PERFORM 1 FROM coordination_repositories WHERE id = target.repository_id FOR UPDATE;
  SELECT * INTO STRICT target FROM coordination_pools WHERE id = NEW.pool_id;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.pool_id, NEW.kind, NEW.source_issue_claim_id, NEW.instance_id,
        NEW.lane, NEW.issue_number, NEW.branch, NEW.buddy_run_id, NEW.task,
        NEW.slot, NEW.declared_capacity, NEW.created_at)
      IS DISTINCT FROM
       (OLD.id, OLD.pool_id, OLD.kind, OLD.source_issue_claim_id, OLD.instance_id,
        OLD.lane, OLD.issue_number, OLD.branch, OLD.buddy_run_id, OLD.task,
        OLD.slot, OLD.declared_capacity, OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_identity_immutable';
    END IF;
    IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_release_immutable';
    END IF;
  ELSE
    IF NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_new_claim_released';
    END IF;
    IF NEW.declared_capacity <> target.capacity THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_capacity_mismatch';
    END IF;
  END IF;
  IF NEW.kind = 'issue' THEN
    IF NEW.issue_number <> target.issue_number THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_source_mismatch';
    END IF;
  ELSE
    SELECT * INTO source FROM coordination_claims WHERE id = NEW.source_issue_claim_id;
    SELECT repository_id INTO source_repository FROM coordination_pools WHERE id = source.pool_id;
    IF source.id IS NULL OR source.kind <> 'issue' OR source.released_at IS NOT NULL
      OR source_repository IS DISTINCT FROM target.repository_id
      OR (source.instance_id, source.lane, source.issue_number, source.branch)
        IS DISTINCT FROM (NEW.instance_id, NEW.lane, NEW.issue_number, NEW.branch) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_source_mismatch';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM coordination_consumers WHERE claim_id = NEW.id AND finished_at IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_consumers_live';
    END IF;
    IF EXISTS (SELECT 1 FROM coordination_claims WHERE source_issue_claim_id = NEW.id AND released_at IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_children_live';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER coordination_claim_integrity BEFORE INSERT OR UPDATE ON coordination_claims
FOR EACH ROW EXECUTE FUNCTION coordination_guard_claim();
--> statement-breakpoint
CREATE FUNCTION coordination_guard_consumer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  holder coordination_claims%ROWTYPE;
  repository_id uuid;
BEGIN
  SELECT * INTO STRICT holder FROM coordination_claims WHERE id = NEW.claim_id;
  SELECT p.repository_id INTO STRICT repository_id FROM coordination_pools p WHERE p.id = holder.pool_id;
  PERFORM 1 FROM coordination_repositories WHERE id = repository_id FOR UPDATE;
  -- Reread after taking the shared lock: a release may have committed first.
  SELECT * INTO STRICT holder FROM coordination_claims WHERE id = NEW.claim_id;
  IF holder.kind <> 'model-session' OR holder.released_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_consumer_not_owned';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.claim_id, NEW.kind, NEW.external_id, NEW.created_at)
      IS DISTINCT FROM (OLD.id, OLD.claim_id, OLD.kind, OLD.external_id, OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_identity_immutable';
    END IF;
    IF OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_completion_immutable';
    END IF;
  ELSIF NEW.finished_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_consumer_not_registered';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER coordination_consumer_integrity BEFORE INSERT OR UPDATE ON coordination_consumers
FOR EACH ROW EXECUTE FUNCTION coordination_guard_consumer();
--> statement-breakpoint
CREATE FUNCTION coordination_keep_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'coordination_history_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER coordination_claim_history BEFORE DELETE ON coordination_claims
FOR EACH ROW EXECUTE FUNCTION coordination_keep_history();
--> statement-breakpoint
CREATE TRIGGER coordination_consumer_history BEFORE DELETE ON coordination_consumers
FOR EACH ROW EXECUTE FUNCTION coordination_keep_history();
--> statement-breakpoint
CREATE TRIGGER coordination_event_history BEFORE UPDATE OR DELETE ON coordination_events
FOR EACH ROW EXECUTE FUNCTION coordination_keep_history();
--> statement-breakpoint
CREATE TRIGGER coordination_repository_history BEFORE UPDATE OR DELETE ON coordination_repositories
FOR EACH ROW EXECUTE FUNCTION coordination_keep_history();
--> statement-breakpoint
CREATE TRIGGER coordination_pool_history BEFORE DELETE ON coordination_pools
FOR EACH ROW EXECUTE FUNCTION coordination_keep_history();
