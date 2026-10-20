CREATE TYPE "public"."fiscal_document_status" AS ENUM('AUTORIZADA', 'CANCELADA', 'REJEITADA', 'CONTINGENCIA');--> statement-breakpoint
CREATE TABLE "fiscal_config" (
	"key" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"csc_id" text,
	"csc_token_enc" text,
	"cert_pfx_enc" text,
	"cert_password_enc" text,
	"cert_subject" text,
	"cert_cnpj" text,
	"cert_valid_from" timestamp with time zone,
	"cert_valid_until" timestamp with time zone,
	"cert_uploaded_at" timestamp with time zone,
	"provider" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiscal_request_id" uuid,
	"model" integer DEFAULT 65 NOT NULL,
	"series" integer NOT NULL,
	"number" integer NOT NULL,
	"access_key" text NOT NULL,
	"environment" text NOT NULL,
	"status" "fiscal_document_status" NOT NULL,
	"total_cents" integer NOT NULL,
	"xml" text,
	"protocol" text,
	"issued_at" timestamp with time zone NOT NULL,
	"canceled_at" timestamp with time zone,
	"cancel_reason" text,
	"cancel_xml" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_documents_accessKey_unique" UNIQUE("access_key")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "cest" text;--> statement-breakpoint
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_fiscal_request_id_fiscal_requests_id_fk" FOREIGN KEY ("fiscal_request_id") REFERENCES "public"."fiscal_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fiscal_documents_issued_at_index" ON "fiscal_documents" USING btree ("issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_documents_series_number" ON "fiscal_documents" USING btree ("environment","series","number");