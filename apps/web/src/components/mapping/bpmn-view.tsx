'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '@processia/i18n';
import type { DiagramOutline } from '@processia/model';
import { Button, Notice } from '@processia/ui';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';
import type { NodeMarkers } from '../../lib/mapping';

/** Ce que la visionneuse utilise de bpmn-js (le paquet ne type pas `get`). */
interface Shape {
  id: string;
  di?: { $attrs?: Record<string, unknown> };
  /** Présent sur le libellé d'une forme : il partage le `di` de la forme, sans être la forme. */
  labelTarget?: unknown;
}
interface CanvasLike {
  zoom: (level?: number | 'fit-viewport', center?: 'auto') => number;
  viewbox: (box?: unknown) => unknown;
  addMarker: (element: string | Shape, marker: string) => void;
  removeMarker: (element: string | Shape, marker: string) => void;
  scrollToElement?: (element: string | Shape) => void;
}
interface RegistryLike {
  getAll: () => Shape[];
}
interface OverlaysLike {
  add: (element: string | Shape, type: string, overlay: unknown) => string;
  remove: (filter: { type: string }) => void;
}
interface EventBusLike {
  on: (event: string, listener: (event: { element: Shape }) => void) => void;
}
interface ViewerLike {
  importXML: (xml: string) => Promise<{ warnings: unknown[] }>;
  get: (name: string) => unknown;
  destroy: () => void;
}

const FIT = 'fit' as const;
const ELEMENT_ID_ATTR = 'processia:elementId';

function elementIdOf(shape: Shape): string | undefined {
  const value = shape.di?.$attrs?.[ELEMENT_ID_ATTR];
  return typeof value === 'string' ? value : undefined;
}

interface Props {
  missionId: string;
  diagram: string;
  title: string;
  outline: DiagramOutline;
  /** Version du modèle : un changement relit le BPMN (mise à jour en direct). */
  version: number;
  markers: Map<string, NodeMarkers>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (diagram: string) => void;
  onShowText: () => void;
}

/**
 * Vue BPMN complète (mode expert, spécification 6.3) : `bpmn-js` `NavigatedViewer`, en lecture
 * seule (le module de modélisation n'est pas chargé). Clic : sélectionner ; double-clic ou Entrée :
 * ouvrir le niveau inférieur. Le conteneur se parcourt au clavier (flèches, Début, Fin, Entrée) ;
 * l'alternative textuelle donne les mêmes étapes en texte. Les hypothèses ont un contour pointillé
 * et une mention, les constats une mention : jamais la couleur seule.
 */
