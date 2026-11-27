import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@processia/config/env';
import { auditLog, type Database, type Json } from '@processia/db';
import { t } from '@processia/i18n';
import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';
import nodemailer, { type Transporter } from 'nodemailer';
import QRCode from 'qrcode';
import { DB } from '../db/db.module.js';
import { ENV } from '../env.js';
import { decryptSecret, encryptSecret } from './crypto.js';

/** Horloge injectable : les tests la pilotent pour vérifier l'expiration des codes. */
export const CLOCK = Symbol('CLOCK');
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export const TOTP_PERIOD_SECONDS = 30;
const TOTP_ISSUER = 'Processia';

export interface AuditEvent {
  actorId?: string | null;
  action: string;
  target?: string | null;
  payload?: Json;
  ip?: string | null;
}

/** Journal d'audit : `audit_log` est en ajout seulement pour le rôle applicatif. */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async record(event: AuditEvent): Promise<void> {
    await this.db.insert(auditLog).values({
      actorId: event.actorId ?? null,
      action: event.action,
      target: event.target ?? null,
      payload: event.payload ?? {},
      ip: event.ip ?? null,
    });
  }
}

@Injectable()
export class MailService {
  private readonly transport: Transporter;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: false,
      ignoreTLS: true,
    });
  }

  /** Courriel texte brut (notifications, WP-16). */
  async send(to: string, subject: string, text: string): Promise<void> {
    await this.transport.sendMail({ from: this.env.SMTP_FROM, to, subject, text });
  }

  async sendInvitation(to: string, link: string, validityHours: number): Promise<void> {
    await this.transport.sendMail({
      from: this.env.SMTP_FROM,
      to,
      subject: t('email.invitation.subject'),
      text: t('email.invitation.body', { link, hours: validityHours }),
    });
  }
}

export interface TotpCheck {
  valid: boolean;
  /** Pas de temps du code accepté (pour l'anti-rejeu). */
  timeStep?: number;
}

@Injectable()
export class TotpService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  newSecret(): string {
    return generateSecret();
  }

  encrypt(secret: string): string {
    return encryptSecret(secret, this.env.SESSION_SECRET);
  }

  decrypt(stored: string): string {
    return decryptSecret(stored, this.env.SESSION_SECRET);
  }

  otpauthUri(secret: string, email: string): string {
    return generateURI({ issuer: TOTP_ISSUER, label: email, secret });
  }

  qrCodeDataUrl(uri: string): Promise<string> {
    return QRCode.toDataURL(uri, { margin: 1, width: 240 });
  }

  /** Accepte le pas courant et ses deux voisins (dérive d'horloge de ±30 s). */
  check(secret: string, code: string): TotpCheck {
    const epoch = Math.floor(this.clock.now().getTime() / 1000);
    const result = verifySync({
      secret,
      token: code,
      epoch,
      epochTolerance: TOTP_PERIOD_SECONDS,
    });
    return result.valid && 'timeStep' in result
      ? { valid: true, timeStep: result.timeStep }
      : { valid: false };
  }

  /** Code courant : réservé aux outils de développement et aux tests. */
  currentCode(secret: string): string {
    return generateSync({ secret, epoch: Math.floor(this.clock.now().getTime() / 1000) });
  }
}
