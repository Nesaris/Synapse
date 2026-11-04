'use strict';
/* SYNAPSE — les liens proposés, « à relier » (5.x).

   Un souvenir isolé ne sert qu'à lui-même ; relié à un autre (cette alerte
   de vigie et ce redémarrage du hub ont la même cause), il devient un
   raisonnement réutilisable. SYNAPSE cherche donc en continu les souvenirs
   proches qui ne sont pas encore reliés, et les PROPOSE ; une IA ou
   l'humain les confirme (avec la relation : cause, corrige, voir aussi…)
   ou les refuse. Rien n'est relié sans ce geste.

   Deux raisons, toujours entre deux SOURCES différentes, jamais pour une
   paire déjà reliée, proposée ou refusée :
   - une même clé (IP, service, port… calculés par le tamis), sauf une clé
     trop répandue, qui serait du bruit (les fiches s'en chargent) ;
   - un sens très proche, d'après l'index des vecteurs.

   Une passe régulière et bornée (voir LOT, SENS_PAR_PASSE) ; le curseur
   avance, rien n'est relu deux fois. */

const { blobToVec } = require('./db.js');
const VEC = require('./vecteurs.js');
const ingest = require('./ingest.js');

/* bornes : une petite passe toutes les 15 s, 25 entrées dont 8 au plus par le sens (quelques dizaines de ms
   chacune). Mesuré sur 20 000 entrées à 768 dimensions : ~1,2 s pour 100 entrées dont 30 par le sens ; découpé
   ainsi, ~300 ms par passe au plus, pour le même débit (100 entrées par minute). */
