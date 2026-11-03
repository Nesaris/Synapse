'use strict';
/* SYNAPSE — index vectoriel compact (5.0).

   Avant, l'index gardait chaque vecteur en pleine précision : 768 nombres
   de 4 octets, 3 Ko par morceau. Il se désactivait au-delà de 120 000
   morceaux (≈ 350 Mo) et la recherche relisait alors TOUS les vecteurs
   depuis la base, à chaque question : 6 à 17 s sur 177 000 morceaux.

   Ici, deux étages :
   1. En mémoire, un code binaire par morceau : 1 bit par dimension, le
      signe du vecteur une fois retirée la moyenne du corpus (le centrage
      répartit mieux les bits). 768 dimensions = 96 octets ; 177 000
      morceaux = 17 Mo ; un million = 96 Mo. Un premier tri parcourt tout
      le corpus en comptant les bits qui diffèrent (distance de Hamming).
   2. Les meilleurs candidats (1 000 au moins, 40 par résultat demandé) sont
      re-classés avec leurs VRAIS vecteurs, lus en base pour eux seuls :
      le score rendu est le cosinus exact, comme avant. Mesuré sur 180 000
      morceaux de 768 dimensions : 1 000 candidats rendent les mêmes 10
      premiers que la recherche exhaustive. Sur un corpus plus
      petit que ce nombre de candidats, tout est re-classé : le résultat
      est exactement celui de la recherche exhaustive.

   L'index se tient à jour par ajout : un morceau vectorisé après la
   construction est ajouté au bout, rien n'est reconstruit. Il ne se
   reconstruit en entier que si des morceaux ont disparu (purge, import),
   ce qu'un recomptage périodique détecte. L'archivage d'une entrée est lu
   au moment du re-classement : jamais périmé. */

const { blobToVec } = require('./db.js');

/* Au-delà, l'index se désactive et la recherche reprend le repli en flux.
   À 105 octets par morceau en mémoire, 2 millions de morceaux ≈ 210 Mo. */
const MAX_MORCEAUX = Number(process.env.VECTEURS_MAX || 2000000);
/* Candidats re-classés exactement : au moins CANDIDATS_MIN, sinon
   SURECHANTILLON par résultat demandé. */
const CANDIDATS_MIN = Number(process.env.VECTEURS_CANDIDATS || 1000);
const SURECHANTILLON = 40;
/* Échantillon qui fixe la moyenne de centrage. */
const ECHANTILLON_MOYENNE = 5000;
/* Recomptage complet (morceaux disparus) au plus toutes les 5 minutes. */
const RECOMPTE_MS = 5 * 60000;

const caches = new Map();   /* ns → { idx, verifie } */

/* Le compte de bits à 1 d'un mot de 32 bits, sans table. */
function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

function nouveau(dim, moyenne) {
  const mots = Math.ceil(dim / 32), cap = 1024;
  return { dim, mots, moyenne, n: 0, cap, codes: new Uint32Array(cap * mots), chunk: new Int32Array(cap), entry: new Int32Array(cap), maxChunk: 0, construit: Date.now() };
}
function agrandir(idx, besoin) {
  if (besoin <= idx.cap) return;
  let cap = idx.cap; while (cap < besoin) cap *= 2;
  const codes = new Uint32Array(cap * idx.mots); codes.set(idx.codes); idx.codes = codes;
  const chunk = new Int32Array(cap); chunk.set(idx.chunk); idx.chunk = chunk;
  const entry = new Int32Array(cap); entry.set(idx.entry); idx.entry = entry;
  idx.cap = cap;
}
/* Le code binaire d'un vecteur : un bit à 1 quand la composante dépasse la moyenne. */
function coder(v, moyenne, mots, sortie = new Uint32Array(mots), o = 0) {
  for (let w = 0; w < mots; w++) {
    let m = 0;
    const base = w * 32, fin = Math.min(32, v.length - base);
    for (let b = 0; b < fin; b++) if (v[base + b] > moyenne[base + b]) m |= (1 << b);
    sortie[o + w] = m >>> 0;
  }
  return sortie;
}
function ajouter(idx, chunkId, entryId, v) {
  agrandir(idx, idx.n + 1);
  coder(v, idx.moyenne, idx.mots, idx.codes, idx.n * idx.mots);
  idx.chunk[idx.n] = chunkId; idx.entry[idx.n] = entryId; idx.n++;
  if (chunkId > idx.maxChunk) idx.maxChunk = chunkId;
}

