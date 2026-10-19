CREATE TABLE "qr_unlock_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comanda_id" uuid NOT NULL,
	"ok" boolean NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comandas" ADD COLUMN "qr_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "qr_unlock_attempts" ADD CONSTRAINT "qr_unlock_attempts_comanda_id_comandas_id_fk" FOREIGN KEY ("comanda_id") REFERENCES "public"."comandas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qr_unlock_attempts_comanda_id_created_at_index" ON "qr_unlock_attempts" USING btree ("comanda_id","created_at");