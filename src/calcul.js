'use strict';
/* SYNAPSE — la calculatrice exacte (5.2, outil de base, fourni d'office).

   Une IA ne calcule jamais de tête : elle appelle cet outil. Il analyse
   l'expression lui-même (aucune évaluation de code) et calcule :
   - EXACTEMENT les quatre opérations et les puissances entières, en
     fractions de grands entiers : aucune erreur d'arrondi ;
   - π, e et les racines carrées à 60 chiffres : le résultat est juste sur
     au moins 40 chiffres significatifs ;
   - les puissances non entières en double précision (15 chiffres), et le
     résultat le dit.
   Il lit l'écriture française : « 324 000 », « 10,5 », × x X * · « fois »,
   « plus », « moins », « divisé par », « pi », « racine(2) », « 2^10 ».

   Même code dans DIALEKT (src/calcul.js), mêmes essais. */

const CHIFFRES = 60n;
const ECHELLE = 10n ** CHIFFRES;
/* π et e à 64 décimales, tronqués à CHIFFRES */
const PI = 'π', PI_TXT = '3.1415926535897932384626433832795028841971693993751058209749445923';
const E_TXT = '2.7182818284590452353602874713526624977572470936999595749669676277';

/* ---------- fractions de grands entiers ---------- */
const pgcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
function frac(n, d = 1n, approche = false) {
  if (d === 0n) throw new Error('division par zéro');
  if (d < 0n) { n = -n; d = -d; }
  const g = pgcd(n, d) || 1n;
  return { n: n / g, d: d / g, approche };
}
const ajouter = (a, b) => frac(a.n * b.d + b.n * a.d, a.d * b.d, a.approche || b.approche);
const soustraire = (a, b) => frac(a.n * b.d - b.n * a.d, a.d * b.d, a.approche || b.approche);
const multiplier = (a, b) => frac(a.n * b.n, a.d * b.d, a.approche || b.approche);
const diviser = (a, b) => { if (b.n === 0n) throw new Error('division par zéro'); return frac(a.n * b.d, a.d * b.n, a.approche || b.approche); };
function depuisDecimal(txt, approche = false) {
  const [ent, dec = ''] = txt.split('.');
  return frac(BigInt(ent + dec), 10n ** BigInt(dec.length), approche);
}
const constante = txt => { const [e, d] = txt.split('.'); return depuisDecimal(e + '.' + d.slice(0, Number(CHIFFRES)), true); };
/* la limite des grands nombres : au-delà, la puissance est refusée plutôt que de figer le service */
const MAX_BITS = 200000;
function puissance(a, b) {
  if (b.d === 1n) {
    let k = b.n < 0n ? -b.n : b.n;
    if (k > 10000n) throw new Error('exposant trop grand (10 000 au plus)');
    const bits = (x) => x.toString(2).length;
    if ((bits(a.n < 0n ? -a.n : a.n) + bits(a.d)) * Number(k) > MAX_BITS) throw new Error('résultat trop grand');
    let r = frac(a.n ** k, a.d ** k, a.approche);
    return b.n < 0n ? diviser(frac(1n), r) : r;
  }
  /* exposant non entier : double précision, et le résultat le dit */
  const v = Math.pow(versNombre(a), versNombre(b));
  if (!Number.isFinite(v)) throw new Error('résultat hors des nombres représentables');
  const r = depuisDecimal(v.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') || '0', true);
  r.double = true;
  return r;
}
function racine(a) {
  if (a.n < 0n) throw new Error('racine d’un nombre négatif');
  /* racine entière de n·10^(2·CHIFFRES)/d par Newton : CHIFFRES décimales justes */
  const cible = (a.n * ECHELLE * ECHELLE) / a.d;
  if (cible === 0n) return frac(0n);
  let x = BigInt(Math.floor(Math.sqrt(Number(cible)))) || 1n, y;
  for (;;) { y = (x + cible / x) / 2n; if (y >= x) break; x = y; }
  return frac(x, ECHELLE, true);
}
function versNombre(a) { return Number(a.n * 10n ** 20n / a.d) / 1e20; }

/* ---------- lecture de l'expression ---------- */
function normaliser(txt) {
  return String(txt).toLowerCase()
    .replace(/\u202f|\u00a0/g, ' ')
    .replace(/divisée? par/g, '/').replace(/multipliée? par|\bfois\b/g, '*').replace(/\bplus\b/g, '+').replace(/\bmoins\b/g, '-')
    .replace(/puissance/g, '^').replace(/\bau carré\b/g, '^2').replace(/\bau cube\b/g, '^3')
    .replace(/racine( carrée)?( de)?/g, 'racine')
    .replace(/[×·xX✕]/g, '*').replace(/÷|:/g, '/').replace(/\*\*/g, '^').replace(/−|–/g, '-')
    .replace(/\bpi\b|π/g, PI).replace(/(\d)pi|pi(\d)/g, (m, a, b) => (a ? a + '*' + PI : PI + '*' + b))
    .replace(/pi/g, PI);
}
function jetons(txt) {
  const s = normaliser(txt), out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }
    /* un nombre : chiffres, espaces de milliers (« 324 000 »), virgule ou point décimal */
    const m = /^\d{1,3}(?: \d{3})+(?:[.,]\d+)?|^\d+(?:[.,]\d+)?/.exec(s.slice(i));
    if (m) { out.push({ t: 'nb', v: depuisDecimal(m[0].replace(/ /g, '').replace(',', '.')), txt: m[0] }); i += m[0].length; continue; }
    if (c === PI) { out.push({ t: 'nb', v: constante(PI_TXT), txt: 'π' }); i++; continue; }
    if (s.startsWith('racine', i) || s.startsWith('sqrt', i) || c === '√') { out.push({ t: 'fn', v: 'racine' }); i += c === '√' ? 1 : s.startsWith('racine', i) ? 6 : 4; continue; }
    if (c === 'e' && !/[a-z]/.test(s[i + 1] || '') && !/[a-z]/.test(s[i - 1] || '')) { out.push({ t: 'nb', v: constante(E_TXT), txt: 'e' }); i++; continue; }
    if ('+-*/^()'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`caractère inattendu « ${c} »`);
  }
  return out;
}
/* analyse descendante : somme → produit → signe → puissance → atome ; la puissance passe avant le signe (-2^2 = -4) ;
   multiplication implicite « 2π », « 3(4+1) » */
