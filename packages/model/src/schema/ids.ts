import { z } from 'zod';
import { ELEMENT_ID_PATTERN, PERSISTENT_ID_PATTERN } from '../ids.js';

/** Identifiant d'élément : UUID v7, ou identifiant temporaire `tmp:n` (ChangeSet seulement). */
export const ElementIdSchema = z.string().regex(new RegExp(ELEMENT_ID_PATTERN));
export type ElementId = string;

/** Identifiant persistant (clé de `BusinessModel.elements`). */
export const PersistentElementIdSchema = z.string().regex(new RegExp(PERSISTENT_ID_PATTERN));

export const SourceIdSchema = z.string().regex(new RegExp(PERSISTENT_ID_PATTERN));
export type SourceId = string;

export const UserIdSchema = z.string().min(1);
export type UserId = string;

export const ISODateTimeSchema = z.iso.datetime({ offset: true });
export type ISODateTime = string;

export const DiagramIdSchema = z.string().regex(/^(?:L0|L1:.+|L2:.+|L3:.+)$/);
export type DiagramId = string;

export const CodeSchema = z.string().min(1);
export const LabelSchema = z.string().min(1);
