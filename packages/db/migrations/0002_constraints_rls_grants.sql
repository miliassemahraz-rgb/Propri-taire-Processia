-- Contraintes CHECK des énumérations, cloisonnement par RLS et droits du rôle applicatif.
-- Exécuté par processia_owner ; processia_app (rôle non propriétaire) est créé par l'étape
-- d'amorçage de scripts/migrate.mjs avant les migrations.

-- ===== Contraintes CHECK =====
ALTER TABLE "users" ADD CONSTRAINT "users_global_role_chk" CHECK ("global_role" IN ('admin', 'mission_manager', 'consultant', 'client_validator'));
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_chk" CHECK ("status" IN ('invited', 'active', 'disabled'));
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_global_role_chk" CHECK ("global_role" IN ('admin', 'mission_manager', 'consultant', 'client_validator'));
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_mission_role_chk" CHECK ("mission_role" IS NULL OR "mission_role" IN ('manager', 'consultant', 'validator'));
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_phase_chk" CHECK ("phase" IN ('analysis', 'mapping', 'transformation', 'generation'));
--> statement-breakpoint
ALTER TABLE "mission_members" ADD CONSTRAINT "mission_members_role_chk" CHECK ("mission_role" IN ('manager', 'consultant', 'validator'));
--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_provider_chk" CHECK ("provider" IN ('fake', 'anthropic'));
--> statement-breakpoint
ALTER TABLE "model_version_elements" ADD CONSTRAINT "model_version_elements_change_chk" CHECK ("change" IN ('added', 'updated', 'removed', 'status'));
--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "change_proposals_status_chk" CHECK ("status" IN ('pending', 'applied', 'discarded', 'stale'));
--> statement-breakpoint
ALTER TABLE "dialogue_messages" ADD CONSTRAINT "dialogue_messages_thread_chk" CHECK ("thread" IN ('analysis', 'mapping', 'transformation'));
--> statement-breakpoint
ALTER TABLE "dialogue_messages" ADD CONSTRAINT "dialogue_messages_role_chk" CHECK ("role" IN ('user', 'assistant', 'system'));
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_kind_chk" CHECK ("kind" IN ('free_text', 'answer', 'document'));
--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_status_chk" CHECK ("status" IN ('open', 'answered', 'skipped'));
--> statement-breakpoint
ALTER TABLE "validation_submissions" ADD CONSTRAINT "validation_submissions_kind_chk" CHECK ("kind" IN ('analysis_dossier', 'as_is', 'to_be'));
--> statement-breakpoint
ALTER TABLE "validation_submissions" ADD CONSTRAINT "validation_submissions_status_chk" CHECK ("status" IN ('submitted', 'validated', 'superseded', 'withdrawn', 'closed'));
--> statement-breakpoint
ALTER TABLE "optimisation_decisions" ADD CONSTRAINT "optimisation_decisions_value_chk" CHECK ("value" IN ('accepted', 'rejected'));
--> statement-breakpoint
ALTER TABLE "optimisation_decisions" ADD CONSTRAINT "optimisation_decisions_cause_chk" CHECK ("cause" IN ('direct', 'cascade'));
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_target_kind_chk" CHECK ("target_kind" IN ('element', 'submission', 'optimisation', 'deliverable'));
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_kind_chk" CHECK ("kind" IN ('docx', 'pdf', 'xlsx', 'bpmn', 'zip', 'svg'));
--> statement-breakpoint

-- ===== Cloisonnement par mission (RLS) =====
-- Contexte de mission posé par withMission() : SET LOCAL app.mission_id = '<uuid>'.
-- Absent ou vide : NULL, donc aucune ligne n'est visible ni modifiable.
-- La politique ne dépend pas du rôle de l'utilisateur : qui peut ouvrir quelle mission (administrateur
-- et responsables : toutes ; consultant : ses affectations ; validateur : la sienne, [PO-22]) est décidé
-- par MissionGuard / @processia/policy AVANT l'appel de withMission().
CREATE FUNCTION app_mission_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.mission_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'model_versions', 'model_version_elements', 'change_proposals', 'dialogue_messages',
    'sources', 'source_chunks', 'analysis_runs', 'questions', 'validation_submissions',
    'optimisation_decisions', 'post_validation_notices', 'comments', 'artifacts', 'yjs_documents'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY mission_isolation ON %I USING (mission_id = app_mission_id()) WITH CHECK (mission_id = app_mission_id())',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
-- ai_calls : mission_id est facultatif (appel hors mission, par client). Ces lignes ne sont
-- accessibles que dans un contexte explicite `app.ai_unscoped = 'on'` (withoutMission avec
-- { aiUnscoped: true }) ; sans contexte, rien n'est visible.
ALTER TABLE "ai_calls" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_calls" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mission_isolation ON "ai_calls"
  USING (
    mission_id = app_mission_id()
    OR (mission_id IS NULL AND current_setting('app.ai_unscoped', true) = 'on')
  )
  WITH CHECK (
    mission_id = app_mission_id()
    OR (mission_id IS NULL AND current_setting('app.ai_unscoped', true) = 'on')
  );
--> statement-breakpoint

-- ===== Droits du rôle applicatif (non propriétaire, soumis à la RLS) =====
GRANT USAGE ON SCHEMA public TO processia_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO processia_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO processia_app;
--> statement-breakpoint
-- Journal d'audit : ajout seulement.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM processia_app;
