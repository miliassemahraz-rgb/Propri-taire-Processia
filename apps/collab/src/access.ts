import {
  COLLAB_TOKEN_AUDIENCE,
  COLLAB_TOKEN_ISSUER,
  parseDocName,
  type CollabDocKind,
} from '@processia/contracts';
import { missionMembers, missions, users, withoutMission, type Database } from '@processia/db';
import { can, canSeeMission, type GlobalRole, type MissionRole } from '@processia/policy';
import { and, eq } from 'drizzle-orm';
import { jwtVerify } from 'jose';

/** Refus d'accès : le message n'est jamais détaillé au client (aucune fuite d'existence). */
export class CollabDenied extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'CollabDenied';
  }
}

export interface CollabClaims {
  userId: string;
  missionId: string;
}

/** Vérifie signature, durée de vie, émetteur et destinataire du jeton (HS256 uniquement). */
export async function verifyCollabToken(token: string, secret: string): Promise<CollabClaims> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      issuer: COLLAB_TOKEN_ISSUER,
      audience: COLLAB_TOKEN_AUDIENCE,
    });
    const mid = payload['mid'];
    if (typeof payload.sub !== 'string' || typeof mid !== 'string') {
      throw new CollabDenied('invalid-token');
    }
    return { userId: payload.sub, missionId: mid.toLowerCase() };
  } catch (error) {
    if (error instanceof CollabDenied) throw error;
    throw new CollabDenied('invalid-token');
  }
}

export interface Access {
  userId: string;
  displayName: string;
  kind: CollabDocKind;
  missionId: string;
  readOnly: boolean;
}

/**
 * Autorisation d'une connexion à un document : jeton valide, document de la mission du jeton,
 * compte actif, mission visible et droit `mission.read_workspace` revérifiés **en base** (le rôle
 * a pu changer depuis la délivrance du jeton). Le validateur n'utilise pas Yjs (spécification 5.4).
 * Le document `model` est toujours en lecture seule ; `workspace` l'est sans le droit `model.edit`.
 */
export async function authorize(
  db: Database,
  secret: string,
  token: string,
  documentName: string,
): Promise<Access> {
  const doc = parseDocName(documentName);
  if (doc === null) throw new CollabDenied('unknown-document');
  const claims = await verifyCollabToken(token, secret);
  if (claims.missionId !== doc.missionId) throw new CollabDenied('wrong-mission');

  const found = await withoutMission(db, async (tx) => {
    const [user] = await tx
      .select({ displayName: users.displayName, role: users.globalRole, status: users.status })
      .from(users)
      .where(eq(users.id, claims.userId))
      .limit(1);
    if (user === undefined || user.status !== 'active') return null;
    const [mission] = await tx
      .select({ id: missions.id })
      .from(missions)
      .where(eq(missions.id, doc.missionId))
      .limit(1);
    if (mission === undefined) return null;
    const [member] = await tx
      .select({ role: missionMembers.missionRole })
      .from(missionMembers)
      .where(
        and(eq(missionMembers.missionId, doc.missionId), eq(missionMembers.userId, claims.userId)),
      )
      .limit(1);
    return { user, role: (member?.role ?? null) as MissionRole | null };
  });
  if (found === null) throw new CollabDenied('forbidden');

  const subject = { globalRole: found.user.role as GlobalRole, missionRole: found.role };
  if (!canSeeMission(subject) || !can(subject, 'mission.read_workspace')) {
    throw new CollabDenied('forbidden');
  }
  return {
    userId: claims.userId,
    displayName: found.user.displayName,
    kind: doc.kind,
    missionId: doc.missionId,
    readOnly: doc.kind === 'model' || !can(subject, 'model.edit'),
  };
}
