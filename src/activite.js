'use strict';
/* L'activité réelle de SYNAPSE : ce qu'on lui a demandé, en combien
   de temps, et à quel étage de la cascade il a trouvé.

   L'interface affichait des chiffres écrits en dur — 47 requêtes par
   jour, 0,62 s, des taux d'arrêt inventés. Ils viennent maintenant de
   ce journal, alimenté par /v1/search, /v1/answer et /v1/brief.

   Étages, du moins cher au plus cher :
     L0  correspondance franche, la recherche s'arrête tôt
     L1  plein texte seul
     L2  le vecteur a été nécessaire
     L3  une IA a synthétisé la réponse
     VIDE  rien au-dessus du seuil

   Trente jours de rétention : assez pour une moyenne, trop peu pour
   devenir un historique de ce que chacun a cherché. */

const RETENTION_JOURS = 30;
const ETAGES = ['L0', 'L1', 'L2', 'L3'];

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requetes (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       TEXT NOT NULL,
      route    TEXT NOT NULL,
      source   TEXT,
      q        TEXT NOT NULL DEFAULT '',
      ms       REAL NOT NULL DEFAULT 0,
      decision TEXT,
      arret    TEXT NOT NULL,
      hits     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_requetes_ts ON requetes(ts);
  `);
  /* Le compte humain qui a posé la question : de quoi rendre ses données
     à qui les demande, et les effacer avec son compte. */
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('requetes') WHERE name='compte'`).get())
    db.exec(`ALTER TABLE requetes ADD COLUMN compte TEXT`);
  /* 4.3.3 : la trace de la recherche, gardée au moment où la question est posée,
     pour que les écrans la relisent au lieu de rejouer la question. */
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('requetes') WHERE name='detail'`).get())
    db.exec(`ALTER TABLE requetes ADD COLUMN detail TEXT`);
}

/* Ce qu'on garde d'une recherche : sa trace (étapes, décision, 40 candidats au plus) et ses cinq premiers résultats. */
function detailDe(r) {
  if (!r || !r.trace) return null;
  return {
    intent: r.intent, decision: r.decision, reason: r.reason, took_ms: r.took_ms,
    trace: { ...r.trace, candidats: (r.trace.candidats || []).slice(0, 40) },
    hits: (r.hits || []).slice(0, 5).map(h => ({ id: h.id, title: String(h.title || '').slice(0, 160), source: h.source, level: h.level, score: h.score })),
    n_hits: (r.hits || []).length,
  };
}

/* Les dernières questions d'un compte avec leur trace, une fois chacune. */
function traces(db, compte, max = 12) {
  const vus = new Set(), out = [];
  for (const l of db.prepare(`SELECT ts, route, q, detail FROM requetes WHERE compte = ? AND detail IS NOT NULL ORDER BY ts DESC LIMIT 200`).iterate(String(compte))) {
    const cle = String(l.q).toLowerCase();
    if (!l.q || vus.has(cle)) continue;
    let d; try { d = JSON.parse(l.detail); } catch { continue; }
    vus.add(cle); out.push({ ts: l.ts, route: l.route, q: l.q, ...d });
    if (out.length >= max) break;
  }
  return out;
}

function duCompte(db, compte) {
  return db.prepare(`SELECT ts, route, q, ms, arret, hits FROM requetes WHERE compte = ? ORDER BY ts`).all(String(compte));
}
function oublierCompte(db, compte) {
  return Number(db.prepare(`DELETE FROM requetes WHERE compte = ?`).run(String(compte)).changes || 0);
}

/* L'étage auquel une recherche s'est arrêtée, d'après ce qu'elle a
   réellement fait — pas d'après un minutage reconstitué. */
function etageDe(r, { synthese = false } = {}) {
  const e = (r && r.engines) || {};
  const n = (r && r.hits ? r.hits.length : 0);
  if (synthese) return 'L3';
  if (!n) return 'VIDE';
  if (e.early) return 'L0';
  if (e.vector) return 'L2';
  return 'L1';
}

/* Qui écoute les questions : le serveur y branche le flux d'activité (v4).
   Le texte de la question ne part jamais, seulement sa longueur. */
const ecoute = { fn: null };
function annoncer({ route, source, compte = null, q, ms, decision, arret, hits }) {
  if (!ecoute.fn) return;
  try { ecoute.fn({ route: String(route), source: source ? String(source).slice(0, 64) : null, compte: compte ? String(compte) : null,
                    longueur: String(q || '').length, ms: Math.round(Number(ms) || 0), decision: decision || null,
                    arret: String(arret || 'VIDE'), hits: Number(hits) || 0 }); }
  catch (e) { console.error('[activite] annonce impossible :', e && e.message || e); }
}

function noter(db, { route, source, compte = null, q, ms, decision, arret, hits, detail = null }) {
  annoncer({ route, source, compte, q, ms, decision, arret, hits });
  try {
    const d = detail ? JSON.stringify(detail) : null;
    db.prepare(`INSERT INTO requetes(ts,route,source,compte,q,ms,decision,arret,hits,detail)
                VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(new Date().toISOString(), String(route), source ? String(source).slice(0, 64) : null, compte ? String(compte) : null,
           String(q || '').slice(0, 200), Number(ms) || 0, decision || null,
           String(arret || 'VIDE'), Number(hits) || 0, d && d.length <= 32768 ? d : null);
  } catch (e) {
    /* Le journal ne doit jamais faire échouer la requête qu'il observe. */
    console.error('[activite]', e && e.message || e);
  }
}

