CREATE TYPE "public"."comanda_status" AS ENUM('ABERTA', 'EM_FECHAMENTO', 'FECHADA', 'CANCELADA');--> statement-breakpoint
CREATE TYPE "public"."order_item_status" AS ENUM('ATIVO', 'CANCELADO');--> statement-breakpoint
CREATE TYPE "public"."print_job_status" AS ENUM('PENDENTE', 'IMPRIMINDO', 'OK', 'ERRO');--> statement-breakpoint
CREATE TYPE "public"."print_job_type" AS ENUM('PRODUCAO', 'CANCELAMENTO', 'PRE_CONTA', 'CUPOM', 'DANFE', 'CAIXA', 'TESTE');--> statement-breakpoint
CREATE TABLE "comandas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "comandas_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"table_id" uuid NOT NULL,
	"customer_name" text NOT NULL,
	"cpf_hmac" text NOT NULL,
	"cpf_encrypted" text NOT NULL,
	"cpf_last3" text NOT NULL,
	"phone" text,
	"status" "comanda_status" DEFAULT 'ABERTA' NOT NULL,
	"client_uuid" uuid NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closing_requested_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"notes" text,
	"qr_locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comandas_number_unique" UNIQUE("number"),
	CONSTRAINT "comandas_clientUuid_unique" UNIQUE("client_uuid")
);
--> statement-breakpoint
CREATE TABLE "order_item_shares" (
	"order_item_id" uuid NOT NULL,
	"comanda_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	CONSTRAINT "order_item_shares_order_item_id_comanda_id_pk" PRIMARY KEY("order_item_id","comanda_id")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name_snapshot" text NOT NULL,
	"category_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"notes" text,
	"status" "order_item_status" DEFAULT 'ATIVO' NOT NULL,
	"canceled_by" uuid,
	"cancel_reason" text,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_qty_positive" CHECK ("order_items"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_uuid" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at_device" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_clientUuid_unique" UNIQUE("client_uuid")
);
--> statement-breakpoint
CREATE TABLE "print_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"printer_id" uuid NOT NULL,
	"type" "print_job_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "print_job_status" DEFAULT 'PENDENTE' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"reference_id" uuid,
	"printed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_uuid" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"visited_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_visits_clientUuid_unique" UNIQUE("client_uuid")
);
--> statement-breakpoint
ALTER TABLE "comandas" ADD CONSTRAINT "comandas_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comandas" ADD CONSTRAINT "comandas_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_shares" ADD CONSTRAINT "order_item_shares_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_shares" ADD CONSTRAINT "order_item_shares_comanda_id_comandas_id_fk" FOREIGN KEY ("comanda_id") REFERENCES "public"."comandas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_canceled_by_users_id_fk" FOREIGN KEY ("canceled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_visits" ADD CONSTRAINT "table_visits_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_visits" ADD CONSTRAINT "table_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comandas_table_id_index" ON "comandas" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "comandas_status_index" ON "comandas" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "comandas_open_cpf_unique" ON "comandas" USING btree ("cpf_hmac") WHERE status in ('ABERTA', 'EM_FECHAMENTO');--> statement-breakpoint
CREATE UNIQUE INDEX "comandas_open_name_per_table_unique" ON "comandas" USING btree ("table_id",lower("customer_name")) WHERE status in ('ABERTA', 'EM_FECHAMENTO');--> statement-breakpoint
CREATE INDEX "order_item_shares_comanda_id_index" ON "order_item_shares" USING btree ("comanda_id");--> statement-breakpoint
CREATE INDEX "order_items_order_id_index" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_table_id_received_at_index" ON "orders" USING btree ("table_id","received_at");--> statement-breakpoint
CREATE INDEX "print_jobs_status_created_at_index" ON "print_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "print_jobs_reference_id_index" ON "print_jobs" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "table_visits_table_id_visited_at_index" ON "table_visits" USING btree ("table_id","visited_at");