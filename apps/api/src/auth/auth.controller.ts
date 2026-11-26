import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  acceptInvitationRequestSchema,
  createInvitationRequestSchema,
  loginRequestSchema,
  mfaConfirmRequestSchema,
  mfaVerifyRequestSchema,
  recoveryRequestSchema,
  SESSION_COOKIE,
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  type CreateInvitationResponse,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type MfaConfirmRequest,
  type MfaConfirmResponse,
  type MfaEnrollResponse,
  type MfaVerifyRequest,
  type RecoveryRequest,
  type RecoveryResponse,
  type SessionOpenedResponse,
} from '@processia/contracts';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { AuthError } from './errors.js';
import { RateLimitGuard } from './guards.js';
import {
  clearSessionCookie,
  CurrentAuth,
  originOf,
  Public,
  readCookie,
  SessionOnly,
  setSessionCookie,
  ZodPipe,
} from './http.js';
import { InvitationsService } from './invitations.service.js';
import { SessionsService, type AuthContext } from './sessions.service.js';

@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(loginRequestSchema)) body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    // Une session déjà portée par le navigateur est fermée : l'identifiant change à la connexion.
    const previous = readCookie(req, SESSION_COOKIE);
    const previousId =
      previous === undefined ? undefined : (await this.sessions.resolve(previous))?.sessionId;
    const { session, response } = await this.auth.login(
      body.email.toLowerCase(),
      body.password,
      originOf(req),
      previousId,
    );
    setSessionCookie(res, session.token, session.expiresAt);
    return response;
  }

  @SessionOnly()
  @Post('mfa/verify')
  @HttpCode(200)
  async verify(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(mfaVerifyRequestSchema)) body: MfaVerifyRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionOpenedResponse> {
    const result = await this.auth.verifyTotp(auth, body.code, originOf(req));
    setSessionCookie(res, result.session.token, result.session.expiresAt);
    return { csrfToken: result.csrfToken, user: result.user };
  }

  @SessionOnly()
  @Post('mfa/enroll')
  @HttpCode(200)
  async enroll(@CurrentAuth() auth: AuthContext): Promise<MfaEnrollResponse> {
    const { secret, uri, qr } = await this.auth.enroll(auth);
    return { otpauthUri: uri, qrCodeDataUrl: qr, manualEntryKey: secret };
  }

  @SessionOnly()
  @Post('mfa/confirm')
  @HttpCode(200)
  async confirm(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(mfaConfirmRequestSchema)) body: MfaConfirmRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MfaConfirmResponse> {
    const result = await this.auth.confirmEnrollment(auth, body.code, originOf(req));
    setSessionCookie(res, result.session.token, result.session.expiresAt);
    return { csrfToken: result.csrfToken, user: result.user, recoveryCodes: result.recoveryCodes };
  }

  @SessionOnly()
  @Post('recovery')
  @HttpCode(200)
  async recovery(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(recoveryRequestSchema)) body: RecoveryRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RecoveryResponse> {
    const result = await this.auth.useRecoveryCode(auth, body.code, originOf(req));
    setSessionCookie(res, result.session.token, result.session.expiresAt);
    return {
      csrfToken: result.csrfToken,
      user: result.user,
      remainingRecoveryCodes: result.remainingRecoveryCodes,
    };
  }

  @SessionOnly()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(auth, originOf(req));
    clearSessionCookie(res);
  }
}

@Controller()
export class MeController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @SessionOnly()
  @Get('me')
  me(@CurrentAuth() auth: AuthContext): MeResponse {
    return this.auth.me(auth);
  }
}

@Controller('invitations')
export class InvitationsController {
  constructor(@Inject(InvitationsService) private readonly invitations: InvitationsService) {}

  /** Envoie une invitation. Réservé à l'administrateur ; WP-06 le remplacera par `@Can('users.manage')`. */
  @Post()
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createInvitationRequestSchema)) body: CreateInvitationRequest,
    @Req() req: Request,
  ): Promise<CreateInvitationResponse> {
    if (auth.user.globalRole !== 'admin') throw new AuthError('FORBIDDEN');
    return this.invitations.create(body, auth.userId, originOf(req).ip);
  }

  @Public()
  @UseGuards(RateLimitGuard)
  @Post(':token/accept')
  @HttpCode(200)
  async accept(
    @Param('token') token: string,
    @Body(new ZodPipe(acceptInvitationRequestSchema)) body: AcceptInvitationRequest,
    @Req() req: Request,
  ): Promise<{ email: string }> {
    return this.invitations.accept(token, body, originOf(req).ip);
  }
}
