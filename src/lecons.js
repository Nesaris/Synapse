'use strict';
/* SYNAPSE — les leçons (5.1).

   Une correction porte sur UNE question : la même question reposée ramène
   la bonne réponse. Une leçon porte sur un GENRE de tâche : « tout calcul
   passe par l'outil calculer » vaut pour tous les calculs, même jamais vus.
   C'est ce qui rend une IA précise dans la durée : elle ne refait pas la
   même erreur sous une autre forme.

   Une leçon dit : le genre de tâche (intention), la règle, sa cause,
   l'erreur et sa correction, sa preuve, sa portée (toutes les IA ou une
   seule). Elle est relue avant chaque tâche de son genre (le briefing la
   place en tête). Elle compte combien de fois elle a été relue, confirmée
   (elle a servi), contredite (elle a égaré). Trop contredite, elle se
   retire d'elle-même ; rien n'est effacé, l'humain voit tout.

   Les outils de base (la calculatrice) sont annoncés avec les leçons de
   leur genre : l'IA sait QUOI faire et AVEC QUOI. */

const { trouverCalculs } = require('./calcul.js');

const INTENTIONS = ['calcul', 'commande', 'reseau', 'date', 'code', 'general'];
const MAX_LECONS = 500;                     /* par agent ; les communes à part */
const RETRAIT_CONTREDITE = 3;               /* contredite au moins 3 fois et plus souvent que confirmée → retirée */

const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const agentId = nom => norm(nom).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'inconnu';
const txt = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const maintenant = () => new Date().toISOString();

/* Les outils de base, fournis d'office, par genre de tâche. */
const OUTILS = {
  calcul: [{ nom: 'calculer', usage: 'calculer({ expression })', role: 'calcule exactement + - × / ^, π, e, racine ; ne calcule jamais de tête' }],
};

/* Les leçons de base : présentes avant toute erreur. */
const BASE = [
  { intention: 'calcul', regle: 'Tout calcul passe par l’outil calculer : ne calcule jamais de tête, même une opération simple.',
    cause: 'Un modèle de langage prédit des chiffres, il ne calcule pas : il se trompe même sur des opérations courtes.',
    preuve: 'outil de base fourni d’office (règle de l’utilisateur)' },
];

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lecons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      portee      TEXT NOT NULL CHECK (portee IN ('commun','agent')),
      agent       TEXT NOT NULL DEFAULT '',
      intention   TEXT NOT NULL,
      regle       TEXT NOT NULL,
      cause       TEXT NOT NULL DEFAULT '',
      erreur      TEXT NOT NULL DEFAULT '',
      correction  TEXT NOT NULL DEFAULT '',
      preuve      TEXT NOT NULL DEFAULT '',
      origine     TEXT NOT NULL DEFAULT 'ia',
      relue       INTEGER NOT NULL DEFAULT 0,
      confirmee   INTEGER NOT NULL DEFAULT 0,
      contredite  INTEGER NOT NULL DEFAULT 0,
      active      INTEGER NOT NULL DEFAULT 1,
      cree_le     TEXT NOT NULL,
      dernier_le  TEXT NOT NULL,
      UNIQUE (portee, agent, intention, regle)
    );
    CREATE INDEX IF NOT EXISTS idx_lecons_int ON lecons(intention, active);
  `);
  const t = maintenant();
  const ins = db.prepare(`INSERT OR IGNORE INTO lecons(portee,agent,intention,regle,cause,preuve,origine,cree_le,dernier_le)
    VALUES('commun','',?,?,?,?,'base',?,?)`);
  for (const b of BASE) ins.run(b.intention, b.regle, b.cause, b.preuve, t, t);
}

/* Le genre d'une tâche, lu dans la question. Plusieurs genres possibles. */
function intentions(question) {
  const q = norm(question), out = new Set();
  if (trouverCalculs(question).length || /\b(calcul|combien (font|fait|de|d')|somme|moyenne|pourcentage|multipli|divis|racine|puissance|convertir|conversion)/.test(q)) out.add('calcul');
  if (/\b(commande|script|bash|shell|ssh|terminal|sudo|docker|systemctl|git|compose|apt)\b/.test(q)) out.add('commande');
  if (/\b(ip|vlan|port|dns|dhcp|sous.?reseau|subnet|routeur|pare.?feu|firewall|ping|proxmox|switch)\b|\b\d{1,3}(\.\d{1,3}){3}\b/.test(q)) out.add('reseau');
  if (/\b(date|jour|jours|semaine|mois|annee|heure|quand|depuis|echeance|delai)\b/.test(q)) out.add('date');
  if (/\b(code|fonction|bug|javascript|python|node|regex|requete sql|programme)\b/.test(q)) out.add('code');
  out.add('general');
  return [...out];
}

/**
 * Une IA apprend une leçon (ou la renforce si elle existe déjà).
 * portee « agent » : pour elle seule ; « commun » : pour toutes les IA.
 */
function apprendre(db, { agent, portee = 'agent', intention, regle, cause = '', erreur = '', correction = '', preuve = '', origine = 'ia' }) {
  const p = portee === 'commun' ? 'commun' : 'agent';
  const a = p === 'commun' ? '' : agentId(agent);
  const i = INTENTIONS.includes(intention) ? intention : 'general';
  const r = txt(regle, 300);
  if (r.length < 8) return { ok: false, erreur: 'règle trop courte : dis ce qu’il faut faire, pas seulement ce qui s’est passé' };
  const t = maintenant();
  db.prepare(`INSERT INTO lecons(portee,agent,intention,regle,cause,erreur,correction,preuve,origine,cree_le,dernier_le)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(portee,agent,intention,regle) DO UPDATE SET
      confirmee = confirmee + 1, active = 1, dernier_le = excluded.dernier_le,
      cause = CASE WHEN excluded.cause <> '' THEN excluded.cause ELSE cause END,
      erreur = CASE WHEN excluded.erreur <> '' THEN excluded.erreur ELSE erreur END,
      correction = CASE WHEN excluded.correction <> '' THEN excluded.correction ELSE correction END,
      preuve = CASE WHEN excluded.preuve <> '' THEN excluded.preuve ELSE preuve END`)
    .run(p, a, i, r, txt(cause, 400), txt(erreur, 400), txt(correction, 400), txt(preuve, 300), txt(origine, 20) || 'ia', t, t);
  if (p === 'agent') {
    const trop = db.prepare(`SELECT COUNT(*) c FROM lecons WHERE portee='agent' AND agent=?`).get(a).c - MAX_LECONS;
    if (trop > 0) db.prepare(`DELETE FROM lecons WHERE id IN (SELECT id FROM lecons WHERE portee='agent' AND agent=?
      ORDER BY active ASC, (confirmee - contredite) ASC, dernier_le ASC LIMIT ?)`).run(a, trop);
  }
  return { ok: true, lecon: db.prepare(`SELECT * FROM lecons WHERE portee=? AND agent=? AND intention=? AND regle=?`).get(p, a, i, r) };
}

/**
 * Les leçons à relire avant cette tâche : celles de ses genres, communes ou
 * propres à l'agent, les plus éprouvées d'abord. Chaque lecture est comptée.
 */
function pour(db, agent, question, { limite = 6, compter = true } = {}) {
  const a = agentId(agent), ints = intentions(question);
  const rows = db.prepare(`SELECT id,portee,intention,regle,cause,correction,relue,confirmee,contredite FROM lecons
    WHERE active = 1 AND (portee = 'commun' OR agent = ?) AND intention IN (SELECT value FROM json_each(?))
    ORDER BY (intention = 'general') ASC, (confirmee - contredite) DESC, relue DESC, id ASC LIMIT ?`).all(a, JSON.stringify(ints), limite);
  if (compter && rows.length) db.prepare(`UPDATE lecons SET relue = relue + 1 WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(rows.map(r => r.id)));
  /* les outils de ces genres de tâche : ceux de base et ceux que les IA se sont créés */
  let outils = [];
  try { outils = require('./outils.js').lister(db, { intentions: ints }); } catch { outils = (OUTILS.calcul || []).filter(() => ints.includes('calcul')); }
  return { intentions: ints, lecons: rows, outils };
}