export function BpmnView({
  missionId,
  diagram,
  title,
  outline,
  version,
  markers,
  selectedId,
  onSelect,
  onOpen,
  onShowText,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ViewerLike | null>(null);
  const [ready, setReady] = useState(false);
  const [xml, setXml] = useState<{ diagram: string; xml: string } | null>(null);
  const [imported, setImported] = useState<{ diagram: string; xml: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const importedDiagram = useRef<string | null>(null);
  const requestCounter = useRef(0);

  const latest = useRef({ outline, onSelect, onOpen });
  latest.current = { outline, onSelect, onOpen };

  // Création de la visionneuse (chargée à la demande : jamais côté serveur).
  useEffect(() => {
    let cancelled = false;
    let viewer: ViewerLike | null = null;
    void (async () => {
      const { default: NavigatedViewer } = await import('bpmn-js/lib/NavigatedViewer');
      if (cancelled || containerRef.current === null) return;
      viewer = new NavigatedViewer({ container: containerRef.current }) as unknown as ViewerLike;
      const bus = viewer.get('eventBus') as EventBusLike;
      const handle = (shape: Shape): string | undefined => {
        const id = elementIdOf(shape);
        return id !== undefined && latest.current.outline.nodes.some((n) => n.id === id)
          ? id
          : undefined;
      };
      bus.on('element.click', ({ element }) => {
        const id = handle(element);
        if (id !== undefined) latest.current.onSelect(id);
      });
      bus.on('element.dblclick', ({ element }) => {
        const id = handle(element);
        const drill = latest.current.outline.nodes.find((n) => n.id === id)?.drillTo;
        if (drill !== undefined) latest.current.onOpen(drill);
      });
      viewerRef.current = viewer;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      viewer?.destroy();
      viewerRef.current = null;
      setReady(false);
      setImported(null);
      importedDiagram.current = null;
    };
  }, []);

  // Lecture du BPMN : à l'ouverture d'un niveau et à chaque version du modèle.
  useEffect(() => {
    const current = ++requestCounter.current;
    setError(null);
    void endpoints
      .bpmnDiagram(missionId, diagram)
      .then((result) => {
        if (current !== requestCounter.current) return;
        setXml((previous) =>
          previous?.diagram === diagram && previous.xml === result.xml
            ? previous
            : { diagram, xml: result.xml },
        );
      })
      .catch((cause: unknown) => {
        if (current === requestCounter.current) setError(errorMessage(cause));
      });
  }, [missionId, diagram, version, attempt]);

  // Affichage : le cadrage est gardé quand le même niveau est relu après une modification.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || viewer === null || xml === null) return;
    let cancelled = false;
    void (async () => {
      const canvas = viewer.get('canvas') as CanvasLike;
      const sameDiagram = importedDiagram.current === xml.diagram;
      const box = sameDiagram ? canvas.viewbox() : null;
      try {
        await viewer.importXML(xml.xml);
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
        return;
      }
      if (cancelled) return;
      if (box !== null) canvas.viewbox(box);
      else canvas.zoom('fit-viewport', 'auto');
      importedDiagram.current = xml.diagram;
      setImported({ diagram: xml.diagram, xml: xml.xml });
      if (sameDiagram) setAnnouncement(t('cartography.viewer.bpmn.updated', { version }));
    })();
    return () => {
      cancelled = true;
    };
    // `version` ne sert qu'à l'annonce : le relevé du BPMN suit déjà ses changements.
  }, [ready, xml]);

  // Marqueurs et sélection, posés sur les formes qui portent `processia:elementId`.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!ready || viewer === null || imported === null) return;
    const canvas = viewer.get('canvas') as CanvasLike;
    const overlays = viewer.get('overlays') as OverlaysLike;
    const registry = viewer.get('elementRegistry') as RegistryLike;
    overlays.remove({ type: 'processia' });
    let selectedShape: Shape | undefined;
    for (const shape of registry.getAll()) {
      const id = elementIdOf(shape);
      if (id === undefined || shape.labelTarget !== undefined) continue;
      canvas.removeMarker(shape, 'processia-selected');
      canvas.removeMarker(shape, 'processia-hypothesis');
      const m = markers.get(id);
      if (m?.hypothesis) canvas.addMarker(shape, 'processia-hypothesis');
      if (m !== undefined && (m.hypothesis || m.findings > 0 || m.discrepancies > 0)) {
        const tags = document.createElement('div');
        tags.className = 'map-overlay-tags';
        const add = (kind: string, label: string): void => {
          const tag = document.createElement('span');
          tag.className = `map-tag map-tag--${kind}`;
          tag.textContent = label;
          tags.append(tag);
        };
        if (m.hypothesis) add('hypothesis', t('cartography.viewer.marker.hypothesis'));
        if (m.findings > 0) add('finding', t('cartography.viewer.marker.finding'));
        if (m.discrepancies > 0) add('discrepancy', t('cartography.viewer.marker.discrepancy'));
        overlays.add(shape, 'processia', { position: { top: -20, left: 0 }, html: tags });
      }
      if (id === selectedId) selectedShape = shape;
    }
    if (selectedShape !== undefined) canvas.addMarker(selectedShape, 'processia-selected');
  }, [ready, imported, markers, selectedId]);

  const move = useCallback(
    (delta: number | 'first' | 'last') => {
      const nodes = outline.nodes;
      if (nodes.length === 0) return;
      const index = nodes.findIndex((n) => n.id === selectedId);
      const target =
        delta === 'first'
          ? 0
          : delta === 'last'
            ? nodes.length - 1
            : Math.min(
                nodes.length - 1,
                Math.max(0, (index === -1 ? (delta > 0 ? -1 : nodes.length) : index) + delta),
              );
      const node = nodes[target];
      if (node === undefined) return;
      onSelect(node.id);
      const viewer = viewerRef.current;
      if (viewer !== null) {
        const canvas = viewer.get('canvas') as CanvasLike;
        const shape = (viewer.get('elementRegistry') as RegistryLike)
          .getAll()
          .find((s) => s.labelTarget === undefined && elementIdOf(s) === node.id);
        if (shape !== undefined) canvas.scrollToElement?.(shape);
      }
    },
    [outline, selectedId, onSelect],
  );

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        move(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        move(-1);
        break;
      case 'Home':
        move('first');
        break;
      case 'End':
        move('last');
        break;
      case 'Enter': {
        const drill = outline.nodes.find((n) => n.id === selectedId)?.drillTo;
        if (drill === undefined) return;
        onOpen(drill);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  }

  function zoom(step: number | typeof FIT): void {
    const canvas = viewerRef.current?.get('canvas') as CanvasLike | undefined;
    if (canvas === undefined) return;
    if (step === FIT) canvas.zoom('fit-viewport', 'auto');
    else canvas.zoom(canvas.zoom() * step);
  }

  return (
    <div className="stack-sm" data-testid="bpmn-view">
      <div className="row">
        <Button variant="secondary" onPress={() => zoom(1.25)}>
          {t('cartography.viewer.bpmn.zoomIn')}
        </Button>
        <Button variant="secondary" onPress={() => zoom(0.8)}>
          {t('cartography.viewer.bpmn.zoomOut')}
        </Button>
        <Button variant="secondary" onPress={() => zoom(FIT)}>
          {t('cartography.viewer.bpmn.zoomFit')}
        </Button>
        <Button variant="quiet" onPress={onShowText}>
          {t('cartography.viewer.bpmn.textLink')}
        </Button>
      </div>
      <p className="muted small">{t('cartography.viewer.bpmn.help')}</p>
      {error !== null ? (
        <Notice tone="danger" role="alert">
          <p>{t('cartography.viewer.bpmn.error')}</p>
          <p className="small">{error}</p>
          <Button variant="secondary" onPress={() => setAttempt((n) => n + 1)}>
            {t('cartography.viewer.bpmn.retry')}
          </Button>
        </Notice>
      ) : null}
      {imported === null && error === null ? (
        <p role="status" className="muted">
          {t('cartography.viewer.bpmn.loading')}
        </p>
      ) : null}
      {/* Conteneur parcouru au clavier : les flèches choisissent l'étape (voir `onKeyDown`). */}
      {/* eslint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={containerRef}
        className="map-bpmn"
        role="group"
        tabIndex={0}
        aria-label={t('cartography.viewer.bpmn.region', { title })}
        onKeyDown={onKeyDown}
        data-testid="bpmn-canvas"
        data-diagram={imported?.diagram}
      />
      {/* eslint-enable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */}
      <p role="status" className="pr-visually-hidden" data-testid="bpmn-announcement">
        {announcement}
      </p>
    </div>
  );
}