const LOT = 25, SENS_PAR_PASSE = 8, PAR_ENTREE = 3, CLE_MAX_ENTREES = 50, SENS_MIN = 0.86;
const maintenant = () => new Date().toISOString();

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS liens_proposes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      a         INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      b         INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      raison    TEXT NOT NULL CHECK (raison IN ('cle','sens')),
      detail    TEXT NOT NULL DEFAULT '',
      score     REAL NOT NULL DEFAULT 0,
      statut    TEXT NOT NULL DEFAULT 'propose' CHECK (statut IN ('propose','confirme','refuse')),
      relation  TEXT,
      par       TEXT,
      cree_le   TEXT NOT NULL,
      decide_le TEXT,
      UNIQUE (a, b)
    );
    CREATE INDEX IF NOT EXISTS idx_lp_statut ON liens_proposes(statut, id);
    CREATE INDEX IF NOT EXISTS idx_lp_a ON liens_proposes(a);
    CREATE INDEX IF NOT EXISTS idx_lp_b ON liens_proposes(b);
    CREATE TABLE IF NOT EXISTS liens_proposes_curseur (nom TEXT PRIMARY KEY, val INTEGER NOT NULL);
  `);
}

const paire = (x, y) => (x < y ? [x, y] : [y, x]);

/* Une passe : les entrées arrivées depuis la dernière, leurs voisines par clé et par sens. */
function passe(db, { lot = LOT } = {}) {
  const cur = (db.prepare(`SELECT val FROM liens_proposes_curseur WHERE nom='entrees'`).get() || { val: 0 }).val;
  const entrees = db.prepare(`SELECT id, ns, source FROM entries WHERE id > ? AND archived = 0 AND kind NOT LIKE 'fiche.%' ORDER BY id LIMIT ?`).all(cur, lot);
  if (!entrees.length) return { examinees: 0, proposees: 0 };
  const dejaLies = db.prepare(`SELECT 1 FROM links WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)`);
  const dejaProp = db.prepare(`SELECT 1 FROM liens_proposes WHERE a=? AND b=?`);
  const ins = db.prepare(`INSERT OR IGNORE INTO liens_proposes(a,b,raison,detail,score,cree_le) VALUES(?,?,?,?,?,?)`);
  const cles = db.prepare(`SELECT cle FROM h_cles WHERE entry_id = ?`);
  const compte = db.prepare(`SELECT COUNT(*) n FROM h_cles WHERE cle = ?`);
  const voisinsCle = db.prepare(`SELECT e.id, e.source FROM h_cles k JOIN entries e ON e.id = k.entry_id
    WHERE k.cle = ? AND e.id <> ? AND e.ns = ? AND e.source <> ? AND e.archived = 0 AND e.kind NOT LIKE 'fiche.%' ORDER BY e.id DESC LIMIT 6`);
  const vecteur = db.prepare(`SELECT vec FROM chunks WHERE entry_id = ? AND embedded = 1 AND vec IS NOT NULL ORDER BY seq LIMIT 1`);
  const sourceDe = db.prepare(`SELECT source, ns FROM entries WHERE id = ?`);
  let proposees = 0, sens = 0;
  const t = maintenant();
  const proposer = (e, autre, raison, detail, score) => {
    const [a, b] = paire(e, autre);
    if (dejaLies.get(a, b, b, a) || dejaProp.get(a, b)) return false;
    return Number(ins.run(a, b, raison, String(detail).slice(0, 120), score, t).changes) > 0;
  };
  db.exec('BEGIN');
  try {
    for (const e of entrees) {
      let n = 0;
      /* 1. une même clé, chez une autre source */
      for (const { cle } of cles.all(e.id)) {
        if (n >= PAR_ENTREE) break;
        if (compte.get(cle).n > CLE_MAX_ENTREES) continue;            /* clé trop répandue : du bruit */
        for (const v of voisinsCle.all(cle, e.id, e.ns, e.source)) { if (n >= PAR_ENTREE) break; if (proposer(e.id, v.id, 'cle', cle, 1)) { n++; proposees++; } }
      }
      /* 2. un sens très proche, d'après l'index des vecteurs */
      if (n < PAR_ENTREE && sens < SENS_PAR_PASSE) {
        sens++;
        const r = vecteur.get(e.id);
        const q = r && blobToVec(r.vec);
        const proches = q ? (VEC.proches(db, e.ns, q, 8) || []) : [];
        for (const p of proches) {
          if (n >= PAR_ENTREE) break;
          if (p.id === e.id || p.raw < SENS_MIN) continue;
          const s = sourceDe.get(p.id);
          if (!s || s.source === e.source || s.ns !== e.ns) continue;
          if (proposer(e.id, p.id, 'sens', p.raw.toFixed(3), +p.raw.toFixed(4))) { n++; proposees++; }
        }
      }
    }
    db.prepare(`INSERT INTO liens_proposes_curseur(nom,val) VALUES('entrees',?) ON CONFLICT(nom) DO UPDATE SET val=excluded.val`).run(entrees[entrees.length - 1].id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { examinees: entrees.length, proposees };
}

const AVEC_TITRES = `SELECT p.id, p.a, p.b, p.raison, p.detail, p.score, p.statut, p.relation, p.par, p.cree_le,
    ea.title ta, ea.source sa, ea.ns nsa, eb.title tb, eb.source sb, eb.ns nsb
  FROM liens_proposes p JOIN entries ea ON ea.id = p.a JOIN entries eb ON eb.id = p.b`;
const forme = r => ({ id: r.id, raison: r.raison, detail: r.detail, score: r.score, statut: r.statut, relation: r.relation, par: r.par, cree_le: r.cree_le,
  a: { id: r.a, titre: r.ta, source: r.sa }, b: { id: r.b, titre: r.tb, source: r.sb }, ns: r.nsa });

/** Les propositions en attente, les plus sûres d'abord ; filtrées par espaces lisibles. */
function proposes(db, { lisible = () => true, limite = 50, statut = 'propose' } = {}) {
  return db.prepare(AVEC_TITRES + ` WHERE p.statut = ? ORDER BY (p.raison = 'cle') DESC, p.score DESC, p.id DESC LIMIT ?`).all(statut, Math.min(500, limite) * 3)
    .filter(r => lisible(r.nsa) && lisible(r.nsb)).slice(0, limite).map(forme);
}

/** Celles qui touchent ces entrées : pour le briefing. */
function autour(db, ids, { limite = 3 } = {}) {
  if (!ids.length) return [];
  return db.prepare(AVEC_TITRES + ` WHERE p.statut = 'propose' AND (p.a IN (SELECT value FROM json_each(?)) OR p.b IN (SELECT value FROM json_each(?)))
    ORDER BY (p.raison = 'cle') DESC, p.score DESC LIMIT ?`).all(JSON.stringify(ids), JSON.stringify(ids), limite).map(forme);
}

/** Confirmer (avec la relation) ou refuser. Confirmer crée le vrai lien. */
function decider(db, id, { accepter, relation = 'relates_to', par }) {
  const p = db.prepare(`SELECT * FROM liens_proposes WHERE id = ?`).get(Number(id));
  if (!p) return { ok: false, erreur: 'proposition inconnue' };
  if (p.statut !== 'propose') return { ok: false, erreur: 'déjà ' + (p.statut === 'confirme' ? 'confirmée' : 'refusée') };
  if (accepter) {
    const r = ingest.link(db, p.a, p.b, String(relation || 'relates_to'), par);
    if (!r.ok) return { ok: false, erreur: r.error };
  }
  db.prepare(`UPDATE liens_proposes SET statut = ?, relation = ?, par = ?, decide_le = ? WHERE id = ?`)
    .run(accepter ? 'confirme' : 'refuse', accepter ? String(relation || 'relates_to') : null, String(par || ''), maintenant(), p.id);
  return { ok: true, statut: accepter ? 'confirme' : 'refuse' };
}

/** Combien « à relier » par cerveau : pour la carte et les écrans. */
function parCerveau(db) {
  return db.prepare(`SELECT pl.cerveau_id cerveau, COUNT(*) n FROM liens_proposes p JOIN h_place pl ON pl.entry_id IN (p.a, p.b)
    WHERE p.statut = 'propose' GROUP BY pl.cerveau_id`).all();
}

let minuteur = null;
/** La passe de fond : toutes les 15 secondes, jamais deux à la fois. */
function demarrer(db, { toutesLesMs = 15000, log = console } = {}) {
  if (minuteur) return;
  let enCours = false;
  minuteur = setInterval(() => {
    if (enCours) return; enCours = true;
    try { const r = passe(db); if (r.proposees) log.log(`[liens] ${r.proposees} lien(s) proposé(s) sur ${r.examinees} entrée(s)`); }
    catch (e) { log.error('[liens] passe impossible : ' + e.message); }
    finally { enCours = false; }
  }, toutesLesMs);
  minuteur.unref();
}

module.exports = { migrate, passe, proposes, autour, decider, parCerveau, demarrer, SENS_MIN };
