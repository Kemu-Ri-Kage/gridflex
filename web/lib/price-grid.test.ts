import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  barCentre,
  barFaces,
  brightness,
  depth,
  extremes,
  fitScale,
  hexRgb,
  inside,
  mix,
  project,
  riseProgress,
  type Camera,
} from './price-grid.ts';

const facing: Camera = { yaw: 0, pitch: Math.PI / 4, scale: 10, cx: 100, cy: 100 };

void test('seen straight on, x runs across the screen, height goes up and nearer rows sit lower', () => {
  assert.deepEqual(project(0, 0, 0, facing), { x: 100, y: 100 });
  assert.equal(project(1, 0, 0, facing).x, 110);
  assert.ok(project(0, 1, 0, facing).y < 100); // up is up
  assert.ok(project(0, 0, 1, facing).y > 100); // nearer is lower
  assert.ok(depth(0, 1, 0) > depth(0, 0, 0));
});

void test('a bar shows its top and only the sides turned toward the viewer', () => {
  // straight on: the front (+z) side and the top
  const straight = barFaces(0, 0, 2, facing);
  assert.equal(straight.length, 2);
  assert.equal(straight.at(-1)?.light, 1);
  // turned a little: the +x side comes into view as well
  const turned = barFaces(0, 0, 2, { ...facing, yaw: 0.4 });
  assert.equal(turned.length, 3);
  for (const face of turned) assert.equal(face.points.length, 4);
});

void test('the grid is centred and fits the box at any turn', () => {
  assert.deepEqual(barCentre(0, 0, 24, 30), { x: -11.5, z: -14.5 });
  assert.deepEqual(barCentre(23, 29, 24, 30), { x: 11.5, z: 14.5 });
  const scale = fitScale(800, 500, 24, 30, 0.6);
  for (const yaw of [-0.8, 0, 0.5, 1.2]) {
    const camera = { yaw, pitch: 0.6, scale, cx: 400, cy: 250 };
    for (const [x, z] of [[-12, -15], [12, -15], [-12, 15], [12, 15]]) {
      const p = project(x, 0, z, camera);
      assert.ok(p.x >= 0 && p.x <= 800, `x ${p.x} at yaw ${yaw}`);
    }
  }
});

void test('hit-testing finds points inside a face and not outside it', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.equal(inside({ x: 5, y: 5 }, square), true);
  assert.equal(inside({ x: 15, y: 5 }, square), false);
});

void test('colours mix between two palette tokens and brightness rises with the price', () => {
  assert.deepEqual(hexRgb('#1fce7a'), [31, 206, 122]);
  assert.equal(mix([0, 0, 0], [200, 100, 50], 0.5), 'rgb(100, 50, 25)');
  assert.equal(mix([0, 0, 0], [200, 100, 50], 2), 'rgb(200, 100, 50)');
  assert.ok(brightness(3000, 15000) < brightness(9000, 15000));
  assert.equal(brightness(15000, 15000), 1);
  assert.equal(brightness(100, 0), 0);
});

void test("a day's cheapest and dearest hour, the first on a tie", () => {
  assert.deepEqual(extremes([30, 20, 20, 90, 90, 40]), { cheapest: 1, dearest: 3 });
});

void test('rows rise one after another and settle at full height', () => {
  assert.equal(riseProgress(0, 0), 0);
  assert.equal(riseProgress(10_000, 29), 1);
  assert.ok(riseProgress(450, 0) > 0.5);
  assert.equal(riseProgress(100, 10), 0); // row 10 hasn't started
});
