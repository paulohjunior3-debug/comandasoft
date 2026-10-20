-- Dia do movimento das aberturas já existentes: a data em que o caixa abriu (Brasília, UTC-3, como o sistema).
ALTER TABLE "cash_sessions" ADD COLUMN "business_date" date;--> statement-breakpoint
UPDATE "cash_sessions" SET "business_date" = (("opened_at" AT TIME ZONE 'UTC') - interval '3 hours')::date;--> statement-breakpoint
ALTER TABLE "cash_sessions" ALTER COLUMN "business_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "period" integer;
