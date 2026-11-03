'use strict';
/* SYNAPSE — mesure de l'index vectoriel compact (5.0) sur une vraie base.

   La base est ouverte en LECTURE SEULE : rien n'est écrit. Les questions
   sont les vrais vecteurs de 20 entrées tirées au hasard ; pour chacune,
   les 10 plus proches (elle-même exclue) selon la recherche exhaustive et
   selon l'index compact. On mesure le temps de chacun et la part des 10
   premiers qui coïncident.

     DB_FILE=/data/synapse.db node --disable-warning=ExperimentalWarning outils/mesure-vecteurs.js [ns] [questions]
*/
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { blobToVec } = require('../src/db.js');
const VEC = require('../src/vecteurs.js');

const fichier = process.env.DB_FILE;
if (!fichier || !fs.existsSync(fichier)) { console.error('DB_FILE : base introuvable'); process.exit(2); }
const ns = process.argv[2] || 'shared', Q = Number(process.argv[3] || 20);
const db = new DatabaseSync(fichier, { readOnly: true });

const m0 = process.memoryUsage().rss;
let t = performance.now();
const idx = VEC.index(db, ns);
const construction = performance.now() - t;
if (!idx) { console.log('index désactivé : aucun morceau vectorisé, ou plus de', VEC.MAX_MORCEAUX, 'morceaux'); process.exit(1); }
console.log(`index : ${idx.n.toLocaleString('fr-FR')} morceaux · ${idx.dim} dimensions · construit en ${(construction / 1000).toFixed(1)} s · mémoire +${((process.memoryUsage().rss - m0) / 1048576).toFixed(0)} Mo`);

const exact = (qv, limit) => {
  const best = new Map();
  for (const r of db.prepare(`SELECT c.entry_id id, c.vec v FROM chunks c JOIN entries e ON e.id = c.entry_id
      WHERE c.embedded = 1 AND c.vec IS NOT NULL AND e.archived = 0 AND e.ns = ?`).iterate(ns)) {
    const v = blobToVec(r.v); if (v.length !== qv.length) continue;
    let d = 0; for (let k = 0; k < v.length; k++) d += v[k] * qv[k];
    const p = best.get(r.id); if (p === undefined || d > p) best.set(r.id, d);
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(x => x[0]);
};
const tirages = db.prepare(`SELECT c.entry_id id, c.vec v FROM chunks c JOIN entries e ON e.id = c.entry_id
  WHERE c.embedded = 1 AND c.vec IS NOT NULL AND e.archived = 0 AND e.ns = ? ORDER BY random() LIMIT ?`).all(ns, Q);
const tRapide = [], tExact = [];
let communs = 0, total = 0;
for (const r of tirages) {
  const qv = blobToVec(r.v);
  t = performance.now(); const a = VEC.proches(db, ns, qv, 11).map(h => h.id).filter(id => id !== r.id).slice(0, 10); tRapide.push(performance.now() - t);
  t = performance.now(); const b = exact(qv, 11).filter(id => id !== r.id).slice(0, 10); tExact.push(performance.now() - t);
  const s = new Set(b); for (const id of a) if (s.has(id)) communs++; total += b.length;
}
const med = l => l.slice().sort((x, y) => x - y)[Math.floor(l.length / 2)], max = l => Math.max(...l);
console.log(`recherche exhaustive : médiane ${med(tExact).toFixed(0)} ms · pire ${max(tExact).toFixed(0)} ms`);
console.log(`index compact        : médiane ${med(tRapide).toFixed(0)} ms · pire ${max(tRapide).toFixed(0)} ms`);
console.log(`qualité : ${(100 * communs / Math.max(1, total)).toFixed(1)} % des 10 premiers identiques à la recherche exhaustive (${tirages.length} questions)`);
