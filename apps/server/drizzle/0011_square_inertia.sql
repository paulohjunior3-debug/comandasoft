CREATE TABLE "couvert_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_date" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone,
	"started_by" uuid NOT NULL,
	"ended_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "couvert_windows_positive" CHECK ("couvert_windows"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "couvert_windows" ADD CONSTRAINT "couvert_windows_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "couvert_windows" ADD CONSTRAINT "couvert_windows_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "couvert_windows_business_date_index" ON "couvert_windows" USING btree ("business_date");--> statement-breakpoint
-- Couvert definido na abertura do caixa que ainda está aberto vira a primeira janela do dia.
INSERT INTO "couvert_windows" ("business_date", "amount_cents", "start_at", "started_by")
SELECT DISTINCT ON ("business_date") "business_date", "couvert_cents", "couvert_start_at", "opened_by"
FROM "cash_sessions"
WHERE "closed_at" IS NULL AND "couvert_cents" > 0 AND "couvert_start_at" IS NOT NULL
ORDER BY "business_date", "opened_at";