const SQL_MORCEAUX = `SELECT c.id AS cid, c.entry_id AS eid, c.vec AS v FROM chunks c JOIN entries e ON e.id = c.entry_id
  WHERE c.embedded = 1 AND c.vec IS NOT NULL AND e.ns = ? AND c.id > ? ORDER BY c.id`;

function compter(db, ns) {
  return db.prepare(`SELECT COUNT(*) n FROM chunks c JOIN entries e ON e.id = c.entry_id
    WHERE c.embedded = 1 AND c.vec IS NOT NULL AND e.ns = ?`).get(ns).n;
}

/* Construction complète, en flux : jamais tous les vecteurs en mémoire à la fois. */
function construire(db, ns) {
  const total = compter(db, ns);
  /* Compter AVANT de charger : au-delà du plafond, on ne lit rien (leçon de la 3.5.1). */
  if (!total || total > MAX_MORCEAUX) return null;
  /* 1. la moyenne de centrage, sur un échantillon */
  let dim = 0, somme = null, nb = 0;
  for (const r of db.prepare(SQL_MORCEAUX + ` LIMIT ${ECHANTILLON_MOYENNE}`).iterate(ns, 0)) {
    const v = blobToVec(r.v);
    if (!dim) { dim = v.length; somme = new Float64Array(dim); }
    if (v.length !== dim) continue;
    for (let k = 0; k < dim; k++) somme[k] += v[k];
    nb++;
  }
  if (!dim || !nb) return null;
  const moyenne = new Float32Array(dim);
  for (let k = 0; k < dim; k++) moyenne[k] = somme[k] / nb;
  /* 2. les codes de tous les morceaux */
  const idx = nouveau(dim, moyenne);
  agrandir(idx, total);
  for (const r of db.prepare(SQL_MORCEAUX).iterate(ns, 0)) {
    const v = blobToVec(r.v);
    if (v.length !== dim) continue;      /* un vecteur d'un ancien modèle : écarté, comme avant */
    ajouter(idx, r.cid, r.eid, v);
  }
  idx.total = total;
  return idx;
}

/* Les morceaux vectorisés depuis la dernière fois, ajoutés au bout. */
function completer(db, ns, idx) {
  const dernier = db.prepare(`SELECT COALESCE(MAX(id), 0) m FROM chunks WHERE embedded = 1 AND vec IS NOT NULL`).get().m;
  if (dernier <= idx.maxChunk) return 0;
  let n = 0;
  for (const r of db.prepare(SQL_MORCEAUX).iterate(ns, idx.maxChunk)) {
    const v = blobToVec(r.v);
    if (v.length !== idx.dim) continue;
    if (idx.n >= MAX_MORCEAUX) return -1;
    ajouter(idx, r.cid, r.eid, v); n++;
  }
  /* un morceau d'un autre espace a fait monter le max : on retient où on en est */
  if (dernier > idx.maxChunk) idx.maxChunk = dernier;
  return n;
}

/**
 * L'index de cet espace, construit ou complété si besoin.
 * Renvoie null quand il n'y a rien à indexer ou que l'espace dépasse le
 * plafond : l'appelant reprend alors le repli en flux.
 */
