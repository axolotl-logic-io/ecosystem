CREATE TYPE "public"."coordination_event_kind" AS ENUM('acquired', 'released', 'saved', 'registered', 'done');--> statement-breakpoint
CREATE TYPE "public"."coordination_scope_kind" AS ENUM('issue', 'integration', 'model-session');--> statement-breakpoint
CREATE TABLE "coordination_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool_id" uuid NOT NULL,
	"kind" "coordination_scope_kind" NOT NULL,
	"source_issue_claim_id" integer,
	"instance_id" uuid NOT NULL,
	"lane" text NOT NULL,
	"issue_number" integer NOT NULL,
	"branch" text NOT NULL,
	"buddy_run_id" uuid,
	"task" text,
	"slot" integer NOT NULL,
	"declared_capacity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"released_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "coordination_claim_invocation" UNIQUE("pool_id","instance_id"),
	CONSTRAINT "coordination_claim_identity" CHECK ("coordination_claims"."issue_number" > 0 AND length("coordination_claims"."lane") > 0 AND length("coordination_claims"."branch") > 0),
	CONSTRAINT "coordination_claim_source_kind" CHECK (("coordination_claims"."kind" = 'issue' AND "coordination_claims"."source_issue_claim_id" IS NULL) OR ("coordination_claims"."kind" <> 'issue' AND "coordination_claims"."source_issue_claim_id" IS NOT NULL)),
	CONSTRAINT "coordination_claim_slot" CHECK ("coordination_claims"."slot" > 0 AND "coordination_claims"."slot" <= "coordination_claims"."declared_capacity" AND ("coordination_claims"."kind" = 'model-session' OR ("coordination_claims"."slot" = 1 AND "coordination_claims"."declared_capacity" = 1)))
);
--> statement-breakpoint
CREATE TABLE "coordination_consumers" (
	"id" serial PRIMARY KEY NOT NULL,
	"claim_id" integer NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "coordination_consumer_identity" UNIQUE("claim_id","kind","external_id"),
	CONSTRAINT "coordination_consumer_present" CHECK (length("coordination_consumers"."kind") > 0 AND length("coordination_consumers"."external_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "coordination_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"claim_id" integer NOT NULL,
	"kind" "coordination_event_kind" NOT NULL,
	"actor_instance_id" uuid NOT NULL,
	"buddy_run_id" uuid,
	"task" text,
	"consumer_id" integer,
	"reason" text NOT NULL,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "coordination_event_reason" CHECK (length("coordination_events"."reason") > 0),
	CONSTRAINT "coordination_event_consumer" CHECK (("coordination_events"."kind" IN ('registered', 'done')) = ("coordination_events"."consumer_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "coordination_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"kind" "coordination_scope_kind" NOT NULL,
	"issue_number" integer DEFAULT 0 NOT NULL,
	"capacity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "coordination_pool_scope" UNIQUE("repository_id","kind","issue_number"),
	CONSTRAINT "coordination_pool_kind" UNIQUE("id","kind"),
	CONSTRAINT "coordination_pool_issue" CHECK (("coordination_pools"."kind" = 'issue' AND "coordination_pools"."issue_number" > 0) OR ("coordination_pools"."kind" <> 'issue' AND "coordination_pools"."issue_number" = 0)),
	CONSTRAINT "coordination_pool_capacity" CHECK ("coordination_pools"."capacity" > 0 AND ("coordination_pools"."kind" = 'model-session' OR "coordination_pools"."capacity" = 1))
);
--> statement-breakpoint
CREATE TABLE "coordination_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository" text NOT NULL,
	"base_branch" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "coordination_repository_base" UNIQUE("repository","base_branch"),
	CONSTRAINT "coordination_repository_present" CHECK (length("coordination_repositories"."repository") > 0 AND length("coordination_repositories"."base_branch") > 0)
);
--> statement-breakpoint
ALTER TABLE "coordination_claims" ADD CONSTRAINT "coordination_claims_source_issue_claim_id_coordination_claims_id_fk" FOREIGN KEY ("source_issue_claim_id") REFERENCES "public"."coordination_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_claims" ADD CONSTRAINT "coordination_claim_pool" FOREIGN KEY ("pool_id","kind") REFERENCES "public"."coordination_pools"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_consumers" ADD CONSTRAINT "coordination_consumers_claim_id_coordination_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."coordination_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_events" ADD CONSTRAINT "coordination_events_claim_id_coordination_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."coordination_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_events" ADD CONSTRAINT "coordination_events_consumer_id_coordination_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."coordination_consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coordination_pools" ADD CONSTRAINT "coordination_pools_repository_id_coordination_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."coordination_repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coordination_one_slot_owner" ON "coordination_claims" USING btree ("pool_id","slot") WHERE "coordination_claims"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "coordination_claim_source" ON "coordination_claims" USING btree ("source_issue_claim_id");--> statement-breakpoint
CREATE INDEX "coordination_claim_buddy" ON "coordination_claims" USING btree ("buddy_run_id");--> statement-breakpoint
CREATE INDEX "coordination_claim_verification" ON "coordination_claims" USING btree ("last_verified_at") WHERE "coordination_claims"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "coordination_consumer_live" ON "coordination_consumers" USING btree ("claim_id") WHERE "coordination_consumers"."finished_at" IS NULL;--> statement-breakpoint
CREATE INDEX "coordination_event_claim" ON "coordination_events" USING btree ("claim_id","id");--> statement-breakpoint
CREATE INDEX "coordination_event_created" ON "coordination_events" USING btree ("created_at");