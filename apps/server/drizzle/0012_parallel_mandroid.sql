ALTER TYPE "public"."print_job_status" ADD VALUE 'PAINEL';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'COZINHA';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "takeaway" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "ready_by" uuid;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "uses_panel" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_ready_by_users_id_fk" FOREIGN KEY ("ready_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;