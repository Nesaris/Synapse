'use strict';
/* Les leçons (5.1) : une erreur corrigée devient une règle relue avant chaque tâche du même genre. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const LEC = require('./lecons.js');
const APP = require('./apprentissage.js');

const base = () => { const db = new DatabaseSync(':memory:'); APP.migrate(db); LEC.migrate(db); return db; };

test('leçons : la règle du calcul est là d’office, avec son outil, dès la première question', () => {
  const db = base();
  const r = LEC.pour(db, 'qwen3', 'combien font 10XpiX324000 ?');
  assert.ok(r.intentions.includes('calcul'));
  assert.match(r.lecons[0].regle, /outil calculer/);
  assert.equal(r.outils[0].nom, 'calculer');
  assert.equal(LEC.pour(db, 'qwen3', 'quel est le VLAN de proxmox ?').outils.length, 0, 'pas d’outil de calcul hors calcul');
});

test('leçons : une IA retient une leçon, la retrouve à la tâche suivante du même genre ; les autres IA non', () => {
  const db = base();
  const a = LEC.apprendre(db, { agent: 'kimi', intention: 'commande', regle: 'Donner les commandes groupées en un seul bloc à coller', cause: 'l’utilisateur colle tout d’un coup' });
  assert.ok(a.ok);
  assert.ok(LEC.pour(db, 'kimi', 'donne la commande docker pour relancer synapse').lecons.some(l => /un seul bloc/.test(l.regle)));
  assert.ok(!LEC.pour(db, 'qwen3', 'donne la commande docker pour relancer synapse').lecons.some(l => /un seul bloc/.test(l.regle)), 'portée agent : pour elle seule');
  LEC.apprendre(db, { agent: 'kimi', portee: 'commun', intention: 'commande', regle: 'Toujours dire depuis quelle machine lancer la commande' });
  assert.ok(LEC.pour(db, 'qwen3', 'quelle commande ssh pour la VM hub ?').lecons.some(l => /quelle machine/.test(l.regle)), 'portée commune : pour toutes');
  assert.equal(LEC.apprendre(db, { agent: 'kimi', intention: 'calcul', regle: 'faux' }).ok, false, 'une règle vide de sens est refusée');
});

test('leçons : relue, confirmée, contredite ; trop contredite elle se retire, jamais la leçon de base', () => {
  const db = base();
  const { lecon } = LEC.apprendre(db, { agent: 'kimi', intention: 'reseau', regle: 'Le VLAN 40 sert aux IA' });
  LEC.pour(db, 'kimi', 'quel vlan pour ollama ?');
  for (let i = 0; i < 3; i++) LEC.retour(db, lecon.id, { utile: false, agent: 'kimi' });
  const l = LEC.liste(db).find(x => x.id === lecon.id);
  assert.equal(l.active, 0, 'retirée');
  assert.equal(l.relue, 1);
  const b = LEC.liste(db).find(x => x.origine === 'base');
  for (let i = 0; i < 5; i++) LEC.retour(db, b.id, { utile: false, agent: 'kimi' });
  assert.equal(LEC.liste(db).find(x => x.id === b.id).active, 1, 'la leçon de base reste');
  assert.equal(LEC.retour(db, lecon.id, { utile: true, agent: 'qwen3' }).ok, false, 'une IA ne note pas la leçon d’une autre');
});

test('briefing : les leçons et les outils passent en tête, avant la mémoire', async () => {
  const db = base();
  const b = await APP.brief(db, { agent: 'qwen3', q: 'combien font 7 fois 6 ?' });
  const t = APP.briefTexte(b);
  assert.ok(t.startsWith('Leçons à appliquer'), t);
  assert.match(t, /calculer\(\{ expression \}\)/);
});
