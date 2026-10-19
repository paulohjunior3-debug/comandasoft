CREATE TYPE "public"."adjustment_type" AS ENUM('DESCONTO', 'TAXA_SERVICO_REMOVIDA', 'COUVERT_REMOVIDO');--> statement-breakpoint
CREATE TYPE "public"."cash_movement_type" AS ENUM('SANGRIA', 'SUPRIMENTO');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CREDITO', 'DEBITO', 'PIX', 'DINHEIRO');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('OK', 'ESTORNADO');--> statement-breakpoint
ALTER TYPE "public"."print_job_type" ADD VALUE 'GAVETA';--> statement-breakpoint
CREATE TABLE "adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comanda_id" uuid NOT NULL,
	"type" "adjustment_type" NOT NULL,
	"amount_cents" integer,
	"percent_bps" integer,
	"reason" text NOT NULL,
	"user_id" uuid NOT NULL,
	"authorized_by" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cash_session_id" uuid NOT NULL,
	"type" "cash_movement_type" NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movements_positive" CHECK ("cash_movements"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "cash_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_float_cents" integer NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"expected_json" jsonb,
	"counted_json" jsonb,
	"difference_cents" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_comandas" (
	"payment_id" uuid NOT NULL,
	"comanda_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	CONSTRAINT "payment_comandas_payment_id_comanda_id_pk" PRIMARY KEY("payment_id","comanda_id")
);
--> statement-breakpoint
CREATE TABLE "payment_items" (
	"payment_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"comanda_id" uuid NOT NULL,
	"fraction_num" integer NOT NULL,
	"fraction_den" integer NOT NULL,
	"item_amount_cents" integer NOT NULL,
	CONSTRAINT "payment_items_payment_id_order_item_id_comanda_id_pk" PRIMARY KEY("payment_id","order_item_id","comanda_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_uuid" uuid NOT NULL,
	"cash_session_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount_cents" integer NOT NULL,
	"tendered_cents" integer,
	"change_cents" integer DEFAULT 0 NOT NULL,
	"payer_name" text NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "payment_status" DEFAULT 'OK' NOT NULL,
	"refunded_by" uuid,
	"refund_reason" text,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_clientUuid_unique" UNIQUE("client_uuid"),
	CONSTRAINT "payments_positive" CHECK ("payments"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "comandas" ADD COLUMN "final_totals" jsonb;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_comanda_id_comandas_id_fk" FOREIGN KEY ("comanda_id") REFERENCES "public"."comandas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_cash_session_id_cash_sessions_id_fk" FOREIGN KEY ("cash_session_id") REFERENCES "public"."cash_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_comandas" ADD CONSTRAINT "payment_comandas_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_comandas" ADD CONSTRAINT "payment_comandas_comanda_id_comandas_id_fk" FOREIGN KEY ("comanda_id") REFERENCES "public"."comandas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_items" ADD CONSTRAINT "payment_items_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_items" ADD CONSTRAINT "payment_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_items" ADD CONSTRAINT "payment_items_comanda_id_comandas_id_fk" FOREIGN KEY ("comanda_id") REFERENCES "public"."comandas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_session_id_cash_sessions_id_fk" FOREIGN KEY ("cash_session_id") REFERENCES "public"."cash_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_refunded_by_users_id_fk" FOREIGN KEY ("refunded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adjustments_comanda_id_index" ON "adjustments" USING btree ("comanda_id");--> statement-breakpoint
CREATE INDEX "cash_movements_cash_session_id_index" ON "cash_movements" USING btree ("cash_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_sessions_one_open" ON "cash_sessions" USING btree ((1)) WHERE "cash_sessions"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "payment_comandas_comanda_id_index" ON "payment_comandas" USING btree ("comanda_id");--> statement-breakpoint
CREATE INDEX "payment_items_order_item_id_index" ON "payment_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "payments_cash_session_id_index" ON "payments" USING btree ("cash_session_id");