'use strict';
/* La calculatrice exacte (5.2) : juste, sûre, et lisible en français.
   Référence : 10 × π × 324 000 = 10 178 760,197630930092618964561… (une
   calculette en double précision donne …929, arrondi au 16e chiffre). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculer, trouverCalculs } = require('./calcul.js');

test('calculatrice : le calcul de référence, écrit de toutes les façons', () => {
  for (const e of ['10XpiX324000', '10 × π × 324 000', '10 fois pi fois 324000', '10*pi*324000'])
    assert.ok(calculer(e).valeur.startsWith('10178760.19763093009261896456'), e + ' → ' + calculer(e).valeur);
});

test('calculatrice : exacte sur les quatre opérations et les puissances entières', () => {
  assert.equal(calculer('0,1 + 0,2').valeur, '0.3', 'pas 0.30000000000000004');
  assert.equal(calculer('1/3').fraction, '1/3');
  assert.equal(calculer('2^100').valeur, '1267650600228229401496703205376');
  assert.equal(calculer('10 divisé par 4').valeur, '2.5');
  assert.equal(calculer('3(4+1)').valeur, '15', 'multiplication implicite');
});

test('calculatrice : priorités des opérations', () => {
  assert.equal(calculer('-2^2').valeur, '-4');
  assert.equal(calculer('(-2)^2').valeur, '4');
  assert.equal(calculer('2^3^2').valeur, '512', 'puissance associative à droite');
  assert.equal(calculer('2 + 3 × 4').valeur, '14');
});

test('calculatrice : π, e et racines justes sur au moins 40 chiffres', () => {
  assert.ok(calculer('pi', { decimales: 40 }).valeur.startsWith('3.141592653589793238462643383279502884197'));
  assert.ok(calculer('racine(2)', { decimales: 40 }).valeur.startsWith('1.414213562373095048801688724209698078569'));
  assert.match(calculer('racine(2)').precision, /40 chiffres/);
});

test('calculatrice : refuse proprement, sans jamais évaluer de code', () => {
  assert.equal(calculer('1/0').erreur, 'division par zéro');
  assert.equal(calculer('2^99999').ok, false);
  assert.equal(calculer('process.exit(1)').ok, false);
  assert.equal(calculer('constructor').ok, false);
  assert.equal(calculer('x'.repeat(600)).ok, false);
});

test('calculatrice : retrouve les calculs dans une phrase, pas les dates, heures ou nombres seuls', () => {
  assert.deepEqual(trouverCalculs('combien font 10XpiX324000 ?').map(r => r.expression), ['10XpiX324000']);
  assert.deepEqual(trouverCalculs('quelle est la racine de 2 et combien fait 7 fois 6').map(r => r.lisible), ['1,4142135623…', '42']);
  assert.deepEqual(trouverCalculs('rdv le 12/11 à 14:30, port 8120'), []);
  assert.deepEqual(trouverCalculs('le VLAN 40 a 324 000 paquets'), []);
});
