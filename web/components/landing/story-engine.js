/**
 * The home page's 3D story: 30 days of hourly Texas power prices as a field
 * of bars, filmed by a camera that moves through four chapters as the page
 * scrolls (market, futures, options, hedge). The landscape can also be turned
 * all the way round by dragging; it eases back to the chapter's framing when
 * the chapter changes.
 *
 * Plain DOM and three.js, mounted into markup that components/landing/story.tsx
 * renders. mountStory() returns a function that stops and frees everything.
 */
import Lenis from 'lenis';
import * as THREE from 'three';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (t) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const usd = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hh = (h) => `${h < 10 ? '0' : ''}${h}:00`;

/**
 * @param {HTMLElement} root   the story section
 * @param {{ days: { dayKey: number, hours: number[] }[] }} data  hourly prices in cents, oldest day first
 * @returns {() => void} cleanup
 */
export function mountStory(root, data) {
  const $ = (sel) => root.querySelector(sel);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let calm = REDUCED;

  const DATA = data.days.map((d) => ({ dayKey: d.dayKey, p: d.hours.slice(0, 24).map((c) => c / 100) }));
  const nD = DATA.length;
  const nH = 24;
  const N = nD * nH;
  const TODAY = DATA[nD - 1].p;
  const ALL = DATA.flatMap((d) => d.p);
  let lowH = 0;
  let highH = 0;
  TODAY.forEach((v, i) => {
    if (v < TODAY[lowH]) lowH = i;
    if (v > TODAY[highH]) highH = i;
  });
  $('[data-f="low"]').textContent = usd(TODAY[lowH]);
  $('[data-f="low-h"]').textContent = `at ${hh(lowH)}`;
  $('[data-f="high"]').textContent = usd(TODAY[highH]);
  $('[data-f="high-h"]').textContent = `at ${hh(highH)}`;
  $('[data-f="peak"]').textContent = `Peak ${usd(TODAY[highH])} at ${hh(highH)}`;

  const canvas = $('canvas.scene');
  const story = root;
  const disposers = [];
  const on = (el, ev, fn, opt) => {
    el.addEventListener(ev, fn, opt);
    disposers.push(() => el.removeEventListener(ev, fn, opt));
  };

  /* smooth scrolling for this page only */
  let lenis = null;
  if (!REDUCED) {
    try {
      lenis = new Lenis({ lerp: 0.085, smoothWheel: true, autoRaf: false });
    } catch {
      lenis = null;
    }
  }
  const scrollToY = (y) => {
    if (lenis) lenis.scrollTo(y, { duration: 1.4 });
    else window.scrollTo({ top: y, behavior: REDUCED ? 'auto' : 'smooth' });
  };

  let stage = 0;
  let target = 0;
  let strike = 45;
  let dirty = true;
  const t0 = performance.now();
  const H = (p) => Math.max(0.06, Math.min(p, 120)) * 0.15;
  const X = (h) => h - 11.5;
  const Z = (d) => d - (nD - 1) / 2;
  const KEYS = [
    { p: [34, 30, 42], t: [0, 3, 0] },
    { p: [0, 7, Z(nD - 1) + 40], t: [0, 5.5, Z(nD - 1)] },
    { p: [0, 58, 24], t: [0, 0, 0] },
    { p: [-38, 22, 34], t: [0, 3, 0] },
  ];

  let renderer = null;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch {
    renderer = null;
  }
  const ok = Boolean(renderer);
  let scene;
  let camera;
  let mesh;
  let plane;
  let edge;
  const dummy = new THREE.Object3D();
  const colA = new THREE.Color();
  const colB = new THREE.Color();
  const cTmp = new THREE.Color();
  if (ok) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 1);
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x000000, 55, 120);
    camera = new THREE.PerspectiveCamera(30, 1, 0.1, 400);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x0a0a0a, 0.62));
    const key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(18, 40, 26);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.25);
    rim.position.set(-30, 12, -20);
    scene.add(rim);
    const geo = new THREE.BoxGeometry(0.8, 1, 0.8);
    geo.translate(0, 0.5, 0);
    mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.04 }), N);
    scene.add(mesh);
    const pg = new THREE.PlaneGeometry(26, nD + 2);
    pg.rotateX(-Math.PI / 2);
    plane = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: 0xf3f2ee, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    edge = new THREE.LineSegments(new THREE.EdgesGeometry(pg), new THREE.LineBasicMaterial({ color: 0xf3f2ee, transparent: true, opacity: 0 }));
    scene.add(plane);
    scene.add(edge);
  }
  const C = {
    low: new THREE.Color('#262626'),
    high: new THREE.Color(css('--paper') || '#f3f2ee'),
    gain: new THREE.Color(css('--gain') || '#35d39a'),
    loss: new THREE.Color(css('--loss') || '#ff6470'),
    volt: new THREE.Color(css('--volt') || '#f4b860'),
    dim: new THREE.Color('#141414'),
  };

  function stageVals(s) {
    const w1 = clamp(1 - Math.abs(s - 1), 0, 1);
    const w2 = clamp(1 - Math.abs(s - 2), 0, 1) + clamp(s - 2, 0, 1) * 0.55;
    const w3 = smooth(clamp(s - 2, 0, 1));
    const pv = smooth(clamp((s - 1.25) / 0.6, 0, 1));
    return { w1, w2: clamp(w2, 0, 1), w3, pv };
  }
  function updateBars(s) {
    const v = stageVals(s);
    const sh = H(strike);
    for (let d = 0; d < nD; d++) {
      const today = d === nD - 1;
      for (let h = 0; h < nH; h++) {
        const i = d * nH + h;
        const p = DATA[d].p[h];
        const ht = lerp(H(p), sh, v.w3 * 0.94);
        dummy.position.set(X(h), 0, Z(d));
        dummy.scale.set(1, ht, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        colA.copy(C.low).lerp(C.high, smooth(clamp(p / 85, 0, 1)) * 0.92);
        if (today && h === highH) colA.lerp(C.volt, 1 - v.w2);
        colB.copy(p >= strike ? C.gain : C.loss);
        cTmp.copy(colA).lerp(colB, v.w2 * 0.85);
        if (!today) cTmp.lerp(C.dim, v.w1 * 0.86);
        mesh.setColorAt(i, cTmp);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    plane.position.y = sh;
    edge.position.y = sh;
    plane.material.opacity = 0.075 * v.pv;
    edge.material.opacity = 0.55 * v.pv;
  }

  const size = { w: 1, h: 1, narrow: false };
  function resize() {
    if (!ok) return;
    const r = canvas.getBoundingClientRect();
    size.w = Math.max(1, r.width);
    size.h = Math.max(1, r.height);
    size.narrow = size.w < 760;
    renderer.setSize(size.w, size.h, false);
    camera.aspect = size.w / size.h;
    if (!size.narrow) camera.setViewOffset(size.w, size.h, -size.w * 0.17, 0, size.w, size.h);
    else camera.setViewOffset(size.w, size.h, 0, size.h * 0.14, size.w, size.h);
    camera.updateProjectionMatrix();
    dirty = true;
  }
  on(window, 'resize', resize);

  function progress() {
    const r = story.getBoundingClientRect();
    const span = Math.max(1, story.offsetHeight - window.innerHeight);
    return clamp(-r.top / span, 0, 1) * 3;
  }
  function chapterTo(k) {
    const top = story.getBoundingClientRect().top + window.scrollY;
    const span = story.offsetHeight - window.innerHeight;
    scrollToY(top + span * (k / 3) + 1);
  }

  const chapters = root.querySelectorAll('.chapter');
  const chips = root.querySelectorAll('.chips button');
  let active = 0;
  function setChapter(k) {
    if (k === active) return;
    active = k;
    chapters.forEach((c) => c.classList.toggle('on', Number(c.dataset.ch) === k));
    chips.forEach((b) => {
      if (Number(b.dataset.go) === k) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    });
  }
  root.querySelectorAll('[data-go]').forEach((b) => on(b, 'click', () => chapterTo(Number(b.dataset.go))));

  const sIn = $('[data-f="strike"]');
  const sOut = $('[data-f="strike-out"]');
  function strikeText() {
    const above = ALL.filter((v) => v >= strike).length;
    $('[data-f="strike-v"]').textContent = `$${strike}`;
    sOut.innerHTML = `In the last ${nD} days the price was above $${strike} in <span class="g">${above} of ${ALL.length} hours</span>, when a call pays, and below it in <span class="l">${ALL.length - above}</span>, when a put pays.`;
  }
  on(sIn, 'input', () => {
    strike = Number(sIn.value);
    strikeText();
    dirty = true;
  });
  strikeText();

  const tagPeak = $('[data-f="tag-peak"]');
  const tagStrike = $('[data-f="tag-strike"]');
  const pv3 = new THREE.Vector3();
  function placeTag(el, x, y, z, vis) {
    if (!ok) return;
    const v = pv3.set(x, y, z).project(camera);
    let sx = ((v.x + 1) / 2) * size.w;
    const sy = ((1 - v.y) / 2) * size.h;
    const half = (el.offsetWidth || 160) / 2 + 12;
    sx = clamp(sx, half, size.w - half);
    el.style.transform = `translate(${Math.round(sx)}px,${Math.round(sy)}px) translate(-50%,-140%)`;
    el.style.opacity = vis > 0.02 && v.z < 1 ? String(Math.min(1, vis)) : '0';
  }

  /* free look */
  const look = { yaw: 0, pitch: 0, vy: 0, vp: 0, drag: null, chap: 0, back: false, used: false };
  const sph = new THREE.Spherical();
  const lv = new THREE.Vector3();
  const lt = new THREE.Vector3();
  const hint = $('[data-f="dhint"]');
  const resetBtn = $('[data-f="reset-look"]');
  if (window.matchMedia('(pointer: coarse)').matches) $('[data-f="dhint-t"]').textContent = 'Swipe sideways to turn';
  on(canvas, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    look.drag = { x: e.clientX, y: e.clientY };
    look.back = false;
    look.vy = 0;
    look.vp = 0;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture is optional */
    }
    canvas.classList.add('turning');
  });
  on(canvas, 'pointermove', (e) => {
    if (!look.drag) return;
    const dx = e.clientX - look.drag.x;
    const dy = e.clientY - look.drag.y;
    look.drag.x = e.clientX;
    look.drag.y = e.clientY;
    const touch = e.pointerType === 'touch';
    look.yaw -= dx * 0.0048;
    look.pitch = clamp(look.pitch + (touch ? 0 : dy * 0.004), -0.55, 0.65);
    look.vy = -dx * 0.0048;
    look.vp = touch ? 0 : dy * 0.004;
    if (!look.used && Math.abs(dx) + Math.abs(dy) > 2) {
      look.used = true;
      hint.classList.add('gone');
    }
  });
  const endLook = () => {
    if (!look.drag) return;
    look.drag = null;
    canvas.classList.remove('turning');
  };
  on(canvas, 'pointerup', endLook);
  on(canvas, 'pointercancel', endLook);
  on(canvas, 'lostpointercapture', endLook);
  const lookBack = () => {
    look.yaw = Math.atan2(Math.sin(look.yaw), Math.cos(look.yaw));
    look.back = true;
    look.vy = 0;
    look.vp = 0;
  };
  on(resetBtn, 'click', lookBack);
  function stepLook(dt, chap) {
    if (chap !== look.chap) {
      look.chap = chap;
      if (look.yaw || look.pitch) lookBack();
    }
    if (!look.drag) {
      if (look.back) {
        const e = Math.exp(-dt * 3.2);
        look.yaw *= e;
        look.pitch *= e;
        if (Math.abs(look.yaw) < 0.002 && Math.abs(look.pitch) < 0.002) {
          look.yaw = 0;
          look.pitch = 0;
          look.back = false;
        }
      } else if (!calm && (Math.abs(look.vy) > 0.0002 || Math.abs(look.vp) > 0.0002)) {
        const f60 = dt * 60;
        const d = Math.pow(0.93, f60);
        look.yaw += look.vy * f60;
        look.pitch = clamp(look.pitch + look.vp * f60, -0.55, 0.65);
        look.vy *= d;
        look.vp *= d;
      }
    }
    resetBtn.hidden = !(Math.abs(look.yaw) > 0.05 || Math.abs(look.pitch) > 0.05) || look.back;
  }

  let last = performance.now();
  let lastStage = -1;
  let raf = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (lenis) lenis.raf(now);
    target = progress();
    stage = calm ? target : stage + (target - stage) * (1 - Math.exp(-dt * 5.5));
    setChapter(Math.round(clamp(target, 0, 3)));
    if (ok) {
      const a = Math.floor(clamp(stage, 0, 2.999));
      const f = smooth(stage - a);
      const A = KEYS[a];
      const B = KEYS[a + 1];
      const sway = calm ? 0 : Math.sin((now - t0) / 5200) * 2.4 * (1 - clamp(stage, 0, 1));
      const k = size.narrow ? 1.7 : 1;
      camera.position.set(lerp(A.p[0], B.p[0], f) * k + sway, lerp(A.p[1], B.p[1], f) * k, lerp(A.p[2], B.p[2], f) * k);
      lt.set(lerp(A.t[0], B.t[0], f), lerp(A.t[1], B.t[1], f), lerp(A.t[2], B.t[2], f));
      stepLook(dt, Math.round(clamp(target, 0, 3)));
      if (look.yaw || look.pitch) {
        sph.setFromVector3(lv.copy(camera.position).sub(lt));
        sph.theta += look.yaw;
        sph.phi = clamp(sph.phi - look.pitch, 0.06, Math.PI / 2 - 0.03);
        camera.position.copy(lt).add(lv.setFromSpherical(sph));
      }
      camera.lookAt(lt);
      if (dirty || Math.abs(stage - lastStage) > 0.0005) {
        updateBars(stage);
        lastStage = stage;
        dirty = false;
      }
      renderer.render(scene, camera);
      const v = stageVals(stage);
      placeTag(tagPeak, X(highH), H(TODAY[highH]) + 0.6, Z(nD - 1), 1 - clamp(stage - 1, 0, 1));
      placeTag(tagStrike, X(23) + 1.5, H(strike), Z(nD - 1) + 1, v.pv * (1 - v.w3 * 0.7));
      tagStrike.textContent = `Strike $${strike}`;
    }
    raf = requestAnimationFrame(frame);
  }

  const calmBtn = $('[data-f="calm"]');
  const setCalmText = () => {
    calmBtn.setAttribute('aria-pressed', String(calm));
    calmBtn.textContent = calm ? 'Play motion' : 'Pause motion';
  };
  on(calmBtn, 'click', () => {
    calm = !calm;
    setCalmText();
  });
  setCalmText();

  resize();
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    disposers.forEach((d) => d());
    if (lenis) lenis.destroy();
    if (ok) {
      mesh.geometry.dispose();
      mesh.material.dispose();
      plane.geometry.dispose();
      plane.material.dispose();
      edge.geometry.dispose();
      edge.material.dispose();
      renderer.dispose();
    }
  };
}
