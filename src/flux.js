'use strict';
/* SYNAPSE — le flux d'activité en direct (v4).

   Le serveur annonce ce qui se passe à l'instant où ça se passe : une
   entrée écrite, une décision du tamis, une question posée. La page n'anime
   rien d'autre que ces événements ; sans activité, la scène est calme.

   Hors du chemin d'écriture : émettre ne fait que pousser dans une file en
   mémoire. L'envoi part par lots toutes les PERIODE ms. Au-delà de
   PAR_LOT événements par lot, le surplus n'est pas perdu en silence : il est
   compté par type et annoncé (« agrege »). Sans abonné, rien n'est gardé
   sauf les compteurs de débit.

   Ce qui part : identifiants, sources, genres, cerveaux, durées, règles.
   Jamais le corps d'une entrée, jamais un jeton, jamais le texte d'une
   question (sa longueur seulement). Chaque abonné ne reçoit que les espaces
   qu'il a le droit de lire. */

const MAX_ABONNES = 16;
const PERIODE = 100;            /* ms entre deux lots */
const PAR_LOT = 300;            /* événements par lot au plus */
const ETAT_MS = 5000;           /* un « etat » toutes les 5 s */
const SEAUX = 12;               /* débit sur 60 s : 12 seaux de 5 s */
const BATTEMENT_MS = 25000;     /* commentaire de maintien pour les proxys */

function creer({ etat } = {}) {
  const abonnes = new Set();
  let file = [];
  let surplus = {};
  /* débit par source, toujours compté (même sans abonné) */
  const debit = new Map();           /* source → Array(SEAUX) */
  let seauCourant = Math.floor(Date.now() / ETAT_MS);
  const tourner = () => {
    const s = Math.floor(Date.now() / ETAT_MS);
    if (s === seauCourant) return;
    const pas = Math.min(SEAUX, s - seauCourant);
    for (const t of debit.values()) for (let k = 1; k <= pas; k++) t[(seauCourant + k) % SEAUX] = 0;
    seauCourant = s;
  };
  const compter = source => {
    tourner();
    let t = debit.get(source);
    if (!t) { t = new Array(SEAUX).fill(0); debit.set(source, t); }
    t[seauCourant % SEAUX]++;
  };
  const debitParSource = () => {
    tourner();
    const out = {};
    for (const [s, t] of debit) { const n = t.reduce((a, b) => a + b, 0); if (n) out[s] = n; }
    return out;
  };

  const envoyer = (ab, type, data) => {
    if (ab.res.writableEnded) return;
    ab.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  function emettre(type, data, ns) {
    if (type === 'ecrit' && data && data.source) compter(data.source);
    if (!abonnes.size) return;
    if (file.length >= PAR_LOT) { surplus[type] = (surplus[type] || 0) + 1; return; }
    file.push({ type, data, ns, t: Date.now() });
  }

  const lots = setInterval(() => {
    if (!abonnes.size) { file = []; surplus = {}; return; }
    const lot = file; file = [];
    const trop = surplus; surplus = {};
    for (const ab of abonnes) {
      const vus = lot.filter(e => ab.voit(e.ns)).map(e => ({ type: e.type, t: e.t, ...e.data }));
      if (vus.length) envoyer(ab, 'lot', vus);
      if (Object.keys(trop).length) envoyer(ab, 'agrege', { perdus: trop, raison: `plus de ${PAR_LOT} événements en ${PERIODE} ms` });
    }
  }, PERIODE);
  lots.unref();

  const etats = setInterval(() => {
    if (!abonnes.size) return;
    let extra = {};
    try { extra = etat ? etat() : {}; }
    catch (err) { extra = { erreur: `état illisible : ${err.message}` }; }
    const data = { t: Date.now(), debit_60s: debitParSource(), ...extra };
    for (const ab of abonnes) envoyer(ab, 'etat', data);
  }, ETAT_MS);
  etats.unref();

  const battements = setInterval(() => {
    for (const ab of abonnes) if (!ab.res.writableEnded) ab.res.write(': battement\n\n');
  }, BATTEMENT_MS);
  battements.unref();

  /* Un abonné : une réponse HTTP ouverte et ce qu'il a le droit de voir.
     Rend false quand il y a déjà trop d'abonnés. */
  function abonner(res, voit) {
    if (abonnes.size >= MAX_ABONNES) return false;
    const ab = { res, voit };
    abonnes.add(ab);
    res.on('close', () => abonnes.delete(ab));
    res.write('retry: 5000\n\n');
    return true;
  }

  function arreter() {
    clearInterval(lots); clearInterval(etats); clearInterval(battements);
    for (const ab of abonnes) if (!ab.res.writableEnded) ab.res.end();
    abonnes.clear();
  }

  return { emettre, abonner, arreter, debitParSource, nbAbonnes: () => abonnes.size };
}

module.exports = { creer, MAX_ABONNES, PERIODE, PAR_LOT, ETAT_MS };
