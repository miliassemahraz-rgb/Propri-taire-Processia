import { modelVersions, withMission, yjsDocuments, type Database } from '@processia/db';
import type { BusinessModel, ModelDiff } from '@processia/model';
import { desc, eq } from 'drizzle-orm';
import type { VersionMeta } from './model-sync.js';

export interface HeadVersion {
  model: BusinessModel | null;
  diff: ModelDiff | null;
  meta: VersionMeta;
}

/** Tête de version de la mission (instantané et diff de `model_versions`) ; `null` sans version. */
export async function loadHead(db: Database, missionId: string): Promise<HeadVersion> {
  return withMission(db, missionId, async (tx) => {
    const [row] = await tx
      .select({
        snapshot: modelVersions.snapshot,
        diff: modelVersions.diff,
        authorId: modelVersions.authorId,
        createdAt: modelVersions.createdAt,
      })
      .from(modelVersions)
      .where(eq(modelVersions.missionId, missionId))
      .orderBy(desc(modelVersions.version))
      .limit(1);
    if (row === undefined) return { model: null, diff: null, meta: { authorId: null, at: null } };
    return {
      model: row.snapshot as unknown as BusinessModel,
      diff: row.diff as unknown as ModelDiff | null,
      meta: {
        authorId: row.authorId,
        at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      },
    };
  });
}

/** État binaire Yjs persisté d'un document (`yjs_documents`), ou `null`. */
export async function loadState(
  db: Database,
  missionId: string,
  name: string,
): Promise<Uint8Array | null> {
  return withMission(db, missionId, async (tx) => {
    const [row] = await tx
      .select({ state: yjsDocuments.state })
      .from(yjsDocuments)
      .where(eq(yjsDocuments.name, name))
      .limit(1);
    return row === undefined ? null : new Uint8Array(row.state);
  });
}

export async function saveState(
  db: Database,
  missionId: string,
  name: string,
  state: Uint8Array,
): Promise<void> {
  await withMission(db, missionId, async (tx) => {
    await tx
      .insert(yjsDocuments)
      .values({ name, missionId, state: Buffer.from(state) })
      .onConflictDoUpdate({
        target: yjsDocuments.name,
        set: { state: Buffer.from(state), updatedAt: new Date() },
      });
  });
}
