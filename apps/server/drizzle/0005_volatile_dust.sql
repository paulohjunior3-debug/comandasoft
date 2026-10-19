CREATE TYPE "public"."fiscal_mode" AS ENUM('PERGUNTAR', 'AUTOMATICO');--> statement-breakpoint
CREATE TABLE "cash_registers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"fiscal_mode" "fiscal_mode" DEFAULT 'PERGUNTAR' NOT NULL,
	"printer_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_registers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "fiscal_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cash_session_id" uuid NOT NULL,
	"comanda_ids" jsonb NOT NULL,
	"cpf_on_note" boolean DEFAULT true NOT NULL,
	"automatic" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'AGUARDANDO_MODULO_FISCAL' NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "cash_sessions_one_open";--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "register_id" uuid;--> statement-breakpoint
-- Ajuste manual: sessões de antes desta versão ficam no caixa padrão "Caixa 1".
INSERT INTO "cash_registers" ("name") SELECT 'Caixa 1' WHERE EXISTS (SELECT 1 FROM "cash_sessions") ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
UPDATE "cash_sessions" SET "register_id" = (SELECT "id" FROM "cash_registers" WHERE "name" = 'Caixa 1') WHERE "register_id" IS NULL;--> statement-breakpoint
ALTER TABLE "cash_sessions" ALTER COLUMN "register_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "expected_close_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "tables_in_service" integer;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "couvert_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "couvert_start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comandas" ADD COLUMN "people_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_requests" ADD CONSTRAINT "fiscal_requests_cash_session_id_cash_sessions_id_fk" FOREIGN KEY ("cash_session_id") REFERENCES "public"."cash_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_requests" ADD CONSTRAINT "fiscal_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_register_id_cash_registers_id_fk" FOREIGN KEY ("register_id") REFERENCES "public"."cash_registers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_sessions_one_open_per_register" ON "cash_sessions" USING btree ("register_id") WHERE "cash_sessions"."closed_at" is null;