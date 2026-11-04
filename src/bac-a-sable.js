'use strict';
/* SYNAPSE — le bac à sable des outils créés par les IA (5.2).

   Un outil est du code écrit par une IA, exécuté sur la machine de
   l'utilisateur. Trois barrières, l'une derrière l'autre :

   1. Un monde vide. Le code tourne dans un contexte `vm` sans require,
      sans process, sans fetch ni minuteries ; la génération de code à la
      volée y est interdite (eval, new Function), ce qui ferme la voie
      classique pour sortir du contexte. Les données entrent et sortent en
      TEXTE JSON : aucun objet de l'extérieur n'entre dans ce monde.
   2. Un processus à part : `node --permission` (ni fichiers, ni autres
      programmes, ni workers), environnement vide, 64 Mo, 2 s, tué au-delà.
      Le modèle de permissions de Node 24 ne bloque PAS le réseau : le
      processus retire donc lui-même, avant de lancer le code, fetch,
      WebSocket et les accès aux modules (getBuiltinModule, binding).
   3. Les essais : un outil n'est publié que si ses propres cas d'essai
      passent ; il est suspendu après cinq échecs de suite (registre).

   Ce que cela ne garantit pas : une faille du moteur JavaScript lui-même
   qui permettrait de sortir du contexte `vm` puis de retrouver un accès
   réseau malgré la barrière 2. Pour cela, il faudrait un conteneur sans
   réseau dédié aux outils ; c'est noté au relevé. */

const { spawn } = require('node:child_process');

const TEMPS_MS = 2000, MEMOIRE_MO = 64, SORTIE_MAX = 64 * 1024, PARALLELE = 2;

/* Le programme du processus enfant, passé en -e : il n'a rien à lire sur le disque. */
const ENFANT = String.raw`
'use strict';
const vm = require('node:vm');
/* barrière 2 : plus de réseau ni de modules, avant même de lire la demande */
for (const k of ['fetch', 'WebSocket', 'EventSource', 'Request', 'Response', 'Headers', 'FormData', 'XMLHttpRequest', 'navigator'])
  try { delete globalThis[k]; } catch {}
for (const k of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'mainModule', 'kill', 'chdir'])
  try { process[k] = undefined; } catch {}
let entree = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { entree += d; if (entree.length > 300000) { process.stdout.write(JSON.stringify({ ok: false, erreur: 'entrée trop grande' })); process.exit(0); } });
process.stdin.on('end', () => {
  let rep;
  try {
    const { code, args, tempsMs } = JSON.parse(entree);
    /* barrière 1 : un monde vide, sans génération de code */
    const monde = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, name: 'outil' });
    vm.runInContext('globalThis.__args = undefined;', monde);
    monde.__args = JSON.stringify(args === undefined ? null : args);
    const script = '"use strict";\n(() => { const __outil = function (args) {\n' + code + '\n};\nconst __r = __outil(JSON.parse(__args));\nif (__r && typeof __r.then === "function") throw new Error("un outil est synchrone : pas de promesse");\nreturn JSON.stringify(__r === undefined ? null : __r); })()';
    const sortie = vm.runInContext(script, monde, { timeout: tempsMs, microtaskMode: 'afterEvaluate', displayErrors: false });
    rep = { ok: true, resultat: typeof sortie === 'string' ? sortie : 'null' };
  } catch (e) {
    rep = { ok: false, erreur: String(e && e.message || e).slice(0, 500) };
  }
  process.stdout.write(JSON.stringify(rep));
  process.exit(0);
});
`;

let enCours = 0;
const attente = [];
function place() { return new Promise(r => { if (enCours < PARALLELE) { enCours++; r(); } else attente.push(r); }); }
function libere() { const n = attente.shift(); if (n) n(); else enCours--; }

/**
 * Exécute `code` (le corps d'une fonction (args) qui rend une valeur JSON)
 * dans le bac à sable. Rend { ok, resultat, ms } ou { ok: false, erreur, ms }.
 */
async function executer(code, args, { tempsMs = TEMPS_MS, memoireMo = MEMOIRE_MO } = {}) {
  await place();
  const t0 = Date.now();
  try {
    return await new Promise(fin => {
      const p = spawn(process.execPath, ['--permission', `--max-old-space-size=${memoireMo}`, '--disable-warning=ExperimentalWarning', '-e', ENFANT],
        { env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let sortie = '', fini = false;
      const terminer = r => { if (fini) return; fini = true; clearTimeout(minuteur); try { p.kill('SIGKILL'); } catch {} fin({ ...r, ms: Date.now() - t0 }); };
      const minuteur = setTimeout(() => terminer({ ok: false, erreur: `délai dépassé (${tempsMs} ms)` }), tempsMs + 1500);
      p.stdout.on('data', d => { sortie += d; if (sortie.length > SORTIE_MAX + 200) terminer({ ok: false, erreur: 'résultat trop grand' }); });
      p.on('error', e => terminer({ ok: false, erreur: 'bac à sable indisponible : ' + e.message }));
      p.on('close', () => {
        if (fini) return;
        let r;
        try { r = JSON.parse(sortie); } catch { return terminer({ ok: false, erreur: 'le bac à sable s’est arrêté sans réponse (mémoire dépassée ?)' }); }
        if (!r.ok) return terminer(r);
        if (r.resultat.length > SORTIE_MAX) return terminer({ ok: false, erreur: 'résultat trop grand' });
        terminer({ ok: true, resultat: JSON.parse(r.resultat) });
      });
      p.stdin.end(JSON.stringify({ code: String(code), args, tempsMs }));
    });
  } finally { libere(); }
}

module.exports = { executer, TEMPS_MS, MEMOIRE_MO };
