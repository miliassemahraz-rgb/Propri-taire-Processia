import type { DocBlock, DocSection, DocTable, DossierDocument } from '@processia/contracts';
import { renderToStaticMarkup } from 'react-dom/server';

const STYLE = `
  @page { size: A4 landscape; margin: 14mm 12mm 16mm 12mm; }
  * { box-sizing: border-box; }
  html { font-family: 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif; color: #1a1d23; }
  body { margin: 0; font-size: 10pt; line-height: 1.4; }
  h1 { font-size: 28pt; margin: 40mm 0 4mm; }
  .subtitle { font-size: 15pt; margin: 0 0 10mm; }
  h2 { font-size: 17pt; color: #1f3a8a; margin: 0 0 4mm; break-after: avoid; }
  h3 { font-size: 12pt; margin: 6mm 0 2mm; break-after: avoid; }
  dl.cover { display: grid; grid-template-columns: max-content 1fr; gap: 2mm 6mm; margin: 0 0 8mm; }
  dl.cover dt { font-weight: 700; }
  dl.cover dd { margin: 0; }
  p.notice, p.note, p.empty { font-style: italic; margin: 0 0 3mm; }
  section.deliverable { break-before: page; }
  table { width: 100%; border-collapse: collapse; table-layout: auto; font-size: 8pt; margin: 0 0 4mm; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th, td { border: 0.5pt solid #8a93a3; padding: 1.2mm 1.6mm; text-align: left; vertical-align: top;
    overflow-wrap: anywhere; white-space: pre-line; }
  thead th { background: #e4e9f4; }
  tbody th { background: #f4f6fa; font-weight: 700; }
`;

function Table({ table, id }: { table: DocTable; id: string }) {
  return (
    <>
      <h3 id={id}>{table.caption}</h3>
      {table.rows.length === 0 ? (
        <p className="empty">{table.empty}</p>
      ) : (
        <table aria-labelledby={id}>
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
        </table>
      )}
    </>
  );
}

function Block({ block, id }: { block: DocBlock; id: string }) {
  if (block.type === 'paragraph') return <p>{block.text}</p>;
  if (block.type === 'note') return <p className="note">{block.text}</p>;
  return <Table table={block.table} id={id} />;
}

function Section({ section }: { section: DocSection }) {
  return (
    <section className="deliverable" aria-labelledby={`h-${section.id}`}>
      <h2 id={`h-${section.id}`}>{section.title}</h2>
      {section.blocks.map((block, index) => (
        <Block key={index} block={block} id={`t-${section.id}-${index}`} />
      ))}
    </section>
  );
}

function Dossier({ doc }: { doc: DossierDocument }) {
  return (
    <html lang={doc.language}>
      <head>
        <meta charSet="utf-8" />
        <title>{`${doc.title} — ${doc.subtitle}`}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
        <header>
          <h1>{doc.title}</h1>
          <p className="subtitle">{doc.subtitle}</p>
          <dl className="cover">
            {doc.cover.map((entry) => (
              <div key={entry.label} style={{ display: 'contents' }}>
                <dt>{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
          {doc.notices.map((notice) => (
            <p key={notice} className="notice">
              {notice}
            </p>
          ))}
        </header>
        <main>
          {doc.deliverables.map((section) => (
            <Section key={section.id} section={section} />
          ))}
          <Section section={doc.annex} />
        </main>
      </body>
    </html>
  );
}

/**
 * Gabarit HTML du dossier d'analyse, rendu côté serveur avec React (spécification 6.4) puis
 * imprimé en PDF par Chromium. Titres h1 à h3 (signets), tableaux à en-têtes de colonnes et de
 * lignes (`<th scope>`), `lang="fr"` : le PDF balisé en hérite.
 */
export function renderDossierHtml(doc: DossierDocument): string {
  return `<!doctype html>${renderToStaticMarkup(<Dossier doc={doc} />)}`;
}
