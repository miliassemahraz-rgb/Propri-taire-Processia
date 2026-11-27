import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController, InvitationsController, MeController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { DEFAULT_RATE_LIMIT, RATE_LIMIT_OPTIONS, RateLimitGuard, SessionGuard } from './guards.js';
import { InvitationsService } from './invitations.service.js';
import { PasswordService } from './passwords.js';
import { AuditService, CLOCK, MailService, systemClock, TotpService } from './services.js';
import { SessionsService } from './sessions.service.js';

/** Authentification : mots de passe, TOTP, codes de secours, sessions, CSRF, invitations (WP-05). */
@Module({
  controllers: [AuthController, MeController, InvitationsController],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    { provide: RATE_LIMIT_OPTIONS, useValue: DEFAULT_RATE_LIMIT },
    PasswordService,
    SessionsService,
    TotpService,
    AuditService,
    MailService,
    AuthService,
    InvitationsService,
    RateLimitGuard,
    // Garde globale : aucune route n'est accessible sans session à double authentification
    // vérifiée, sauf `@Public()` et `@SessionOnly()`.
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [SessionsService, AuditService, MailService, CLOCK],
})
export class AuthModule {}
