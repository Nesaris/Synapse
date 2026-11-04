'use strict';
/* Le registre des outils (5.2) : créés par les IA, testés en bac à sable, partagés, surveillés. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const OUT = require('./outils.js');
const LEC = require('./lecons.js');

const base = () => { const db = new DatabaseSync(':memory:'); LEC.migrate(db); OUT.migrate(db); return db; };
const CONVERTIR = { nom: 'convertir_octets', description: 'Convertit des octets en Mo, Go et To.', intention: 'calcul',
  code: 'const o = Number(args.octets); return { mo: o / 1048576, go: o / 1073741824 };',
  essais: [{ entree: { octets: 1073741824 }, attendu: { mo: 1024, go: 1 } }, { entree: { octets: 0 }, attendu: { mo: 0, go: 0 } }] };

test('outils : publié seulement si tous ses essais passent ; sinon chaque essai dit pourquoi', async () => {
  const db = base();
  const ok = await OUT.creer(db, { agent: 'qwen3', ...CONVERTIR });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.outil.version, 1);
  const ko = await OUT.creer(db, { agent: 'qwen3', ...CONVERTIR, nom: 'convertir_faux', code: 'return { mo: 1, go: 1 };' });
  assert.equal(ko.ok, false);
  assert.ok(ko.essais.some(e => !e.passe && e.obtenu), 'l’essai raté montre ce qui a été obtenu');
  assert.equal(OUT.un(db, 'convertir_faux'), null, 'rien n’est publié');
});

test('outils : un code qui tente le réseau, les fichiers ou eval échoue ses essais et n’est jamais publié', async () => {
  const db = base();
  for (const code of ['return typeof fetch === "function" ? 1 : fetch("http://1.1.1.1");', 'return eval("1");', 'return require("fs").readFileSync("/etc/passwd","utf8");'])
    assert.equal((await OUT.creer(db, { agent: 'kimi', nom: 'pirate', description: 'tente de sortir du bac à sable', intention: 'general', code, essais: [{ entree: {}, attendu: 1 }] })).ok, false, code);
});

test('outils : appelé par une autre IA, journalisé ; cinq échecs de suite le suspendent', async () => {
  const db = base();
  await OUT.creer(db, { agent: 'qwen3', ...CONVERTIR });
  const r = await OUT.appeler(db, { agent: 'kimi', nom: 'convertir_octets', args: { octets: 5242880 } });
  assert.deepEqual(r.resultat, { mo: 5, go: 5242880 / 1073741824 });
  assert.equal(OUT.tout(db)[0].journal[0].agent, 'kimi');
  await OUT.creer(db, { agent: 'qwen3', nom: 'fragile', description: 'échoue sans argument valable', intention: 'general', code: 'if (!args.x) throw new Error("x manquant"); return args.x;', essais: [{ entree: { x: 2 }, attendu: 2 }] });
  for (let i = 0; i < 5; i++) await OUT.appeler(db, { agent: 'kimi', nom: 'fragile', args: {} });
  assert.equal(OUT.un(db, 'fragile').statut, 'suspendu');
  assert.equal((await OUT.appeler(db, { agent: 'kimi', nom: 'fragile', args: { x: 1 } })).ok, false);
  assert.ok(OUT.basculer(db, 'fragile', true).ok);
  assert.equal((await OUT.appeler(db, { agent: 'kimi', nom: 'fragile', args: { x: 1 } })).resultat, 1, 'réactivé par l’humain');
});

test('outils : une nouvelle version repasse les essais ; la calculatrice de base est dans le registre', async () => {
  const db = base();
  await OUT.creer(db, { agent: 'qwen3', ...CONVERTIR });
  const v2 = await OUT.creer(db, { agent: 'kimi', ...CONVERTIR, code: CONVERTIR.code + ' /* v2 */' });
  assert.equal(v2.outil.version, 2);
  assert.equal(v2.outil.auteur, 'kimi');
  assert.equal((await OUT.appeler(db, { agent: 'kimi', nom: 'calculer', args: { expression: '7 fois 6' } })).resultat.valeur, '42');
  assert.equal((await OUT.creer(db, { agent: 'kimi', ...CONVERTIR, nom: 'calculer' })).ok, false, 'on ne remplace pas un outil de base');
});

test('outils : avant une tâche de calcul, l’IA reçoit ses outils de calcul, ceux de base et ceux créés', async () => {
  const db = base();
  await OUT.creer(db, { agent: 'qwen3', ...CONVERTIR });
  const r = LEC.pour(db, 'kimi', 'combien de Go font 5368709120 octets ?');
  assert.deepEqual(r.outils.map(o => o.nom), ['calculer', 'convertir_octets']);
  assert.match(LEC.texte(r), /convertir_octets.*créé par qwen3/);
});
