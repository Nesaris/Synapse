'use strict';
/* SYNAPSE — le registre des outils (5.2).

   Une IA se crée un outil quand il lui manque : un nom, ce qu'il fait, le
   genre de tâche qu'il sert, son code (le corps d'une fonction (args) qui
   rend une valeur JSON) et ses cas d'essai. SYNAPSE exécute les essais
   dans le bac à sable : tous passent, l'outil est publié et toutes les IA
   peuvent l'appeler ; un seul échoue, il est refusé, et l'IA sait pourquoi.

   Chaque appel est journalisé ; cinq échecs de suite suspendent l'outil.
   L'humain voit tout (code, essais, auteur, appels, erreurs) et peut
   suspendre ou réactiver. Les outils de base (la calculatrice) sont dans
   le registre, marqués « base », et ne passent pas par le bac à sable. */

const crypto = require('node:crypto');
const BAC = require('./bac-a-sable.js');
const CALC = require('./calcul.js');

const INTENTIONS = ['calcul', 'commande', 'reseau', 'date', 'code', 'general'];
const NOM = /^[a-z][a-z0-9_]{2,39}$/;
const CODE_MAX = 20000, ESSAIS_MAX = 20, ECHECS_SUSPENSION = 5, JOURNAL_MAX = 20000;
const maintenant = () => new Date().toISOString();
const txt = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const agentId = nom => String(nom || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'inconnu';

/* Les outils de base : intégrés, toujours là. */
const BASE = {
  calculer: { nom: 'calculer', intention: 'calcul', description: 'Calcule exactement + - × / ^, parenthèses, π, e, racine ; écriture française comprise.',
    usage: 'calculer({ expression })', appeler: a => { const r = CALC.calculer(a && a.expression); return r.ok ? { ok: true, resultat: r } : { ok: false, erreur: r.erreur }; } },
};

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outils (
      nom         TEXT PRIMARY KEY,
      version     INTEGER NOT NULL DEFAULT 1,
      description TEXT NOT NULL,
      intention   TEXT NOT NULL,
      code        TEXT NOT NULL,
      essais      TEXT NOT NULL,
      empreinte   TEXT NOT NULL,
      auteur      TEXT NOT NULL,
      statut      TEXT NOT NULL DEFAULT 'publie' CHECK (statut IN ('publie','suspendu')),
      appels      INTEGER NOT NULL DEFAULT 0,
      echecs      INTEGER NOT NULL DEFAULT 0,
      echecs_suite INTEGER NOT NULL DEFAULT 0,
      cree_le     TEXT NOT NULL,
      modifie_le  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outils_journal (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      nom     TEXT NOT NULL,
      version INTEGER NOT NULL,
      agent   TEXT NOT NULL,
      quand   TEXT NOT NULL,
      ms      INTEGER NOT NULL,
      ok      INTEGER NOT NULL,
      erreur  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outils_journal ON outils_journal(nom, id DESC);
  `);
}

const egal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));

/**
 * Une IA crée (ou met à jour) un outil. Ses essais passent tous dans le bac
 * à sable, sinon rien n'est publié et le détail de chaque essai est rendu.
 */
async function creer(db, { agent, nom, description, intention, code, essais }) {
  const n = String(nom || '').trim();
  if (!NOM.test(n)) return { ok: false, erreur: 'nom : 3 à 40 caractères, minuscules, chiffres et _ , commençant par une lettre' };
  if (BASE[n]) return { ok: false, erreur: `« ${n} » est un outil de base` };
  const c = String(code || '');
  if (!c.trim() || c.length > CODE_MAX) return { ok: false, erreur: `code : le corps d’une fonction (args), ${CODE_MAX} caractères au plus` };
  const d = txt(description, 300);
  if (d.length < 10) return { ok: false, erreur: 'description : dis ce que fait l’outil' };
  const liste = Array.isArray(essais) ? essais.slice(0, ESSAIS_MAX) : [];
  if (!liste.length) return { ok: false, erreur: 'au moins un essai : { entree, attendu }' };
  const resultats = [];
  for (const e of liste) {
    const r = await BAC.executer(c, e.entree);
    const passe = r.ok && egal(r.resultat, e.attendu);
    resultats.push({ entree: e.entree, attendu: e.attendu, obtenu: r.ok ? r.resultat : undefined, erreur: r.ok ? undefined : r.erreur, passe, ms: r.ms });
  }
  if (!resultats.every(r => r.passe)) return { ok: false, erreur: 'des essais échouent : rien n’est publié', essais: resultats };
  const i = INTENTIONS.includes(intention) ? intention : 'general';
  const empreinte = crypto.createHash('sha256').update(c).digest('hex');
  const t = maintenant(), a = agentId(agent);
  const avant = db.prepare(`SELECT version, empreinte FROM outils WHERE nom = ?`).get(n);
  if (avant && avant.empreinte === empreinte) return { ok: true, outil: un(db, n), inchange: true, essais: resultats };
  db.prepare(`INSERT INTO outils(nom,version,description,intention,code,essais,empreinte,auteur,statut,cree_le,modifie_le)
    VALUES(?,?,?,?,?,?,?,?,'publie',?,?)
    ON CONFLICT(nom) DO UPDATE SET version = version + 1, description = excluded.description, intention = excluded.intention,
      code = excluded.code, essais = excluded.essais, empreinte = excluded.empreinte, auteur = excluded.auteur,
      statut = 'publie', echecs_suite = 0, modifie_le = excluded.modifie_le`)
    .run(n, 1, d, i, c, JSON.stringify(liste), empreinte, a, t, t);
  return { ok: true, outil: un(db, n), essais: resultats };
}

function un(db, nom) {
  if (BASE[nom]) { const b = BASE[nom]; return { nom: b.nom, base: true, intention: b.intention, description: b.description, usage: b.usage, statut: 'publie' }; }
  return db.prepare(`SELECT * FROM outils WHERE nom = ?`).get(String(nom)) || null;
}

/** Une IA appelle un outil par son nom. */
async function appeler(db, { agent, nom, args }) {
  const n = String(nom || '');
  if (BASE[n]) return BASE[n].appeler(args);
  const o = db.prepare(`SELECT * FROM outils WHERE nom = ?`).get(n);
  if (!o) return { ok: false, erreur: `outil inconnu : « ${n} » ; liste-les avec outils_lister, ou crée-le avec outil_creer` };
  if (o.statut !== 'publie') return { ok: false, erreur: `« ${n} » est suspendu : trop d’échecs, ou suspendu par l’humain` };
  const r = await BAC.executer(o.code, args === undefined ? null : args);
  db.prepare(`INSERT INTO outils_journal(nom,version,agent,quand,ms,ok,erreur) VALUES(?,?,?,?,?,?,?)`)
    .run(n, o.version, agentId(agent), maintenant(), r.ms, r.ok ? 1 : 0, r.ok ? null : r.erreur);
  db.prepare(`UPDATE outils SET appels = appels + 1, echecs = echecs + ?, echecs_suite = CASE WHEN ? THEN 0 ELSE echecs_suite + 1 END WHERE nom = ?`)
    .run(r.ok ? 0 : 1, r.ok ? 1 : 0, n);
  const apres = db.prepare(`SELECT echecs_suite FROM outils WHERE nom = ?`).get(n);
  if (apres.echecs_suite >= ECHECS_SUSPENSION) db.prepare(`UPDATE outils SET statut = 'suspendu' WHERE nom = ?`).run(n);
  db.prepare(`DELETE FROM outils_journal WHERE id <= (SELECT MAX(id) FROM outils_journal) - ?`).run(JOURNAL_MAX);
  return r;
}

/** Les outils utilisables : ceux de base, puis ceux publiés ; filtrés par genre de tâche si demandé. */
function lister(db, { intentions = null } = {}) {
  const garde = o => !intentions || intentions.includes(o.intention);
  const base = Object.values(BASE).filter(garde).map(b => ({ nom: b.nom, base: true, intention: b.intention, description: b.description, usage: b.usage }));
  const crees = db.prepare(`SELECT nom, version, description, intention, auteur, appels, echecs FROM outils WHERE statut = 'publie' ORDER BY appels DESC, nom`).all()
    .filter(garde).map(o => ({ ...o, usage: `outil_appeler({ nom: "${o.nom}", args })` }));
  return [...base, ...crees];
}

/** Pour l'humain : tout, code et journal compris. */
function tout(db) {
  return db.prepare(`SELECT * FROM outils ORDER BY modifie_le DESC`).all().map(o => ({
    ...o, essais: JSON.parse(o.essais),
    journal: db.prepare(`SELECT agent, quand, ms, ok, erreur FROM outils_journal WHERE nom = ? ORDER BY id DESC LIMIT 20`).all(o.nom),
  }));
}

function basculer(db, nom, actif) {
  const r = db.prepare(`UPDATE outils SET statut = ?, echecs_suite = 0, modifie_le = ? WHERE nom = ?`).run(actif ? 'publie' : 'suspendu', maintenant(), String(nom));
  return { ok: !!Number(r.changes) };
}

module.exports = { migrate, creer, appeler, lister, tout, basculer, un, BASE, INTENTIONS };
