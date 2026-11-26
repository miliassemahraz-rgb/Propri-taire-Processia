import { createHash } from 'node:crypto';
import type { StructuredRequest } from './types.js';

const norm = (s: string): string => s.normalize('NFC').replace(/\r\n?/g, '\n').trim();

type HashInput = Pick<
  StructuredRequest<unknown>,
  'pipeline' | 'system' | 'context' | 'messages' | 'schemaName' | 'attachments'
>;

/** Empreinte sha256 de la requête normalisée (prompt, messages, nom du schéma, pièces jointes). */
export function inputHash(req: HashInput): string {
  const payload = {
    pipeline: req.pipeline,
    system: norm(req.system),
    context: req.context === undefined ? null : norm(req.context),
    messages: req.messages.map((m) => ({ role: m.role, content: norm(m.content) })),
    schemaName: req.schemaName,
    attachments: (req.attachments ?? []).map((a) => ({
      kind: a.kind,
      mediaType: a.mediaType,
      name: a.name,
      sha256: createHash('sha256').update(a.data).digest('hex'),
    })),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
