import { t } from '@processia/i18n';
import type { DiagramOutline, OutlineGroup, OutlineNode } from '@processia/model';

/** Libellés partagés par la vue simplifiée, l'alternative textuelle et le panneau (WP-19). */

export function kindLabel(node: Pick<OutlineNode, 'kind' | 'gatewayType'>): string {
  if (node.kind === 'decision' && node.gatewayType !== undefined) {
    return t(`cartography.viewer.gateway.${node.gatewayType}`);
  }
  return t(`cartography.viewer.kind.${node.kind}`);
}

/** Nature d'une étape avec son mode d'exécution ou son déclencheur : « Tâche · Automatique ». */
export function natureLabel(node: OutlineNode): string {
  const base = kindLabel(node);
  if (node.execution !== undefined) {
    return `${base} · ${t(`cartography.viewer.execution.${node.execution}`)}`;
  }
  if (node.trigger !== undefined && node.trigger !== 'none') {
    const trigger = t(`cartography.viewer.trigger.${node.trigger}`);
    return node.timer !== undefined ? `${base} · ${trigger} ${node.timer}` : `${base} · ${trigger}`;
  }
  return base;
}

export function groupLabel(group: OutlineGroup): string {
  if (group.kind === 'category') {
    return t(`cartography.viewer.simple.category.${group.label as 'steering'}`);
  }
  if (group.kind === 'unassigned') {
    return group.id === 'none'
      ? t('cartography.viewer.simple.category.none')
      : t('cartography.viewer.simple.unassigned');
  }
  return group.label;
}

export function groupName(outline: DiagramOutline, groupId: string | null): string {
  const group = outline.groups.find((g) => g.id === groupId);
  return group === undefined ? t('cartography.viewer.simple.unassigned') : groupLabel(group);
}
