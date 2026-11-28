import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AiError,
  buildEditChangeSet,
  buildEditInput,
  EditPlanError,
  modelEditPipeline,
  type EditPlan,
  type FakeScenario,
} from '@processia/ai';
import type {
  DialogueDto,
  DialogueMessageDto,
  ProposalDto,
  SendDialogueMessageRequest,
  SendDialogueResult,
} from '@processia/contracts';
import { changeProposals, dialogueMessages, type MissionTx } from '@processia/db';
import type { BusinessModel } from '@processia/model';
import { PILOT_EDIT_SCENARIOS } from '@processia/test-fixtures';
import { and, desc, eq } from 'drizzle-orm';
import { AiProviderRegistry } from '../ai/ai-provider.registry.js';
import { AiService } from '../ai/ai.service.js';
import { AuthError } from '../auth/errors.js';
import { CLOCK, type Clock } from '../auth/services.js';
import { ModelService } from '../model/model.service.js';
import { ProposalsService } from '../model/proposals.service.js';
import type { MissionContext } from '../policy/mission-context.js';

const THREAD = 'mapping';
/** Messages renvoyés par `GET dialogue` : les plus récents. */
const LIST_LIMIT = 100;
/** Échanges transmis à l'IA : seulement ceux qui précisent la consigne en cours. */
const HISTORY_LIMIT = 6;
const HISTORY_SCAN = 12;

type MessageRow = typeof dialogueMessages.$inferSelect;

const toDto = (row: MessageRow): DialogueMessageDto => ({
  id: row.id,
  role: row.role as DialogueMessageDto['role'],
  content: row.content,
  authorId: row.authorId,
  proposalId: row.proposalId,
  createdAt: row.createdAt.toISOString(),
});

interface Prepared {
  model: BusinessModel;
  history: { role: 'user' | 'assistant'; content: string }[];
}

/**
 * Modification par dialogue (WP-20, spécification 4.4 `model.edit`). Le consultant écrit une
 * consigne ; le pipeline la traduit en actions, que `buildEditChangeSet` rend en ChangeSet ;
 * le ChangeSet devient une proposition en aperçu (`change_proposals`). Rien n'est écrit dans le
 * modèle avant « Appliquer » (`ProposalsService.apply`). L'appel à l'IA se fait hors transaction
 * et dans la requête : le consultant attend la réponse du dialogue.
 */
@Injectable()
export class DialogueService implements OnModuleInit {
  private readonly logger = new Logger(DialogueService.name);