/** Une leçon a servi (utile) ou a égaré (pas utile). Trop contredite, elle se retire. */
function retour(db, id, { utile, agent }) {
  const l = db.prepare(`SELECT * FROM lecons WHERE id = ?`).get(Number(id));
  if (!l) return { ok: false, erreur: 'leçon inconnue' };
  if (l.portee === 'agent' && l.agent !== agentId(agent)) return { ok: false, erreur: 'cette leçon appartient à une autre IA' };
  db.prepare(`UPDATE lecons SET ${utile ? 'confirmee = confirmee + 1' : 'contredite = contredite + 1'}, dernier_le = ? WHERE id = ?`).run(maintenant(), l.id);
  const m = db.prepare(`SELECT * FROM lecons WHERE id = ?`).get(l.id);
  if (m.origine !== 'base' && m.contredite >= RETRAIT_CONTREDITE && m.contredite > m.confirmee) db.prepare(`UPDATE lecons SET active = 0 WHERE id = ?`).run(l.id);
  return { ok: true, lecon: db.prepare(`SELECT * FROM lecons WHERE id = ?`).get(l.id) };
}

/** L'humain retire ou réactive une leçon ; rien n'est effacé. */
function basculer(db, id, active) {
  const r = db.prepare(`UPDATE lecons SET active = ?, dernier_le = ? WHERE id = ?`).run(active ? 1 : 0, maintenant(), Number(id));
  return { ok: !!Number(r.changes) };
}

function liste(db, { agent = null, actives = false } = {}) {
  return db.prepare(`SELECT * FROM lecons WHERE (? IS NULL OR portee = 'commun' OR agent = ?) AND (? = 0 OR active = 1)
    ORDER BY active DESC, dernier_le DESC LIMIT 1000`).all(agent && agentId(agent), agent && agentId(agent), actives ? 1 : 0);
}

/** Le texte que l'IA lit en tête de son briefing. */
function texte({ lecons, outils }) {
  const l = [];
  if (lecons.length) {
    l.push('Leçons à appliquer (elles font foi, elles viennent de tes erreurs et de celles des autres IA) :');
    for (const x of lecons) l.push(`- [${x.intention}] ${x.regle}${x.cause ? ` (pourquoi : ${x.cause})` : ''}`);
  }
  if (outils.length) {
    l.push('Outils à utiliser pour cette tâche :');
    for (const o of outils) l.push(`- ${o.usage} : ${o.description || o.role}${o.base ? '' : ` (créé par ${o.auteur})`}`);
  }
  return l.join('\n');
}

module.exports = { migrate, intentions, apprendre, pour, retour, basculer, liste, texte, INTENTIONS, OUTILS };
