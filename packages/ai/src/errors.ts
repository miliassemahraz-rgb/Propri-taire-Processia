import type { Usage } from './types.js';

export type AiErrorCode =
  | 'REFUSAL'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_OUTPUT'
  | 'SEMANTIC_CHECK_FAILED'
  | 'MAX_TOKENS'
  | 'PROVIDER_ERROR'
  | 'CONFIG'
  | 'POLICY_NOT_ACCEPTED';

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Le modèle a refusé de répondre (`stop_reason === 'refusal'`). */
export class AiRefusalError extends AiError {
  constructor(message = 'Le fournisseur IA a refusé de répondre.') {
    super('REFUSAL', message);
  }
}

/** Plafond mensuel du client atteint : aucun appel n'est émis. */
export class AiBudgetExceeded extends AiError {
  constructor(
    readonly spentEur: number,
    readonly capEur: number,
  ) {
    super('BUDGET_EXCEEDED', `Budget IA mensuel atteint (${spentEur.toFixed(2)} / ${capEur} EUR).`);
  }
}

/** Sortie qui ne respecte pas le schéma (JSON invalide ou hors schéma). */
export class AiInvalidOutputError extends AiError {
  constructor(
    readonly issues: string[],
    readonly rawText: string,
    readonly usage?: Usage,
  ) {
    super('INVALID_OUTPUT', `Sortie IA hors schéma : ${issues.join(' ; ')}`);
  }
}

export interface SemanticIssue {
  path?: string;
  message: string;
}

/** Le contrôle sémantique échoue encore après la reprise de réparation. */
export class AiSemanticError extends AiError {
  constructor(readonly issues: SemanticIssue[]) {
    super(
      'SEMANTIC_CHECK_FAILED',
      `Contrôle sémantique en échec : ${issues.map((i) => i.message).join(' ; ')}`,
    );
  }
}

/** Plafond de sortie atteint, y compris après la reprise à plafond doublé. */
export class AiMaxTokensError extends AiError {
  constructor(
    readonly maxTokens: number,
    readonly usage?: Usage,
  ) {
    super('MAX_TOKENS', `Réponse tronquée au plafond de ${maxTokens} jetons.`);
  }
}

export type ProviderErrorKind =
  'rate_limit' | 'bad_request' | 'not_found' | 'auth' | 'server' | 'network';

export class AiProviderError extends AiError {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly status: number | null,
    message: string,
    options?: { cause?: unknown },
  ) {
    super('PROVIDER_ERROR', message, options);
  }
  /** 400, 404 et l'authentification ne se réessaient pas. */
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'server' || this.kind === 'network';
  }
}

export class AiConfigError extends AiError {
  constructor(code: 'CONFIG' | 'POLICY_NOT_ACCEPTED', message: string) {
    super(code, message);
  }
}
