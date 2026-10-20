ALTER TABLE "comandas" ALTER COLUMN "cpf_hmac" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comandas" ALTER COLUMN "cpf_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comandas" ALTER COLUMN "cpf_last3" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "is_counter" boolean DEFAULT false NOT NULL;