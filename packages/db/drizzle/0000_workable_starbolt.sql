CREATE TABLE "monitor_cursors" (
	"source" text PRIMARY KEY NOT NULL,
	"offset" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"repo" text,
	"parent" text,
	"source_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"session" text NOT NULL,
	"source" text NOT NULL,
	"position" bigint NOT NULL,
	"kind" text NOT NULL,
	"input" bigint,
	"output" bigint,
	"cache_read" bigint,
	"cache_write" bigint,
	"context" bigint,
	"context_window" integer,
	"compaction_target" integer,
	"compacted" boolean NOT NULL,
	"data" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "monitor_source_position" UNIQUE("source","position")
);
--> statement-breakpoint
CREATE INDEX "monitor_entity_scope" ON "monitor_entities" USING btree ("kind","repo");--> statement-breakpoint
CREATE INDEX "monitor_entity_parent" ON "monitor_entities" USING btree ("parent");--> statement-breakpoint
CREATE INDEX "monitor_event_session" ON "monitor_events" USING btree ("session","sequence");