ALTER TABLE "comments" ADD COLUMN "submission_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "email_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_submission_id_validation_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."validation_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_submission_idx" ON "comments" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "notifications_email_idx" ON "notifications" USING btree ("created_at") WHERE "notifications"."email_pending";