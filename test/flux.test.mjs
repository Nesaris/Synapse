// Le flux d'activité en direct (v4) de bout en bout : une session humaine
// s'abonne, un service écrit, l'événement arrive avec ce que le tamis a
// décidé, sans le corps de l'entrée ni le texte d'une question.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { lancer, service, JETON_INSTALLATION, JETON_HUB } from './instance.mjs';
import { Client } from '../socle/essai/client.js';
import { adminComplet } from '../socle/essai/inscription.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { jetonPour } = require('../src/cerveaux.js');
const inst = await lancer();
after(() => inst.arreter());
const admin = new Client(inst.port);
await adminComplet(admin, { jeton: JETON_INSTALLATION });
const vigie = service(inst, jetonPour(JETON_HUB, 'vigie'));

/* s'abonner avec la session de l'administrateur ; rend les événements reçus */
function abonner() {
  const recus = [];
  let tampon = '';
  const req = http.request({ host: '127.0.0.1', port: inst.port, path: '/v1/flux', method: 'GET',
    headers: { accept: 'text/event-stream', cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  const pret = new Promise((ok, ko) => {
    req.on('response', res => {
      res.setEncoding('utf8');
      res.on('data', d => {
        tampon += d;
        let i;
        while ((i = tampon.indexOf('\n\n')) >= 0) {
          const bloc = tampon.slice(0, i); tampon = tampon.slice(i + 2);
          const type = (bloc.match(/^event: (.+)$/m) || [])[1];
          const data = (bloc.match(/^data: (.+)$/m) || [])[1];
          if (type && data) recus.push({ type, data: JSON.parse(data) });
        }
      });
      ok(res);
    });
    req.on('error', ko);
  });
  req.end();
  return { recus, pret, fermer: () => req.destroy() };
}
const attendre = async (cond, ms = 4000) => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (cond()) return true; await new Promise(r => setTimeout(r, 50)); }
  return false;
};

test('flux : réservé aux personnes, et à qui le demande en flux d’événements', async () => {
  assert.equal((await vigie.req('GET', '/v1/flux', undefined, { accept: 'text/event-stream' })).status, 403, 'un service ne s’abonne pas');
  assert.equal((await admin.get('/v1/flux')).status, 406, 'sans Accept: text/event-stream, pas de réponse sans fin');
});

test('flux : une écriture arrive avec son cerveau, le tamis dit ce qu’il décide, aucun corps ne part', async () => {
  const a = abonner();
  const res = await a.pret;
  assert.equal(res.statusCode, 200);
  assert.ok(await attendre(() => a.recus.some(e => e.type === 'etat')), 'un état tout de suite');
  const corps = 'SECRET-DU-CORPS-' + Date.now();
  const r = await vigie.post('/v1/ingest', { ns: 'shared', kind: 'security.alert', title: 'Menace extérieure non bloquée : 203.0.113.9',
    body: corps, tags: ['securite'], meta: { gravite: 'critique' } });
  assert.ok([201, 202].includes(r.status), r.texte);
  assert.ok(await attendre(() => a.recus.some(e => e.type === 'lot' && e.data.some(x => x.type === 'ecrit' && x.id === r.json.id))), 'l’écriture est annoncée');
  const lot = a.recus.filter(e => e.type === 'lot').flatMap(e => e.data);
  const ecrit = lot.find(x => x.type === 'ecrit' && x.id === r.json.id);
  assert.equal(ecrit.source, 'vigie');
  assert.ok(ecrit.cerveau, 'le cerveau où elle est rangée');
  assert.ok(lot.some(x => x.type === 'tamis' && x.entree === r.json.id), 'une alerte critique : le tamis annonce sa remontée');
  assert.ok(!JSON.stringify(a.recus).includes(corps), 'le corps de l’entrée ne part jamais');
  a.fermer();
});

test('flux : une question est annoncée avec sa route et son étage, jamais son texte', async () => {
  const a = abonner();
  await a.pret;
  const texte = 'question-secrete-' + Date.now();
  await vigie.get('/v1/search?q=' + texte);
  assert.ok(await attendre(() => a.recus.some(e => e.type === 'lot' && e.data.some(x => x.type === 'question'))), 'la question est annoncée');
  const q = a.recus.filter(e => e.type === 'lot').flatMap(e => e.data).find(x => x.type === 'question');
  assert.equal(q.route, 'search');
  assert.equal(q.source, 'vigie');
  assert.equal(q.longueur, texte.length);
  assert.ok(!JSON.stringify(a.recus).includes(texte), 'le texte de la question ne part jamais');
  a.fermer();
});

test('flux : le débit par source est compté', async () => {
  const a = abonner();
  await a.pret;
  assert.ok(await attendre(() => a.recus.some(e => e.type === 'etat' && (e.data.debit_60s || {}).vigie >= 1)), JSON.stringify(a.recus.filter(e => e.type === 'etat')));
  a.fermer();
});
