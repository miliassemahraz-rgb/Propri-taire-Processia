'use client';

import type { ReactNode } from 'react';
import type { DocBlock, DocSection, DocTable, DossierDocument } from '@processia/contracts';
import { DataTable } from '@processia/ui';
import { deliverableAnchor } from '../../lib/deliverables';

/**
 * Tableau d'un livrable. La première colonne porte l'en-tête de chaque ligne (`<th scope="row">`)
 * et chaque colonne son en-tête (`<th scope="col">`) : la matrice RACI se lit au lecteur d'écran
 * (cellule, activité, acteur).
 */
function DeliverableTable({ table }: { table: DocTable }) {
  if (table.rows.length === 0) {
    return (
      <p className="muted" data-testid={`table-empty-${table.id}`}>
        {table.empty}
      </p>
    );
  }
  return (
    <div className="deliverable-table" data-testid={`table-${table.id}`}>
      <DataTable caption={table.caption}>
        <thead>
          <tr>
            {table.columns.map((column, index) => (
              <th key={index} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {table.columns.map((_, index) =>
                table.rowHeader && index === 0 ? (
                  <th key={index} scope="row">
                    {row[index] ?? ''}
                  </th>
                ) : (
                  <td key={index}>{row[index] ?? ''}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </DataTable>
    </div>
  );
}

function Block({ block, headingId }: { block: DocBlock; headingId: string }) {
  if (block.type === 'paragraph') return <p>{block.text}</p>;
  if (block.type === 'note') return <p className="muted small">{block.text}</p>;
  return (
    <div className="stack-sm">
      <h3 id={headingId} className="h4">
        {block.table.caption}
      </h3>
      <DeliverableTable table={block.table} />
    </div>
  );
}

function Section({
  section,
  extra,
}: {
  section: DocSection;
  extra?: ((section: DocSection) => ReactNode) | undefined;
}) {
  const anchor = deliverableAnchor(section.id);
  return (
    <section
      id={anchor}
      aria-labelledby={`${anchor}-titre`}
      className="card stack"
      data-testid={`deliverable-${section.id}`}
    >
      <h2 id={`${anchor}-titre`} className="h3">
        {section.title}
      </h2>
      {section.blocks.map((block, index) => (
        <Block key={index} block={block} headingId={`${anchor}-t${index}`} />
      ))}
      {extra?.(section)}
    </section>
  );
}

/**
 * Aperçu HTML du dossier d'analyse : les quatre livrables, puis l'annexe des sources. `sectionExtra`
 * ajoute un contenu sous chaque section (le portail du validateur y place les commentaires).
 */
export function DocumentView({
  document,
  sectionExtra,
}: {
  document: DossierDocument;
  sectionExtra?: (section: DocSection) => ReactNode;
}) {
  return (
    <div className="stack-lg">
      {document.deliverables.map((section) => (
        <Section key={section.id} section={section} extra={sectionExtra} />
      ))}
      <Section section={document.annex} extra={sectionExtra} />
    </div>
  );
}
