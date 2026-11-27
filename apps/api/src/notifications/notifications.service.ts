import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Env } from '@processia/config/env';
import { NOTIFICATION_KINDS, type NotificationDto } from '@processia/contracts';
import {
  missions,
  notifications,
  users,
  withoutMission,
  type Database,
  type Json,
  type MissionTx,
  type PlainTx,
} from '@processia/db';
import { t } from '@processia/i18n';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { MailService } from '../auth/services.js';
import { DB } from '../db/db.module.js';
import { ENV } from '../env.js';

/** Intervalle de relève de la boîte d'envoi des courriels (le worker, PO-19 : envoi immédiat). */
export const EMAIL_POLL_INTERVAL_MS = 1000;
const BATCH = 20;
const EXCERPT_LENGTH = 200;

export interface NewNotification {
  userIds: string[];
  missionId: string;
  kind: string;
  payload: Json;
  /** Courriel immédiat en plus de la notification in-app (PO-19). */
  email: boolean;
}

/**
 * Notifications in-app et courriels (WP-16, PO-19). L'insertion se fait dans la transaction de
 * l'événement ; le courriel part du worker, après la validation de la transaction, depuis la
 * boîte d'envoi (`notifications.email_pending`) : jamais avant que l'événement existe en base.
 */
@Injectable()
export class NotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  /** Une notification par destinataire, dans la transaction de l'appelant. */
  async create(tx: MissionTx, input: NewNotification): Promise<void> {
    const recipients = [...new Set(input.userIds)];
    if (recipients.length === 0) return;
    await tx.insert(notifications).values(
      recipients.map((userId) => ({
        userId,
        missionId: input.missionId,
        kind: input.kind,
        payload: input.payload,
        emailPending: input.email,
      })),
    );
  }

  async list(userId: string): Promise<NotificationDto[]> {
    const rows = await withoutMission(this.db, (tx) =>
      tx
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(50),
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      missionId: row.missionId,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    }));
  }

  /** Marque lues les notifications indiquées (ou toutes) de l'utilisateur. */
  async markRead(userId: string, ids?: string[]): Promise<number> {
    const rows = await withoutMission(this.db, (tx) =>
      tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.userId, userId),
            isNull(notifications.readAt),
            ...(ids === undefined ? [] : [inArray(notifications.id, ids)]),
          ),
        )
        .returning({ id: notifications.id }),
    );
    return rows.length;
  }

  // ------------------------------------------------------------------ courriels

  /** Démarre la relève de la boîte d'envoi (processus worker seulement). */
  startDispatching(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.dispatchPending().catch((error: unknown) =>
        this.logger.error(`Envoi des courriels en échec : ${String(error)}`),
      );
    }, EMAIL_POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Envoie les courriels en attente (un seul passage à la fois). Un échec d'envoi est journalisé
   * et la ligne est abandonnée (pas de boucle de reprise infinie).
   */
  async dispatchPending(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let sent = 0;
      for (;;) {
        const done = await withoutMission(this.db, async (tx) => {
          const rows = await tx
            .select()
            .from(notifications)
            .where(eq(notifications.emailPending, true))
            .orderBy(asc(notifications.createdAt))
            .limit(BATCH)
            .for('update', { skipLocked: true });
          for (const row of rows) {
            let delivered = false;
            try {
              delivered = await this.sendEmail(tx, row);
            } catch (error) {
              this.logger.error(`Courriel ${row.kind} (${row.id}) non envoyé : ${String(error)}`);
            }
            await tx
              .update(notifications)
              .set({ emailPending: false, ...(delivered ? { emailedAt: new Date() } : {}) })
              .where(eq(notifications.id, row.id));
            if (delivered) sent += 1;
          }
          return rows.length;
        });
        if (done < BATCH) break;
      }
      return sent;
    } finally {
      this.running = false;
    }
  }

  private async sendEmail(tx: PlainTx, row: typeof notifications.$inferSelect): Promise<boolean> {
    const [user] = await tx
      .select({ email: users.email, status: users.status })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (user === undefined || user.status === 'disabled') return false;
    const [mission] =
      row.missionId === null
        ? []
        : await tx
            .select({ name: missions.name })
            .from(missions)
            .where(eq(missions.id, row.missionId))
            .limit(1);
    const message = this.compose(row, mission?.name ?? '');
    if (message === null) return false;
    await this.mail.send(user.email, message.subject, `${message.body}\n${t('email.footer')}\n`);
    return true;
  }

  /** Sujet et corps du courriel d'une notification ; `null` si le type n'a pas de courriel. */
  private compose(
    row: typeof notifications.$inferSelect,
    mission: string,
  ): { subject: string; body: string } | null {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const str = (key: string): string => String(payload[key] ?? '');
    const link = `${this.env.WEB_ORIGIN}/missions/${row.missionId ?? ''}/validation`;
    switch (row.kind) {
      case NOTIFICATION_KINDS.submitted:
        return {
          subject: t('email.submitted.subject', { kind: str('kindLabel'), mission }),
          body: t('email.submitted.body', {
            kind: str('kindLabel'),
            mission,
            version: str('version'),
            round: str('round'),
            link,
          }),
        };
      case NOTIFICATION_KINDS.validated:
        return {
          subject: t('email.validated.subject', { kind: str('kindLabel'), mission }),
          body: t('email.validated.body', {
            kind: str('kindLabel'),
            mission,
            version: str('version'),
            validator: str('validatorName'),
            link: `${this.env.WEB_ORIGIN}/missions/${row.missionId ?? ''}`,
          }),
        };
      case NOTIFICATION_KINDS.postValidation: {
        const summaries = Array.isArray(payload['summaries']) ? payload['summaries'] : [];
        return {
          subject: t('email.postValidation.subject', { mission, version: str('version') }),
          body: t('email.postValidation.body', {
            mission,
            version: str('version'),
            summaries: summaries.map((s) => `- ${String(s)}`).join('\n'),
            link,
          }),
        };
      }
      case NOTIFICATION_KINDS.comment:
        return {
          subject: t('email.comment.subject', { mission }),
          body: t('email.comment.body', {
            mission,
            author: str('authorName'),
            excerpt: str('excerpt').slice(0, EXCERPT_LENGTH),
            link,
          }),
        };
      default:
        return null;
    }
  }
}
