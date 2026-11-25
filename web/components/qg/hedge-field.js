/**
 * The hedge screen's 3D model: a field of bars, one column per settlement
 * price and one row per hedge level, each bar the day's cost (or revenue) at
 * that price and level. As the hedge grows the rows flatten; your plan's row
 * is green and the unhedged row red. Drag to turn it, point at a bar to read it.
 *
 * mountField(root, { read }) returns { update, destroy }. update() takes the
 * bar heights (rows x cols, 0..1 of the tallest possible bar) and the plan's row.
 */
import * as THREE from 'three';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (t) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};

export const FIELD = { cols: 25, rows: 21, p0: 0, p1: 150 };

export function mountField(root, opts) {
  const cvs = root.querySelector('canvas');
  const tagsEl = root.querySelector('[data-f="tags"]');
  const readEl = opts.readEl;
  let r;
  try {
    r = new THREE.WebGLRenderer({ canvas: cvs, antialias: true });
  } catch {
    return { update() {}, destroy() {} };
  }
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  r.setClearColor(0x050505, 1);
  const sc = new THREE.Scene();
  sc.fog = new THREE.Fog(0x050505, 70, 130);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 300);
  sc.add(new THREE.HemisphereLight(0xffffff, 0x0a0a0a, 0.62));
  const kl = new THREE.DirectionalLight(0xffffff, 0.95);
  kl.position.set(18, 40, 26);
  sc.add(kl);
  const rl = new THREE.DirectionalLight(0xffffff, 0.25);
  rl.position.set(-30, 12, -20);
  sc.add(rl);
  const { cols: NC, rows: NR, p0: P0, p1: P1 } = FIELD;
  const DX = 1.15;
  const DZ = 0.78;
  const YS = 9;
  const N = NC * NR;
  const PofC = (c) => P0 + ((P1 - P0) * c) / (NC - 1);
  const X = (c) => (c - (NC - 1) / 2) * DX;
  const Z = (rw) => (rw - (NR - 1) / 2) * DZ;
  const g = new THREE.BoxGeometry(DX * 0.78, 1, DZ * 0.72);
  g.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.04 });
  const mesh = new THREE.InstancedMesh(g, mat, N);
  sc.add(mesh);
  const o = new THREE.Object3D();
  const cT = new THREE.Color();
  const cLow = new THREE.Color('#262626');
  const cHigh = new THREE.Color('#f3f2ee');
  const cG = new THREE.Color('#35d39a');
  const cL = new THREE.Color('#ff6470');
  const cDim = new THREE.Color('#141414');
  const hotCol = new THREE.Color('#f3f2ee');
  const cur = new Float32Array(N);
  const tgt = new Float32Array(N);
  let first = true;
  let planRow = NR - 1;
  const w = ((NC - 1) / 2) * DX + DX * 0.6;
  const d = ((NR - 1) / 2) * DZ + DZ * 0.6;
  const frameGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-w, 0, -d),
    new THREE.Vector3(w, 0, -d),
    new THREE.Vector3(w, 0, d),
    new THREE.Vector3(-w, 0, d),
  ]);
  const frameMat = new THREE.LineBasicMaterial({ color: 0x2f2f2f });
  sc.add(new THREE.LineLoop(frameGeo, frameMat));

  function apply() {
    for (let rw = 0; rw < NR; rw++)
      for (let c = 0; c < NC; c++) {
        const i = rw * NC + c;
        o.position.set(X(c), 0, Z(rw));
        o.scale.set(1, Math.max(0.05, cur[i] * YS), 1);
        o.updateMatrix();
        mesh.setMatrixAt(i, o.matrix);
        cT.copy(cLow).lerp(cHigh, 0.1 + smooth(clamp(cur[i], 0, 1)) * 0.78);
        if (rw === planRow) cT.copy(cG);
        else if (rw === 0) cT.lerp(cL, 0.85);
        else cT.lerp(cDim, 0.25);
        mesh.setColorAt(i, cT);
      }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  const TAGS = [];
  const v3 = new THREE.Vector3();
  function tag(text, fn, color) {
    const el = document.createElement('span');
    el.className = 'tag';
    el.textContent = text;
    if (color) {
      el.style.color = color;
      el.style.borderColor = 'rgba(53,211,154,.4)';
    }
    tagsEl.appendChild(el);
    TAGS.push({ el, fn });
  }
  [0, 50, 100, 150].forEach((P) => tag(`$${P}`, () => v3.set(X(((P - P0) / (P1 - P0)) * (NC - 1)), 0, d + 1.1)));
  tag('No hedge', () => v3.set(-w - 2.4, 0, Z(0)));
  tag('Fully hedged', () => v3.set(-w - 2.8, 0, Z(NR - 1)));
  tag('Your plan', () => v3.set(w + 2.4, cur[planRow * NC + NC - 1] * YS + 0.4, Z(planRow)), '#35d39a');

  let W = 1;
  let Hh = 1;
  let narrow = false;
  function resize() {
    const b = root.getBoundingClientRect();
    W = Math.max(1, b.width);
    Hh = Math.max(1, b.height);
    narrow = W < 620;
    r.setSize(W, Hh, false);
    cam.aspect = W / Hh;
    cam.updateProjectionMatrix();
  }
  let yaw = 0.42;
  let pitch = 0.5;
  let drag = null;
  const t0 = performance.now();
  let hoverP = null;
  const onDown = (e) => {
    drag = { x: e.clientX, y: e.clientY, yaw, pitch };
    try {
      cvs.setPointerCapture(e.pointerId);
    } catch {
      /* optional */
    }
    hRead(-1);
  };
  const onMove = (e) => {
    const b = cvs.getBoundingClientRect();
    if (drag) {
      yaw = drag.yaw - (e.clientX - drag.x) * 0.007;
      pitch = clamp(drag.pitch + (e.clientY - drag.y) * 0.005, 0.12, 1.25);
      return;
    }
    hoverP = { x: ((e.clientX - b.left) / b.width) * 2 - 1, y: -((e.clientY - b.top) / b.height) * 2 + 1 };
  };
  const onUp = () => {
    drag = null;
  };
  const onLeave = () => {
    hoverP = null;
    hRead(-1);
  };
  cvs.addEventListener('pointerdown', onDown);
  cvs.addEventListener('pointermove', onMove);
  cvs.addEventListener('pointerup', onUp);
  cvs.addEventListener('pointercancel', onUp);
  cvs.addEventListener('pointerleave', onLeave);
  window.addEventListener('resize', resize);
  const ray = new THREE.Raycaster();
  const v2 = new THREE.Vector2();
  let hot = -1;
  function hRead(id) {
    if (hot >= 0) {
      apply();
      hot = -1;
    }
    if (id == null || id < 0) {
      if (readEl) readEl.textContent = '';
      return;
    }
    const rw = Math.floor(id / NC);
    const c = id % NC;
    if (readEl) readEl.textContent = opts.read(rw / (NR - 1), PofC(c));
    mesh.setColorAt(id, hotCol);
    mesh.instanceColor.needsUpdate = true;
    hot = id;
  }

  let alive = true;
  let last = performance.now();
  let dirty = true;
  let raf = 0;
  function loop(now) {
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    let moving = false;
    const k = 1 - Math.exp(-dt * 7);
    for (let i = 0; i < N; i++) {
      const dd = tgt[i] - cur[i];
      if (Math.abs(dd) > 0.0005) {
        cur[i] += dd * k;
        moving = true;
      } else cur[i] = tgt[i];
    }
    if (moving || dirty) {
      apply();
      dirty = false;
      hot = -1;
    }
    const y = yaw + (REDUCED || drag ? 0 : Math.sin((now - t0) / 7000) * 0.08);
    const R = narrow ? 86 : 45;
    cam.position.set(Math.sin(y) * Math.cos(pitch) * R, Math.sin(pitch) * R + 1, Math.cos(y) * Math.cos(pitch) * R);
    cam.lookAt(narrow ? 0 : 1.2, 2.4, 0);
    if (hoverP && !drag) {
      v2.set(hoverP.x, hoverP.y);
      ray.setFromCamera(v2, cam);
      const hit = ray.intersectObject(mesh)[0];
      const id = hit ? hit.instanceId : -1;
      if (id !== hot) hRead(id);
    }
    r.render(sc, cam);
    TAGS.forEach((tg) => {
      const v = tg.fn().project(cam);
      const sx = ((v.x + 1) / 2) * W;
      const sy = ((1 - v.y) / 2) * Hh;
      const hw = (tg.el.offsetWidth || 60) / 2;
      tg.el.style.transform = `translate(${Math.round(sx)}px,${Math.round(sy)}px) translate(-50%,-50%)`;
      tg.el.style.opacity = v.z < 1 && sx - hw > 4 && sx + hw < W - 4 ? '1' : '0';
    });
    raf = requestAnimationFrame(loop);
  }
  resize();
  raf = requestAnimationFrame(loop);

  return {
    /** heights: rows x cols in 0..1 of the tallest bar; row: the plan's row. */
    update(heights, row) {
      tgt.set(heights);
      planRow = row;
      if (first || REDUCED) {
        cur.set(tgt);
        first = false;
      }
      dirty = true;
    },
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      cvs.removeEventListener('pointerdown', onDown);
      cvs.removeEventListener('pointermove', onMove);
      cvs.removeEventListener('pointerup', onUp);
      cvs.removeEventListener('pointercancel', onUp);
      cvs.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', resize);
      tagsEl.innerHTML = '';
      g.dispose();
      mat.dispose();
      frameGeo.dispose();
      frameMat.dispose();
      r.dispose();
    },
  };
}