function analyser(txt) {
  const j = jetons(txt);
  if (!j.length) throw new Error('expression vide');
  let p = 0;
  const voir = () => j[p], prendre = () => j[p++];
  function somme() {
    let a = produit();
    while (voir() && (voir().t === '+' || voir().t === '-')) { const o = prendre().t, b = produit(); a = o === '+' ? ajouter(a, b) : soustraire(a, b); }
    return a;
  }
  function produit() {
    let a = signe();
    for (;;) {
      const t = voir();
      if (t && (t.t === '*' || t.t === '/')) { prendre(); const b = signe(); a = t.t === '*' ? multiplier(a, b) : diviser(a, b); }
      else if (t && (t.t === 'nb' || t.t === '(' || t.t === 'fn')) a = multiplier(a, puiss());      /* implicite */
      else return a;
    }
  }
  function signe() { if (voir() && voir().t === '-') { prendre(); const a = signe(); return frac(-a.n, a.d, a.approche); } if (voir() && voir().t === '+') { prendre(); return signe(); } return puiss(); }
  function puiss() { const a = atome(); if (voir() && voir().t === '^') { prendre(); return puissance(a, signe()); } return a; }
  function atome() {
    const t = prendre();
    if (!t) throw new Error('expression incomplète');
    if (t.t === 'nb') return t.v;
    if (t.t === 'fn') return racine(atome());
    if (t.t === '(') { const a = somme(); if (!voir() || prendre().t !== ')') throw new Error('parenthèse non fermée'); return a; }
    throw new Error(`« ${t.t} » mal placé`);
  }
  const r = somme();
  if (p < j.length) throw new Error(`« ${j[p].t === 'nb' ? j[p].txt : j[p].t} » mal placé`);
  return r;
}

/* ---------- présentation ---------- */
function decimal(a, chiffres) {
  const neg = a.n < 0n, n = neg ? -a.n : a.n;
  const ent = n / a.d;
  let reste = n % a.d, dec = '';
  for (let k = 0; k < chiffres && reste; k++) { reste *= 10n; dec += (reste / a.d).toString(); reste %= a.d; }
  return { signe: neg ? '-' : '', ent: ent.toString(), dec, exact: reste === 0n };
}
const groupe = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/**
 * Calcule une expression. Rend la valeur en décimal (30 chiffres après la
 * virgule au plus), sa lecture française, et dit si elle est exacte.
 */
function calculer(expression, { decimales = 30 } = {}) {
  const txt = String(expression || '').trim();
  if (!txt) return { ok: false, erreur: 'expression vide' };
  if (txt.length > 500) return { ok: false, erreur: 'expression trop longue (500 caractères au plus)' };
  try {
    const r = analyser(txt);
    const d = decimal(r, decimales);
    const lisible = d.signe + groupe(d.ent) + (d.dec ? ',' + d.dec.slice(0, 10).replace(/0+$/, '') : '');
    const precision = r.double ? 'double précision (15 chiffres significatifs)'
      : r.approche ? 'π, e ou racine pris à 60 chiffres : au moins 40 chiffres significatifs justes'
      : d.exact ? 'exact' : `exact, développement décimal coupé à ${decimales} chiffres`;
    return {
      ok: true, expression: txt,
      valeur: d.signe + d.ent + (d.dec ? '.' + d.dec : ''),
      lisible: lisible + (d.dec.length > 10 || !d.exact || r.approche ? '…' : ''),
      fraction: !r.approche && r.d !== 1n ? `${r.n}/${r.d}` : undefined,
      precision,
    };
  } catch (e) {
    return { ok: false, expression: txt, erreur: e.message };
  }
}

/* Les calculs écrits dans une phrase : « combien font 10XpiX324000 ? » → [« 10XpiX324000 »]. */
function trouverCalculs(phrase) {
  const s = String(phrase || '');
  /* dans une phrase, un « e » isolé est un mot (« et », « e-mail ») : la constante e n'est prise qu'en calcul direct */
  const motif = /(?:racine\s*(?:carrée\s*)?(?:de\s*)?|√)?[(\d][\d\s.,()+\-*/^×xX·÷:πpiPI√−–]*(?:fois|plus|moins|divisée? par|multipliée? par|puissance|au carré|au cube)?(?:[\s\d.,()+\-*/^×xX·÷:πpiPI√−–]*[\d)πiI])?/g;
  const vus = new Set(), out = [];
  for (const m of s.matchAll(motif)) {
    const brut = m[0].trim();
    if (!/[+\-*/^×xX·÷:√π]|pi|fois|plus|moins|par|puissance|carré|cube|racine/i.test(brut.replace(/^\d{1,3}( \d{3})+$/, ''))) continue;   /* un nombre seul n'est pas un calcul */
    if (/^\d{1,2}[/:]\d{1,2}([/:]\d{2,4})?$/.test(brut)) continue;                                                            /* une date ou une heure */
    const r = calculer(brut);
    if (r.ok && !vus.has(r.valeur)) { vus.add(r.valeur); out.push(r); }
  }
  return out;
}

module.exports = { calculer, trouverCalculs };
