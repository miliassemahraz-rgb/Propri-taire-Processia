CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid,
	"client_id" uuid NOT NULL,
	"pipeline" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_hash" text NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"status" text NOT NULL,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_estimate_eur" numeric(12, 6),
	"duration_ms" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"client_id" uuid NOT NULL,
	"provider" text DEFAULT 'fake' NOT NULL,
	"models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"api_key_enc" text,
	"capabilities" jsonb DEFAULT '{"text":true,"documents":false,"audio":false}'::jsonb NOT NULL,
	"data_policy_text" text,
	"policy_accepted_by" uuid,
	"policy_accepted_at" timestamp with time zone,
	"monthly_budget_eur" numeric(10, 2),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"job_id" text,
	"error" text,
	"result_version" integer,
	"started_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"purpose" text NOT NULL,
	"model_version" integer,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"actor_id" uuid,
	"mission_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_proposals" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid NOT NULL,
	"base_version" integer NOT NULL,
	"instruction" text NOT NULL,
	"change_set" jsonb NOT NULL,
	"explanation" text,
	"diff" jsonb,
	"warnings" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"ai_call_id" uuid,
	"applied_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"name" text NOT NULL,
	"default_retention_months" integer DEFAULT 24 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"model_version" integer,
	"parent_id" uuid,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dialogue_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid NOT NULL,
	"thread" text NOT NULL,
	"author_id" uuid,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"token_hash" text NOT NULL,
	"email" "citext" NOT NULL,
	"global_role" text NOT NULL,
	"mission_id" uuid,
	"mission_role" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mission_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mission_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"phase" text DEFAULT 'analysis' NOT NULL,
	"head_version" integer DEFAULT 0 NOT NULL,
	"retention_until" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_version_elements" (
	"mission_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"element_id" text NOT NULL,
	"change" text NOT NULL,
	CONSTRAINT "model_version_elements_mission_id_version_element_id_pk" PRIMARY KEY("mission_id","version","element_id")
);
--> statement-breakpoint
CREATE TABLE "model_versions" (
	"mission_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"parent_version" integer,
	"snapshot" jsonb NOT NULL,
	"change_set" jsonb,
	"diff" jsonb,
	"cause" text NOT NULL,
	"summary" text,
	"author_id" uuid,
	"ai_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_versions_mission_id_version_pk" PRIMARY KEY("mission_id","version")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"user_id" uuid NOT NULL,
	"mission_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "optimisation_decisions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"optimisation_id" text NOT NULL,
	"value" text NOT NULL,
	"cause" text DEFAULT 'direct' NOT NULL,
	"cascade_from" text,
	"comment" text,
	"by" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "post_validation_notices" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"element_id" text NOT NULL,
	"version" integer NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid NOT NULL,
	"concept" text NOT NULL,
	"text" text NOT NULL,
	"rationale" text,
	"blocking_score" numeric(6, 3),
	"target_element_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"answer_source_id" uuid,
	"answered_by" uuid,
	"rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"id_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"mfa_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "sessions_id_hash_unique" UNIQUE("id_hash")
);
--> statement-breakpoint
CREATE TABLE "source_chunks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"locator" jsonb,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('french', text)) STORED
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"storage_key" text,
	"mime" text,
	"sha256" text,
	"size_bytes" bigint,
	"text_status" text DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"email" "citext" NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"global_role" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"totp_secret_enc" text,
	"totp_enabled_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "validation_submissions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"mission_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"model_version" integer NOT NULL,
	"artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_hypothesis_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "yjs_documents" (
	"name" text PRIMARY KEY NOT NULL,
	"mission_id" uuid NOT NULL,
	"state" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_policy_accepted_by_users_id_fk" FOREIGN KEY ("policy_accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "change_proposals_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "change_proposals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "change_proposals_ai_call_id_ai_calls_id_fk" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialogue_messages" ADD CONSTRAINT "dialogue_messages_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialogue_messages" ADD CONSTRAINT "dialogue_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialogue_messages" ADD CONSTRAINT "dialogue_messages_proposal_id_change_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."change_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_members" ADD CONSTRAINT "mission_members_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_members" ADD CONSTRAINT "mission_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_version_elements" ADD CONSTRAINT "model_version_elements_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_version_elements" ADD CONSTRAINT "model_version_elements_mission_id_version_model_versions_mission_id_version_fk" FOREIGN KEY ("mission_id","version") REFERENCES "public"."model_versions"("mission_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_ai_call_id_ai_calls_id_fk" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimisation_decisions" ADD CONSTRAINT "optimisation_decisions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimisation_decisions" ADD CONSTRAINT "optimisation_decisions_submission_id_validation_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."validation_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimisation_decisions" ADD CONSTRAINT "optimisation_decisions_by_users_id_fk" FOREIGN KEY ("by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_validation_notices" ADD CONSTRAINT "post_validation_notices_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_validation_notices" ADD CONSTRAINT "post_validation_notices_submission_id_validation_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."validation_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_answer_source_id_sources_id_fk" FOREIGN KEY ("answer_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_submissions" ADD CONSTRAINT "validation_submissions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_submissions" ADD CONSTRAINT "validation_submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_submissions" ADD CONSTRAINT "validation_submissions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yjs_documents" ADD CONSTRAINT "yjs_documents_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_mission_idx" ON "ai_calls" USING btree ("mission_id","created_at");--> statement-breakpoint
CREATE INDEX "analysis_runs_mission_idx" ON "analysis_runs" USING btree ("mission_id","created_at");--> statement-breakpoint
CREATE INDEX "artifacts_mission_idx" ON "artifacts" USING btree ("mission_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_mission_idx" ON "audit_log" USING btree ("mission_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_subject_uq" ON "auth_identities" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX "change_proposals_mission_idx" ON "change_proposals" USING btree ("mission_id","status");--> statement-breakpoint
CREATE INDEX "comments_target_idx" ON "comments" USING btree ("mission_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX "dialogue_messages_thread_idx" ON "dialogue_messages" USING btree ("mission_id","thread","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_members_mission_user_uq" ON "mission_members" USING btree ("mission_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_members_one_validator_uq" ON "mission_members" USING btree ("mission_id") WHERE "mission_members"."mission_role" = 'validator';--> statement-breakpoint
CREATE INDEX "mission_members_user_idx" ON "mission_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "missions_client_idx" ON "missions" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "model_version_elements_element_idx" ON "model_version_elements" USING btree ("mission_id","element_id","version");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "optimisation_decisions_submission_idx" ON "optimisation_decisions" USING btree ("submission_id","optimisation_id");--> statement-breakpoint
CREATE INDEX "post_validation_notices_mission_idx" ON "post_validation_notices" USING btree ("mission_id","seen_at");--> statement-breakpoint
CREATE INDEX "questions_mission_idx" ON "questions" USING btree ("mission_id","status","rank");--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_chunks_source_ordinal_uq" ON "source_chunks" USING btree ("source_id","ordinal");--> statement-breakpoint
CREATE INDEX "source_chunks_tsv_idx" ON "source_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "sources_mission_idx" ON "sources" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "validation_submissions_round_uq" ON "validation_submissions" USING btree ("mission_id","kind","round");