function purge(db, jours = RETENTION_JOURS) {
  db.prepare(`DELETE FROM requetes WHERE ts < ?`)
    .run(new Date(Date.now() - jours * 86400000).toISOString());
}

function resume(db, { jours = 7 } = {}) {
  const depuis24 = new Date(Date.now() - 86400000).toISOString();
  const depuis = new Date(Date.now() - jours * 86400000).toISOString();
  const jour = db.prepare(`SELECT count(*) n, avg(ms) m FROM requetes WHERE ts >= ?`).get(depuis24);
  const periode = db.prepare(`SELECT count(*) n, avg(ms) m FROM requetes WHERE ts >= ?`).get(depuis);
  const parEtage = Object.fromEntries(
    db.prepare(`SELECT arret, count(*) n FROM requetes WHERE ts >= ? GROUP BY arret`).all(depuis)
      .map(r => [r.arret, r.n]));
  /* Les questions humaines récentes, sans doublon : ce sont elles qui
     servent de raccourcis dans la barre, à la place d'exemples inventés. */
  const recentes = db.prepare(
    `SELECT q, max(ts) t FROM requetes
     WHERE route = 'answer' AND length(q) >= 3 AND ts >= ?
     GROUP BY lower(q) ORDER BY t DESC LIMIT 6`).all(depuis).map(r => r.q);
  return {
    jours,
    requetes_24h: jour.n,
    ms_moyen_24h: jour.m == null ? null : Math.round(jour.m),
    /* quantiles mesurés sur les requêtes des 24 dernières heures (v4.2) */
    ...(() => {
      const ms = db.prepare(`SELECT ms FROM requetes WHERE ts >= ? ORDER BY ms`).all(depuis24).map(r => r.ms);
      const q = f => ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor(f * ms.length))]) : null;
      return { ms_p50_24h: q(0.5), ms_p95_24h: q(0.95) };
    })(),
    requetes_periode: periode.n,
    ms_moyen_periode: periode.m == null ? null : Math.round(periode.m),
    etages: Object.fromEntries([...ETAGES, 'VIDE'].map(k => [k, parEtage[k] || 0])),
    recentes,
    /* les 60 dernières requêtes, mesurées (v4.3 : l'écran du pipeline) */
    serie: db.prepare(`SELECT ts, route, source, q, ms, decision, arret, hits FROM requetes ORDER BY ts DESC LIMIT 60`).all()
      .map(r => ({ t: r.ts, route: r.route, source: r.source, q: String(r.q || '').slice(0, 120), ms: Math.round(r.ms), decision: r.decision, arret: r.arret, hits: r.hits })),
  };
}

module.exports = {
  ecoute, annoncer, migrate, noter, purge, resume, etageDe, ETAGES, RETENTION_JOURS, duCompte, oublierCompte, detailDe, traces };