  constructor(
    @Inject(ModelService) private readonly models: ModelService,
    @Inject(ProposalsService) private readonly proposals: ProposalsService,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AiProviderRegistry) private readonly registry: AiProviderRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    for (const [pipeline, scenario] of Object.entries(PILOT_EDIT_SCENARIOS)) {
      this.registry.registerFakeScenario(pipeline, scenario as FakeScenario);
    }
  }

  // ------------------------------------------------------------------ lecture

  /** Fil du dialogue (messages les plus récents) et propositions qu'il référence. */
  async list(ctx: MissionContext): Promise<DialogueDto> {
    return ctx.run(async (tx) => {
      const rows = await tx
        .select()
        .from(dialogueMessages)
        .where(
          and(eq(dialogueMessages.missionId, ctx.missionId), eq(dialogueMessages.thread, THREAD)),
        )
        .orderBy(desc(dialogueMessages.createdAt), desc(dialogueMessages.id))
        .limit(LIST_LIMIT);
      const messages = rows.reverse().map(toDto);
      const ids = [
        ...new Set(messages.flatMap((m) => (m.proposalId === null ? [] : [m.proposalId]))),
      ];
      const proposals =
        ids.length === 0
          ? []
          : (await this.proposals.list(tx, ctx.missionId)).filter((p) => ids.includes(p.id));
      return { messages, proposals };
    });
  }

  // ------------------------------------------------------------------ consigne

  /** Une consigne du consultant : message, appel `model.edit`, proposition ou question. */
  async send(
    ctx: MissionContext,
    userId: string,
    request: SendDialogueMessageRequest,
  ): Promise<SendDialogueResult> {
    const prepared = await ctx.run(async (tx) => {
      const history = await this.history(tx, ctx.missionId, userId);
      const user = await this.insertMessage(tx, ctx.missionId, {
        role: 'user',
        content: request.text,
        authorId: userId,
      });
      const { model } = await this.models.getModel(tx, ctx.missionId);
      return { user, model, history };
    });
    const answer = await this.answer(ctx, userId, request.text, request.focus, prepared);
    return { messages: [prepared.user, answer.message], proposal: answer.proposal };
  }

  /**
   * « Régénérer » : relance le pipeline avec la consigne d'une proposition périmée, sur la version
   * actuelle. L'ancienne proposition reste `stale` ; la nouvelle est une proposition à part.
   */
  async regenerate(
    ctx: MissionContext,
    userId: string,
    proposalId: string,
    focus: SendDialogueMessageRequest['focus'],
  ): Promise<SendDialogueResult> {
    const prepared = await ctx.run(async (tx) => {
      const [row] = await tx
        .select()
        .from(changeProposals)
        .where(
          and(eq(changeProposals.missionId, ctx.missionId), eq(changeProposals.id, proposalId)),
        )
        .limit(1);
      if (row === undefined) throw new AuthError('NOT_FOUND');
      if (row.status !== 'stale') throw new AuthError('CONFLICT', { status: row.status });
      const { model } = await this.models.getModel(tx, ctx.missionId);
      return { instruction: row.instruction, model, history: [] as Prepared['history'] };
    });
    const answer = await this.answer(ctx, userId, prepared.instruction, focus, prepared);
    return { messages: [answer.message], proposal: answer.proposal };
  }

  // ------------------------------------------------------------------ interne

  /** Appel `model.edit` hors transaction, puis proposition et message de l'assistant. */
  private async answer(
    ctx: MissionContext,
    userId: string,
    instruction: string,
    focus: SendDialogueMessageRequest['focus'],
    prepared: Prepared,
  ): Promise<{ message: DialogueMessageDto; proposal: ProposalDto | null }> {
    const input = buildEditInput({
      model: prepared.model,
      instruction,
      history: prepared.history,
      ...(focus === undefined ? {} : { diagram: focus.diagram }),
      selectedId: focus?.selectedId ?? null,
    });
    let plan: EditPlan;
    let aiCallId: string | null;
    try {
      const run = await this.ai.run(modelEditPipeline, input, { missionId: ctx.missionId, userId });
      plan = run.output;
      aiCallId = run.callId;
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      this.logger.warn(`model.edit en échec : ${error.code}`);
      return this.say(
        ctx,
        userId,
        'system',
        `L’assistant n’a pas pu traiter la consigne (${error.code}). Réessayez dans un instant.`,
      );
    }

    if (plan.clarification !== undefined || plan.actions.length === 0) {
      return this.say(
        ctx,
        userId,
        'assistant',
        plan.clarification ?? 'Je n’ai trouvé aucune modification à proposer pour cette consigne.',
      );
    }

    return ctx.run(async (tx) => {
      // La tête a pu avancer pendant l'appel : le plan est traduit sur la version actuelle.
      const { model } = await this.models.getModel(tx, ctx.missionId);
      let built;
      try {
        built = buildEditChangeSet({
          model,
          plan,
          instruction,
          userId,
          aiCallId,
          at: this.clock.now().toISOString(),
        });
      } catch (error) {
        if (!(error instanceof EditPlanError)) throw error;
        const reason = error.issues.map((i) => i.message).join(' ');
        const message = await this.insertMessage(tx, ctx.missionId, {
          role: 'assistant',
          content: `Je ne peux pas traduire cette consigne en modification : ${reason}`,
          authorId: userId,
        });
        return { message, proposal: null };
      }
      const proposal = await this.proposals.create(tx, ctx.missionId, {
        baseVersion: model.version,
        instruction,
        changeSet: built.changeSet,
        explanation: plan.explanation,
        createdBy: userId,
        aiCallId,
      });
      const message = await this.insertMessage(tx, ctx.missionId, {
        role: 'assistant',
        content: plan.explanation,
        authorId: userId,
        proposalId: proposal.id,
      });
      return { message, proposal };
    });
  }

  private async say(
    ctx: MissionContext,
    userId: string,
    role: 'assistant' | 'system',
    content: string,
  ): Promise<{ message: DialogueMessageDto; proposal: null }> {
    const message = await ctx.run((tx) =>
      this.insertMessage(tx, ctx.missionId, { role, content, authorId: userId }),
    );
    return { message, proposal: null };
  }

  private async insertMessage(
    tx: MissionTx,
    missionId: string,
    value: {
      role: 'user' | 'assistant' | 'system';
      content: string;
      authorId: string;
      proposalId?: string;
    },
  ): Promise<DialogueMessageDto> {
    const [row] = await tx
      .insert(dialogueMessages)
      .values({
        missionId,
        thread: THREAD,
        authorId: value.authorId,
        role: value.role,
        content: value.content,
        proposalId: value.proposalId ?? null,
      })
      .returning();
    if (row === undefined) throw new Error('Insertion du message sans retour.');
    return toDto(row);
  }

  /**
   * Échanges qui précisent la consigne en cours : ceux du consultant (ses messages et les réponses
   * qui lui sont destinées), depuis la dernière proposition ou le dernier incident.
   */
  private async history(
    tx: MissionTx,
    missionId: string,
    userId: string,
  ): Promise<Prepared['history']> {
    const rows = await tx
      .select()
      .from(dialogueMessages)
      .where(
        and(
          eq(dialogueMessages.missionId, missionId),
          eq(dialogueMessages.thread, THREAD),
          eq(dialogueMessages.authorId, userId),
        ),
      )
      .orderBy(desc(dialogueMessages.createdAt), desc(dialogueMessages.id))
      .limit(HISTORY_SCAN);
    const kept: Prepared['history'] = [];
    for (const row of rows) {
      if (row.role === 'system' || row.proposalId !== null) break;
      kept.push({ role: row.role as 'user' | 'assistant', content: row.content });
      if (kept.length >= HISTORY_LIMIT) break;
    }
    return kept.reverse();
  }
}
