'use strict';
/* SYNAPSE — socle commun des écrans (v4.3).
   Session, onglets, appels au serveur, flux d'activité et couleurs des
   cerveaux (les mêmes que la mémoire). Chaque écran ne porte que sa
   visualisation ; toute donnée vient d'ici, donc du serveur. */
const ECRAN = (() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtMs = ms => ms == null ? '—' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s';
  const fmtN = v => v == null ? '—' : Number(v).toLocaleString('fr-FR');
  const heure = t => new Date(t || Date.now()).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  /* la page n'est servie qu'à une session complète ; on le revérifie */
  (() => {
    try {
      const x = new XMLHttpRequest(); x.open('GET', '/api/compte/etat', false); x.send(null);
      const j = JSON.parse(x.responseText);
      if (!j.session || j.session.niveau !== 'complet' || j.assistant?.doit) location.replace('/connexion');
    } catch { location.replace('/connexion'); }
  })();

  const ECRANS = [['/', 'MÉMOIRE'], ['/pipeline', 'PIPELINE'], ['/confiance', 'CONFIANCE'], ['/signaux', 'SIGNAUX'], ['/cerveau', 'SECOND CERVEAU'],
    ['/agents', 'AGENTS'], ['/orbital', 'ORBITAL'], ['/journal', 'JOURNAL'], ['/essaim', 'ESSAIM'], ['/flux', 'FLUX']];
  function onglets(el) {
    el.innerHTML = ECRANS.map(([h, n]) => '<a href="' + h + '"' + (location.pathname === h ? ' class="ici"' : '') + '>' + n + '</a>').join('');
  }

  async function api(chemin) {
    const r = await fetch(chemin, { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/connexion'; throw new Error('session'); }
    if (!r.ok) throw new Error(chemin + ' : HTTP ' + r.status);
    return r.json();
  }

  /* l'arbre des cerveaux et leurs couleurs : palette et nuances de la mémoire */
  const PALETTE = ['#3fe8a8', '#b18cff', '#ffb45e', '#5cc8ff', '#ff5c7a', '#e6e070', '#7aa2ff', '#ff9ad5'];
  function nuance(hex, k, n) {
    if (n <= 1) return hex;
    const c = parseInt(hex.slice(1), 16), r = c >> 16, g = (c >> 8) & 255, b = c & 255, f = 1 + ((k / (n - 1)) - .5) * .44;
    const m = v => Math.max(0, Math.min(255, Math.round(v * f)));
    return '#' + [m(r), m(g), m(b)].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  async function hierarchie() {
    const h = await api('/v1/hierarchie');
    const a = h.comptes && h.comptes[0];
    const cerveaux = new Map(), domaines = [];
    if (!a) return { cerveaux, domaines, global: null };
    const racines = a.domaines.filter(d => !d.parent_id);
    const coulDom = new Map();
    racines.forEach((d, i) => coulDom.set(d.id, PALETTE[i % PALETTE.length]));
    for (const d of a.domaines) {
      let r = d; while (r.parent_id) r = a.domaines.find(x => x.id === r.parent_id) || { parent_id: null, id: r.id };
      const coul = coulDom.get(r.id) || '#9aa3b2';
      domaines.push({ ...d, coul });
      cerveaux.set(d.commun.id, { id: d.commun.id, nom: d.nom, n: d.commun.n, coul, commun: true, domaine: d.id, parent: d.parent_id });
      d.membres.forEach((m, k) => cerveaux.set(m.id, { id: m.id, nom: m.nom, n: m.n, coul: nuance(coul, k, d.membres.length), commun: false, domaine: d.id }));
    }
    if (a.global) cerveaux.set(a.global.id, { id: a.global.id, nom: 'global', n: a.global.n, coul: '#ffffff', global: true });
    return { cerveaux, domaines, global: a.global ? a.global.id : null, arbre: a };
  }
  /* la couleur d'une source = celle de son cerveau (le cerveau membre porte son nom) */
  const couleurSource = (H, src) => { for (const c of H.cerveaux.values()) if (!c.commun && c.nom === src) return c.coul; return '#9aa3b2'; };

  /* le flux d'activité en direct (v4.0) */
  function flux(sur) {
    if (typeof EventSource === 'undefined') return null;
    const es = new EventSource('/v1/flux');
    es.addEventListener('lot', m => { try { for (const e of JSON.parse(m.data)) sur.evenement && sur.evenement(e); } catch (err) { console.warn('flux : lot illisible', err); } });
    es.addEventListener('etat', m => { try { sur.etat && sur.etat(JSON.parse(m.data)); } catch (err) { console.warn('flux : état illisible', err); } });
    es.onerror = () => sur.coupe && sur.coupe();
    return es;
  }

  function journal(el, txt, tag, max = 10) {
    if (el.querySelector('.vide')) el.innerHTML = '';
    el.insertAdjacentHTML('afterbegin', '<div><em>' + heure() + '</em> ' + (tag ? '<span>' + esc(tag) + '</span> ' : '') + esc(txt) + '</div>');
    while (el.children.length > max) el.lastChild.remove();
  }
  const barres = (lignes, max) => lignes.map(([k, v, c, suffixe]) => '<div class="ligne"><span title="' + esc(k) + '">' + esc(k) + '</span><i><b style="width:' +
    (max ? Math.max(1.5, 100 * v / max) : 0) + '%;background:' + c + '"></b></i><em>' + (suffixe != null ? suffixe : fmtN(v)) + '</em></div>').join('');
  function spark(c, vals, coul, opts = {}) {
    if (!c) return; const x = c.getContext('2d'), W = c.width, H = c.height; x.clearRect(0, 0, W, H);
    if (vals.length < 2) { x.fillStyle = '#5a5566'; x.font = '16px monospace'; x.fillText(opts.vide || 'pas encore de mesure', 8, H / 2); return; }
    const m = Math.max(1e-9, ...vals); x.strokeStyle = coul; x.lineWidth = opts.epais || 2.2; x.shadowColor = coul; x.shadowBlur = 8; x.beginPath();
    vals.forEach((v, i) => { const px = W * i / (vals.length - 1), py = H - 6 - (H - 12) * v / m; i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke(); x.shadowBlur = 0;
  }
  /* un canvas à la taille de son élément, net sur écran Retina */
  function ajuster(cv) {
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); return { g, W: r.width, H: r.height };
  }
  /* graine reproductible : une même entrée tombe toujours au même endroit */
  const hash01 = k => { const x = Math.sin(k * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

  return { $, esc, fmtMs, fmtN, heure, onglets, api, hierarchie, couleurSource, flux, journal, barres, spark, ajuster, hash01, PALETTE };
})();
