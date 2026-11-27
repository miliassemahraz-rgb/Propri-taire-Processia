import JSZip from 'jszip';

/**
 * Réécrit une archive OOXML (Word, Excel) avec une date fixe pour chaque entrée et l'ordre
 * d'origine : deux exports d'un même modèle donnent alors les mêmes octets, donc la même
 * empreinte sha256. Les dates de création et de modification propres au document sont fixées
 * en amont par les générateurs (`created`, `modified`).
 */
export async function normalizeZip(bytes: Uint8Array, date: Date): Promise<Uint8Array> {
  const source = await JSZip.loadAsync(bytes);
  const target = new JSZip();
  const names = Object.keys(source.files).sort();
  // `[Content_Types].xml` d'abord, comme l'attendent les lecteurs stricts.
  names.sort((a, b) => Number(b === '[Content_Types].xml') - Number(a === '[Content_Types].xml'));
  for (const name of names) {
    const entry = source.files[name];
    if (entry === undefined) continue;
    // Les entrées de dossier (inutiles en OOXML) porteraient la date du jour.
    if (entry.dir) continue;
    let content = await entry.async('uint8array');
    if (name === 'docProps/core.xml') {
      const stamp = `${date.toISOString().slice(0, 19)}Z`;
      const xml = Buffer.from(content)
        .toString('utf8')
        .replace(/(<dcterms:(created|modified)\b[^>]*>)[^<]*(<\/dcterms:\2>)/g, `$1${stamp}$3`);
      content = Buffer.from(xml, 'utf8');
    }
    target.file(name, content, { date, createFolders: false });
  }
  return target.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });
}
