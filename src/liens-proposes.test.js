'use strict';
/* Les liens proposés : deux souvenirs de sources différentes, proches mais pas encore reliés. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const DB = require('./db.js');
const ingest = require('./ingest.js');
const VEC = require('./vecteurs.js');
const LP = require('./liens-proposes.js');
const APP = require('./apprentissage.js');

function base() {
  const db = DB.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lp-')), 'm.db'));
  LP.migrate(db);
  return db;
}
let n = 0;
function ecrire(db, source, titre, { cles = [], vec = null } = {}) {
  const r = ingest.insert(db, { kind: 'note', title: titre, body: titre + ' ' + (++n), ns: 'shared' }, source);
  assert.ok(r.ok, JSON.stringify(r));
  for (const c of cles) db.prepare(`INSERT OR IGNORE INTO h_cles(entry_id, cle) VALUES(?, ?)`).run(r.id, c);
  if (vec) db.prepare(`UPDATE chunks SET vec = ?, embedded = 1 WHERE entry_id = ?`).run(DB.vecToBlob(vec), r.id);
  return r.id;
}
const unite = v => { const m = Math.hypot(...v); return v.map(x => x / m); };

test('liens proposés : une même clé chez deux sources ; jamais chez la même, jamais une clé trop répandue', () => {
  const db = base();
  const a = ecrire(db, 'vigie', 'Menace sur 10.30.10.11', { cles: ['ip:10.30.10.11'] });
  const b = ecrire(db, 'hub', 'Le hub redémarre en boucle', { cles: ['ip:10.30.10.11'] });
  ecrire(db, 'vigie', 'Autre alerte sur 10.30.10.11', { cles: ['ip:10.30.10.11'] });
  for (let i = 0; i < 60; i++) ecrire(db, i % 2 ? 'mapmylan' : 'triage', 'port ouvert ' + i, { cles: ['port:443'] });
  LP.passe(db, { lot: 1000 });
  const p = LP.proposes(db, { limite: 100 });
  assert.ok(p.some(x => [x.a.id, x.b.id].sort().join() === [a, b].sort().join() && x.raison === 'cle' && x.detail === 'ip:10.30.10.11'), JSON.stringify(p.map(x => [x.a.source, x.b.source, x.detail])));
  assert.ok(p.every(x => x.a.source !== x.b.source), 'jamais entre deux entrées de la même source');
  assert.ok(!p.some(x => x.detail === 'port:443'), 'une clé portée par plus de 50 entrées est du bruit');
});

test('liens proposés : un sens très proche entre deux sources, pas un sens éloigné', () => {
  const db = base();
  const v = unite(Array.from({ length: 64 }, (_, i) => Math.sin(i)));
  const proche = unite(v.map((x, i) => x + (i % 7 === 0 ? 0.05 : 0)));
  const loin = unite(Array.from({ length: 64 }, (_, i) => Math.cos(i * 3)));
  const a = ecrire(db, 'vigie', 'Disque plein sur la VM hub', { vec: v });
  const b = ecrire(db, 'claude-code', 'Docker ne peut plus écrire : no space left', { vec: proche });
  ecrire(db, 'kimi', 'Recette de crêpes', { vec: loin });
  VEC.invalider();
  LP.passe(db, { lot: 1000 });
  const p = LP.proposes(db);
  assert.equal(p.length, 1, JSON.stringify(p));
  assert.equal(p[0].raison, 'sens');
  assert.deepEqual([p[0].a.id, p[0].b.id].sort(), [a, b].sort());
});

test('liens proposés : confirmer crée le vrai lien, refuser l’écarte ; rien n’est reproposé', () => {
  const db = base();
  const a = ecrire(db, 'vigie', 'Menace sur 10.30.10.20', { cles: ['ip:10.30.10.20'] });
  const b = ecrire(db, 'hub', 'Service tombé sur 10.30.10.20', { cles: ['ip:10.30.10.20'] });
  const c = ecrire(db, 'mapmylan', 'Nouvelle machine 10.30.10.20', { cles: ['ip:10.30.10.20'] });
  LP.passe(db, { lot: 1000 });
  const [p1, p2] = LP.proposes(db);
  assert.ok(LP.decider(db, p1.id, { accepter: true, relation: 'causes', par: 'qwen3' }).ok);
  assert.ok(db.prepare(`SELECT 1 FROM links WHERE relation = 'causes' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))`).get(p1.a.id, p1.b.id, p1.b.id, p1.a.id), 'le lien existe');
  assert.ok(LP.decider(db, p2.id, { accepter: false, par: 'owner' }).ok);
  assert.equal(LP.decider(db, p2.id, { accepter: true }).ok, false, 'une proposition tranchée ne se retranche pas');
  db.prepare(`DELETE FROM liens_proposes_curseur`).run();
  LP.passe(db, { lot: 1000 });
  assert.equal(LP.proposes(db).length, LP.proposes(db).filter(x => ![p1.id, p2.id].includes(x.id)).length);
  assert.ok(!LP.proposes(db).some(x => [x.a.id, x.b.id].sort().join() === [p1.a.id, p1.b.id].sort().join()), 'une paire reliée n’est pas reproposée');
  void a; void b; void c;
});

test('briefing : les souvenirs « peut-être liés » sont donnés avec leur numéro, pour que l’IA tranche', () => {
  const t = APP.briefTexte({ profil: [], corrections: [], memoire: [{ id: 1, titre: 'Menace sur 10.30.10.11' }],
    a_relier: [{ id: 7, raison: 'cle', detail: 'ip:10.30.10.11', a: { titre: 'Menace sur 10.30.10.11', source: 'vigie' }, b: { titre: 'Le hub redémarre', source: 'hub' } }] });
  assert.match(t, /proposition 7 : « Menace sur 10\.30\.10\.11 » \(vigie\) ↔ « Le hub redémarre » \(hub\) — même ip:10\.30\.10\.11/);
  assert.match(t, /lien_decider/);
});
