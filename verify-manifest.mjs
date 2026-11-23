// Vérifie que chaque fichier publié correspond à l'empreinte SHA-256 inscrite dans MANIFEST.json.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const { fichiers } = JSON.parse(readFileSync(new URL('./MANIFEST.json', import.meta.url), 'utf8'));
let bad = 0;
for (const f of fichiers) {
  const got = createHash('sha256').update(readFileSync(new URL('./' + f.fichier, import.meta.url))).digest('hex');
  const ok = got === f.sha256;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'ÉCART'} ${f.nature.padEnd(14)} ${f.fichier}`);
}
process.exit(bad ? 1 : 0);
