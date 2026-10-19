ALTER TABLE "print_jobs" ADD COLUMN "reprint_of" uuid;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "next_attempt_at" timestamp with time zone;