function index(db, ns) {
  let c = caches.get(ns);
  const maintenant = Date.now();
  if (c && c.idx) {
    /* recomptage périodique : des morceaux ont-ils disparu ? */
    if (maintenant - c.verifie > RECOMPTE_MS) {
      c.verifie = maintenant;
      const total = compter(db, ns);
      if (total < c.idx.n || total > MAX_MORCEAUX) c = null;
    }
    if (c && completer(db, ns, c.idx) >= 0) return c.idx;
  } else if (c && !c.idx && maintenant - c.verifie < 30000) {
    return null;     /* rien à indexer il y a moins de 30 s : inutile de recompter à chaque question */
  }
  const idx = construire(db, ns);
  caches.set(ns, { idx, verifie: maintenant });
  return idx;
}

/**
 * Les meilleures entrées pour ce vecteur de requête.
 *
 * `garde` filtre par identifiant d'entrée : c'est par là que passent les
 * filtres de la requête (source, niveau, date…), évalués une fois en SQL.
 * Un morceau représente son entrée ; une entrée garde son meilleur morceau.
 */
function proches(db, ns, qvec, limit, garde = null) {
  const idx = index(db, ns);
  if (!idx || !qvec || qvec.length !== idx.dim) return null;   /* null = pas d'index, reprends le repli */
  const { n, mots, codes, entry, chunk } = idx;

  /* 1. distance de Hamming de chaque morceau au code de la requête */
  const q = coder(qvec, idx.moyenne, mots);
  const dist = new Uint16Array(n);
  const hist = new Uint32Array(idx.dim + 2);
  let admis = 0;
  for (let i = 0; i < n; i++) {
    if (garde && !garde.has(entry[i])) { dist[i] = 65535; continue; }
    let d = 0;
    const o = i * mots;
    for (let w = 0; w < mots; w++) d += popcount(codes[o + w] ^ q[w]);
    dist[i] = d; hist[d]++; admis++;
  }
  if (!admis) return [];

  /* 2. les K plus proches : le seuil de distance qui en garde au moins K */
  const K = Math.min(admis, Math.max(CANDIDATS_MIN, limit * SURECHANTILLON));
  let seuil = 0, cumul = 0;
  for (; seuil <= idx.dim; seuil++) { cumul += hist[seuil]; if (cumul >= K) break; }
  const cands = [];
  for (let i = 0; i < n; i++) if (dist[i] <= seuil) cands.push(chunk[i]);

  /* 3. re-classement exact sur les vrais vecteurs ; l'archivage est lu maintenant */
  const best = new Map();
  const lire = db.prepare(`SELECT c.entry_id AS id, c.vec AS v FROM chunks c JOIN entries e ON e.id = c.entry_id
    WHERE c.id IN (SELECT value FROM json_each(?)) AND e.archived = 0`);
  for (let a = 0; a < cands.length; a += 2000) {
    for (const r of lire.iterate(JSON.stringify(cands.slice(a, a + 2000)))) {
      const v = blobToVec(r.v);
      if (v.length !== qvec.length) continue;
      let dot = 0;
      for (let k = 0; k < v.length; k++) dot += v[k] * qvec[k];
      const prev = best.get(r.id);
      if (prev === undefined || dot > prev) best.set(r.id, dot);
    }
  }
  idx.derniere = { candidats: cands.length, seuil, morceaux: n };
  return [...best.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit)
    .map(([id, s], i) => ({ id, rank: i, raw: s }));
}

/** À appeler quand on sait que l'espace a changé autrement que par ajout. */
function invalider(ns) { if (ns) caches.delete(ns); else caches.clear(); }

function etat() {
  return [...caches.entries()].map(([ns, c]) => ({
    ns, actif: !!c.idx, morceaux: c.idx?.n || 0, dim: c.idx?.dim || 0,
    memoire_mo: c.idx ? +((c.idx.cap * (c.idx.mots * 4 + 8)) / 1048576).toFixed(1) : 0,
    derniere: c.idx?.derniere || null,
  }));
}

module.exports = { proches, index, invalider, etat, MAX_MORCEAUX, CANDIDATS_MIN };
