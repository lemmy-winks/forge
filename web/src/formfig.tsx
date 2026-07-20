/* FormFig — animated correct-form figures in the Void×Volt palette.
   One engine, ~30 movement templates. Each template is 2 keyframe poses of
   named points in a 100×100 space (y down); the figure interpolates between
   them with an eased dwell at each end. Joint-angle chips are computed live
   from the interpolated geometry, so they always match the drawing. */
import { useEffect, useRef, useState } from 'react';

type Pt = [number, number];
type Pose = Record<string, Pt>;
interface Template {
  poses: [Pose, Pose];
  chains: string[][];          // polylines through named points
  head: string;                // head point name
  prop?: { type: 'plate' | 'db' | 'kb' | 'wheel'; at: string };
  props?: { type: 'plate' | 'db' | 'kb' | 'wheel'; at: string }[]; // e.g. two dumbbells (front view)
  barlink?: [string, string];  // barbell drawn between two dynamic points (front view)
  cable?: { from: string; to: Pt };   // cable machines
  cables?: { from: string; to: Pt }[];
  barline?: [Pt, Pt];          // fixed bar (pull-up / dip station)
  bench?: [number, number, number, number]; // x y w h
  floor?: boolean;
  chips?: [string, string, string, string][]; // label, a, b(vertex), c
  period?: number;             // ms per half-cycle
}

export const T: Record<string, Template> = {
  squat_back: {
    poses: [
      { ankle: [52, 84], knee: [52, 66], hip: [51, 48], shoulder: [49, 27], head: [49, 18],
        elbow: [56, 31], hand: [54, 25], bar: [47, 26] },
      { ankle: [52, 84], knee: [60, 70], hip: [42, 64], shoulder: [46, 38], head: [47, 29],
        elbow: [54, 42], hand: [51, 36], bar: [44, 37] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'plate', at: 'bar' }, floor: true,
    chips: [['KNEE', 'ankle', 'knee', 'hip'], ['HIP', 'knee', 'hip', 'shoulder']],
  },
  squat_front: {
    poses: [
      { ankle: [52, 84], knee: [52, 66], hip: [51, 48], shoulder: [50, 27], head: [50, 18],
        elbow: [60, 31], hand: [56, 26], bar: [54, 26] },
      { ankle: [52, 84], knee: [61, 70], hip: [44, 63], shoulder: [47, 35], head: [48, 26],
        elbow: [57, 39], hand: [53, 34], bar: [51, 34] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'plate', at: 'bar' }, floor: true,
    chips: [['KNEE', 'ankle', 'knee', 'hip'], ['HIP', 'knee', 'hip', 'shoulder']],
  },
  hinge_dl: {
    poses: [
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [50, 19],
        elbow: [51, 37], hand: [51, 46], bar: [51, 47] },
      { ankle: [52, 84], knee: [56, 70], hip: [41, 58], shoulder: [56, 40], head: [60, 36],
        elbow: [55, 56], hand: [55, 73], bar: [55, 75] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'plate', at: 'bar' }, floor: true,
    chips: [['KNEE', 'ankle', 'knee', 'hip'], ['HIP', 'knee', 'hip', 'shoulder']],
  },
  hinge_rdl: {
    poses: [
      { ankle: [52, 84], knee: [52, 67], hip: [52, 48], shoulder: [50, 27], head: [50, 19],
        elbow: [51, 37], hand: [51, 46], bar: [51, 47] },
      { ankle: [52, 84], knee: [53, 68], hip: [42, 55], shoulder: [57, 42], head: [61, 38],
        elbow: [56, 54], hand: [56, 66], bar: [56, 67] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'plate', at: 'bar' }, floor: true,
    chips: [['HIP', 'knee', 'hip', 'shoulder']],
  },
  goodmorning: {
    poses: [
      { ankle: [52, 84], knee: [52, 67], hip: [52, 48], shoulder: [50, 27], head: [50, 19],
        elbow: [56, 31], hand: [54, 25], bar: [47, 26] },
      { ankle: [52, 84], knee: [53, 69], hip: [42, 57], shoulder: [57, 42], head: [61, 38],
        elbow: [61, 45], hand: [59, 40], bar: [54, 41] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'plate', at: 'bar' }, floor: true,
    chips: [['HIP', 'knee', 'hip', 'shoulder']],
  },
  kbswing: {
    poses: [
      { ankle: [52, 84], knee: [52, 67], hip: [52, 49], shoulder: [50, 28], head: [50, 19],
        elbow: [58, 32], hand: [66, 34], kb: [68, 36] },
      { ankle: [52, 84], knee: [55, 69], hip: [42, 58], shoulder: [55, 41], head: [59, 37],
        elbow: [53, 50], hand: [49, 61], kb: [48, 64] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'kb', at: 'kb' }, floor: true, period: 900,
    chips: [['HIP', 'knee', 'hip', 'shoulder']],
  },
  lunge: {
    poses: [
      { ankleF: [62, 84], kneeF: [60, 68], hip: [51, 50], kneeR: [45, 68], ankleR: [38, 84],
        shoulder: [50, 28], head: [50, 19], elbow: [54, 38], hand: [54, 48] },
      { ankleF: [62, 84], kneeF: [63, 70], hip: [51, 61], kneeR: [44, 78], ankleR: [37, 86],
        shoulder: [50, 39], head: [50, 30], elbow: [54, 49], hand: [54, 59] },
    ],
    chains: [['ankleF', 'kneeF', 'hip', 'shoulder'], ['ankleR', 'kneeR', 'hip'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'db', at: 'hand' }, floor: true,
    chips: [['KNEE', 'ankleF', 'kneeF', 'hip']],
  },
  bench: {
    poses: [
      { head: [31, 58], shoulder: [38, 61], hip: [56, 61], knee: [64, 66], ankle: [68, 82],
        elbow: [38, 49], hand: [38, 39], bar: [38, 37] },
      { head: [31, 58], shoulder: [38, 61], hip: [56, 61], knee: [64, 66], ankle: [68, 82],
        elbow: [31, 55], hand: [39, 55], bar: [39, 53] },
    ],
    chains: [['shoulder', 'hip', 'knee', 'ankle'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'plate', at: 'bar' }, floor: true,
    bench: [26, 63, 36, 5],
    chips: [['ELBOW', 'shoulder', 'elbow', 'hand']],
  },
  pushup: {
    poses: [
      { head: [35, 57], shoulder: [40, 62], hip: [52, 67], ankle: [67, 79], toes: [69, 84],
        elbow: [41, 73], hand: [42, 84] },
      { head: [34, 70], shoulder: [40, 74], hip: [52, 75], ankle: [67, 81], toes: [69, 84],
        elbow: [34, 80], hand: [42, 84] },
    ],
    chains: [['shoulder', 'hip', 'ankle', 'toes'], ['shoulder', 'elbow', 'hand']],
    head: 'head', floor: true,
    chips: [['ELBOW', 'shoulder', 'elbow', 'hand']],
  },
  ohp: {
    poses: [
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [47, 20],
        elbow: [55, 33], hand: [52, 25], bar: [51, 24] },
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [50, 20],
        elbow: [53, 19], hand: [52, 11], bar: [51, 10] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'plate', at: 'bar' }, floor: true,
    chips: [['ELBOW', 'shoulder', 'elbow', 'hand']],
  },
  row_bent: {
    poses: [
      { ankle: [52, 84], knee: [54, 70], hip: [42, 56], shoulder: [55, 40], head: [59, 36],
        elbow: [56, 50], hand: [57, 60], bar: [57, 61] },
      { ankle: [52, 84], knee: [54, 70], hip: [42, 56], shoulder: [55, 40], head: [59, 36],
        elbow: [49, 49], hand: [54, 48], bar: [54, 49] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'plate', at: 'bar' }, floor: true,
    chips: [['HIP', 'knee', 'hip', 'shoulder']],
  },
  row_seated: {
    poses: [
      { hip: [46, 64], knee: [58, 66], ankle: [68, 72], shoulder: [44, 43], head: [44, 34],
        elbow: [52, 49], hand: [60, 50] },
      { hip: [46, 64], knee: [58, 66], ankle: [68, 72], shoulder: [45, 42], head: [45, 33],
        elbow: [41, 50], hand: [48, 50] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', cable: { from: 'hand', to: [88, 52] }, floor: true,
  },
  pulldown: {
    poses: [
      { hip: [48, 64], knee: [60, 66], ankle: [62, 78], shoulder: [48, 42], head: [48, 33],
        elbow: [52, 31], hand: [56, 21] },
      { hip: [48, 64], knee: [60, 66], ankle: [62, 78], shoulder: [48, 42], head: [48, 33],
        elbow: [54, 48], hand: [57, 38] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', cable: { from: 'hand', to: [60, 6] }, floor: true,
  },
  pullup: {
    poses: [
      { hand: [50, 15], elbow: [50, 26], shoulder: [50, 36], head: [50, 30], hip: [50, 58],
        knee: [46, 70], ankle: [44, 80] },
      { hand: [50, 15], elbow: [53, 22], shoulder: [49, 27], head: [49, 21], hip: [49, 48],
        knee: [45, 62], ankle: [43, 72] },
    ],
    chains: [['hand', 'elbow', 'shoulder'], ['shoulder', 'hip', 'knee', 'ankle']],
    head: 'head', barline: [[34, 14], [66, 14]],
  },
  hangraise: {
    poses: [
      { hand: [50, 15], elbow: [50, 25], shoulder: [50, 35], head: [50, 29], hip: [50, 56],
        knee: [50, 70], ankle: [50, 82] },
      { hand: [50, 15], elbow: [50, 25], shoulder: [50, 35], head: [50, 29], hip: [50, 56],
        knee: [58, 53], ankle: [57, 65] },
    ],
    chains: [['hand', 'elbow', 'shoulder'], ['shoulder', 'hip', 'knee', 'ankle']],
    head: 'head', barline: [[34, 14], [66, 14]],
    chips: [['HIP', 'shoulder', 'hip', 'knee']],
  },
  dip: {
    poses: [
      { hand: [55, 55], elbow: [53, 49], shoulder: [50, 42], head: [50, 34], hip: [49, 62],
        knee: [44, 72], ankle: [42, 80] },
      { hand: [55, 55], elbow: [58, 53], shoulder: [50, 50], head: [50, 42], hip: [49, 68],
        knee: [44, 78], ankle: [42, 84] },
    ],
    chains: [['hand', 'elbow', 'shoulder'], ['shoulder', 'hip', 'knee', 'ankle']],
    head: 'head', barline: [[42, 55], [68, 55]],
    chips: [['ELBOW', 'shoulder', 'elbow', 'hand']],
  },
  curl: {
    poses: [
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [50, 19],
        elbow: [54, 38], hand: [55, 50], db: [56, 51] },
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [50, 19],
        elbow: [54, 38], hand: [48, 31], db: [47, 30] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'db', at: 'db' }, floor: true,
    chips: [['ELBOW', 'shoulder', 'elbow', 'hand']],
  },
  pushdown: {
    poses: [
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [50, 19],
        elbow: [55, 39], hand: [57, 30] },
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [50, 19],
        elbow: [55, 39], hand: [57, 52] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', cable: { from: 'hand', to: [62, 6] }, floor: true,
    chips: [['ELBOW', 'shoulder', 'elbow', 'hand']],
  },
  oh_ext: {
    poses: [
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [48, 20],
        elbow: [53, 17], hand: [52, 8], db: [52, 7] },
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [48, 20],
        elbow: [53, 17], hand: [44, 15], db: [43, 15] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'db', at: 'db' }, floor: true,
  },
  skull: {
    poses: [
      { head: [31, 58], shoulder: [38, 61], hip: [56, 61], knee: [64, 66], ankle: [68, 82],
        elbow: [37, 48], hand: [37, 38], bar: [37, 36] },
      { head: [31, 58], shoulder: [38, 61], hip: [56, 61], knee: [64, 66], ankle: [68, 82],
        elbow: [37, 48], hand: [28, 46], bar: [28, 45] },
    ],
    chains: [['shoulder', 'hip', 'knee', 'ankle'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'plate', at: 'bar' }, floor: true, bench: [26, 63, 36, 5],
  },
  latraise: {
    poses: [
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [50, 19],
        elbow: [55, 38], hand: [56, 46], db: [56, 48] },
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [50, 19],
        elbow: [61, 29], hand: [69, 28], db: [71, 28] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'db', at: 'db' }, floor: true,
  },
  rearfly: {
    poses: [
      { ankle: [52, 84], knee: [54, 70], hip: [42, 56], shoulder: [55, 40], head: [59, 36],
        elbow: [56, 50], hand: [58, 58], db: [58, 60] },
      { ankle: [52, 84], knee: [54, 70], hip: [42, 56], shoulder: [55, 40], head: [59, 36],
        elbow: [61, 44], hand: [67, 40], db: [69, 40] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'db', at: 'db' }, floor: true,
  },
  shrug: {
    poses: [
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 28], head: [50, 19],
        elbow: [51, 38], hand: [51, 47], bar: [51, 48] },
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 25], head: [50, 17],
        elbow: [51, 36], hand: [51, 45.5], bar: [51, 46.5] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'plate', at: 'bar' }, floor: true, period: 1100,
  },
  calfraise: {
    poses: [
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [50, 19],
        elbow: [51, 37], hand: [51, 46] },
      { ankle: [52, 81], knee: [52, 63], hip: [52, 45], shoulder: [50, 24], head: [50, 16],
        elbow: [51, 34], hand: [51, 43] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', floor: true, period: 1100,
  },
  legcurl: {
    poses: [
      { head: [29, 59], shoulder: [36, 61], hip: [52, 61], knee: [62, 62], ankle: [71, 64] },
      { head: [29, 59], shoulder: [36, 61], hip: [52, 61], knee: [62, 62], ankle: [59, 49] },
    ],
    chains: [['shoulder', 'hip', 'knee', 'ankle']],
    head: 'head', floor: true, bench: [26, 63, 42, 5],
    chips: [['KNEE', 'hip', 'knee', 'ankle']],
  },
  legext: {
    poses: [
      { shoulder: [44, 40], head: [44, 31], hip: [46, 60], knee: [58, 62], ankle: [61, 76] },
      { shoulder: [44, 40], head: [44, 31], hip: [46, 60], knee: [58, 62], ankle: [71, 59] },
    ],
    chains: [['shoulder', 'hip', 'knee', 'ankle']],
    head: 'head', floor: true, bench: [36, 62, 18, 5],
    chips: [['KNEE', 'hip', 'knee', 'ankle']],
  },
  legpress: {
    poses: [
      { head: [32, 46], shoulder: [36, 52], hip: [46, 64], knee: [55, 57], ankle: [59, 50] },
      { head: [32, 46], shoulder: [36, 52], hip: [46, 64], knee: [61, 55], ankle: [71, 47] },
    ],
    chains: [['shoulder', 'hip', 'knee', 'ankle']],
    head: 'head', floor: true, barline: [[68, 38], [78, 54]], bench: [30, 66, 20, 4],
    chips: [['KNEE', 'hip', 'knee', 'ankle']],
  },
  plank: {
    poses: [
      { head: [34, 60], shoulder: [40, 65], hip: [52, 68], ankle: [67, 79], toes: [69, 84],
        elbow: [40, 79], hand: [47, 82] },
      { head: [34, 61], shoulder: [40, 66], hip: [52, 69], ankle: [67, 79], toes: [69, 84],
        elbow: [40, 79], hand: [47, 82] },
    ],
    chains: [['shoulder', 'hip', 'ankle', 'toes'], ['shoulder', 'elbow', 'hand']],
    head: 'head', floor: true, period: 1600,
    chips: [['HIP', 'shoulder', 'hip', 'ankle']],
  },
  crunch: {
    poses: [
      { head: [32, 77], shoulder: [38, 79], hip: [50, 80], knee: [58, 68], ankle: [62, 81] },
      { head: [35, 70], shoulder: [40, 74], hip: [50, 80], knee: [58, 68], ankle: [62, 81] },
    ],
    chains: [['shoulder', 'hip', 'knee', 'ankle']],
    head: 'head', floor: true, period: 1100,
  },
  deadbug: {
    poses: [
      { head: [36, 79], shoulder: [42, 79], hip: [54, 79], elbow: [42, 70], hand: [42, 61],
        knee: [57, 68], ankle: [60, 74] },
      { head: [36, 79], shoulder: [42, 79], hip: [54, 79], elbow: [38, 71], hand: [33, 64],
        knee: [61, 70], ankle: [68, 76] },
    ],
    chains: [['shoulder', 'hip'], ['shoulder', 'elbow', 'hand'], ['hip', 'knee', 'ankle']],
    head: 'head', floor: true,
  },
  twist: {
    poses: [
      { hip: [50, 75], knee: [60, 64], ankle: [66, 73], shoulder: [43, 57], head: [42, 49],
        elbow: [50, 59], hand: [56, 62] },
      { hip: [50, 75], knee: [60, 64], ankle: [66, 73], shoulder: [44, 57], head: [43, 49],
        elbow: [47, 62], hand: [49, 68] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', floor: true, period: 1000,
  },
  abwheel: {
    poses: [
      { knee: [56, 84], hip: [50, 70], shoulder: [42, 61], head: [38, 55], elbow: [39, 69],
        hand: [36, 77], wheel: [35, 79] },
      { knee: [56, 84], hip: [48, 77], shoulder: [34, 70], head: [29, 65], elbow: [28, 75],
        hand: [23, 79], wheel: [22, 80] },
    ],
    chains: [['knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', prop: { type: 'wheel', at: 'wheel' }, floor: true,
  },
  cablecrunch: {
    poses: [
      { ankle: [63, 84], knee: [54, 84], hip: [50, 71], shoulder: [46, 52], head: [45, 44],
        elbow: [49, 48], hand: [50, 45] },
      { ankle: [63, 84], knee: [54, 84], hip: [50, 71], shoulder: [51, 60], head: [52, 52],
        elbow: [54, 55], hand: [55, 52] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', cable: { from: 'hand', to: [60, 6] }, floor: true,
  },
  bridge: {
    poses: [
      { head: [31, 80], shoulder: [37, 80], hip: [52, 78], knee: [60, 65], ankle: [62, 81] },
      { head: [31, 80], shoulder: [37, 80], hip: [53, 67], knee: [61, 62], ankle: [62, 81] },
    ],
    chains: [['shoulder', 'hip', 'knee', 'ankle']],
    head: 'head', floor: true,
    chips: [['HIP', 'shoulder', 'hip', 'knee']],
  },
  pec_arc: {
    poses: [
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [50, 19],
        elbow: [60, 32], hand: [68, 36] },
      { ankle: [52, 84], knee: [52, 66], hip: [52, 48], shoulder: [50, 27], head: [50, 19],
        elbow: [58, 35], hand: [60, 42] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', cable: { from: 'hand', to: [86, 20] }, floor: true,
  },
  stretch_kneel: {
    poses: [
      { ankleF: [63, 84], kneeF: [60, 70], hip: [50, 67], kneeR: [46, 84], ankleR: [36, 84],
        shoulder: [48, 45], head: [48, 36], elbow: [52, 36], hand: [54, 27] },
      { ankleF: [63, 84], kneeF: [61, 70], hip: [52, 66], kneeR: [46, 84], ankleR: [36, 84],
        shoulder: [50, 44], head: [50, 35], elbow: [54, 35], hand: [56, 26] },
    ],
    chains: [['ankleF', 'kneeF', 'hip'], ['ankleR', 'kneeR', 'hip'], ['hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', floor: true, period: 1800,
  },
  stretch_hinge: {
    poses: [
      { ankle: [52, 84], knee: [52, 68], hip: [46, 54], shoulder: [56, 44], head: [60, 41],
        elbow: [56, 55], hand: [55, 64] },
      { ankle: [52, 84], knee: [52, 68], hip: [45, 53], shoulder: [57, 46], head: [61, 43],
        elbow: [57, 57], hand: [56, 67] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', floor: true, period: 1800,
  },
  stretch_sit: {
    poses: [
      { ankleF: [70, 80], kneeF: [60, 79], hip: [50, 77], kneeR: [42, 79], ankleR: [33, 80],
        shoulder: [48, 55], head: [48, 46] },
      { ankleF: [70, 80], kneeF: [60, 79], hip: [50, 77], kneeR: [42, 79], ankleR: [33, 80],
        shoulder: [49, 56], head: [49, 47] },
    ],
    chains: [['ankleF', 'kneeF', 'hip'], ['ankleR', 'kneeR', 'hip'], ['hip', 'shoulder']],
    head: 'head', floor: true, period: 1800,
  },
  stretch_door: {
    poses: [
      { ankle: [48, 84], knee: [48, 66], hip: [48, 48], shoulder: [50, 27], head: [48, 19],
        elbow: [58, 28], hand: [61, 20] },
      { ankle: [48, 84], knee: [48, 66], hip: [49, 48], shoulder: [51, 27], head: [49, 19],
        elbow: [59, 28], hand: [62, 20] },
    ],
    chains: [['ankle', 'knee', 'hip', 'shoulder'], ['shoulder', 'elbow', 'hand']],
    head: 'head', floor: true, barline: [[63, 10], [63, 60]], period: 1800,
  },
  /* ---- front-view templates: movements that read wrong side-on ---- */
  latraise_front: {
    poses: [
      { head: [50, 16], neck: [50, 24], pelvis: [50, 52], shoulderL: [43, 28], shoulderR: [57, 28],
        hipL: [46, 51], hipR: [54, 51], kneeL: [45, 67], kneeR: [55, 67], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [40, 38], handL: [39, 47], elbowR: [60, 38], handR: [61, 47] },
      { head: [50, 16], neck: [50, 24], pelvis: [50, 52], shoulderL: [43, 28], shoulderR: [57, 28],
        hipL: [46, 51], hipR: [54, 51], kneeL: [45, 67], kneeR: [55, 67], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [32, 27], handL: [24, 26], elbowR: [68, 27], handR: [76, 26] },
    ],
    chains: [['neck', 'pelvis'], ['shoulderL', 'neck', 'shoulderR'],
             ['ankleL', 'kneeL', 'hipL', 'pelvis'], ['ankleR', 'kneeR', 'hipR', 'pelvis'],
             ['shoulderL', 'elbowL', 'handL'], ['shoulderR', 'elbowR', 'handR']],
    head: 'head', floor: true,
    props: [{ type: 'db', at: 'handL' }, { type: 'db', at: 'handR' }],
  },
  ohp_front: {
    poses: [
      { head: [50, 17], neck: [50, 24], pelvis: [50, 52], shoulderL: [43, 28], shoulderR: [57, 28],
        hipL: [46, 51], hipR: [54, 51], kneeL: [45, 67], kneeR: [55, 67], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [39, 35], handL: [42, 26], elbowR: [61, 35], handR: [58, 26] },
      { head: [50, 17], neck: [50, 24], pelvis: [50, 52], shoulderL: [43, 28], shoulderR: [57, 28],
        hipL: [46, 51], hipR: [54, 51], kneeL: [45, 67], kneeR: [55, 67], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [40, 18], handL: [42, 10], elbowR: [60, 18], handR: [58, 10] },
    ],
    chains: [['neck', 'pelvis'], ['shoulderL', 'neck', 'shoulderR'],
             ['ankleL', 'kneeL', 'hipL', 'pelvis'], ['ankleR', 'kneeR', 'hipR', 'pelvis'],
             ['shoulderL', 'elbowL', 'handL'], ['shoulderR', 'elbowR', 'handR']],
    head: 'head', floor: true, barlink: ['handL', 'handR'],
    chips: [['ELBOW', 'shoulderL', 'elbowL', 'handL']],
  },
  dbpress_front: {
    poses: [
      { head: [50, 17], neck: [50, 24], pelvis: [50, 52], shoulderL: [43, 28], shoulderR: [57, 28],
        hipL: [46, 51], hipR: [54, 51], kneeL: [45, 67], kneeR: [55, 67], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [37, 34], handL: [39, 25], elbowR: [63, 34], handR: [61, 25] },
      { head: [50, 17], neck: [50, 24], pelvis: [50, 52], shoulderL: [43, 28], shoulderR: [57, 28],
        hipL: [46, 51], hipR: [54, 51], kneeL: [45, 67], kneeR: [55, 67], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [43, 17], handL: [46, 9], elbowR: [57, 17], handR: [54, 9] },
    ],
    chains: [['neck', 'pelvis'], ['shoulderL', 'neck', 'shoulderR'],
             ['ankleL', 'kneeL', 'hipL', 'pelvis'], ['ankleR', 'kneeR', 'hipR', 'pelvis'],
             ['shoulderL', 'elbowL', 'handL'], ['shoulderR', 'elbowR', 'handR']],
    head: 'head', floor: true,
    props: [{ type: 'db', at: 'handL' }, { type: 'db', at: 'handR' }],
  },
  pulldown_front: {
    poses: [
      { head: [50, 22], neck: [50, 30], pelvis: [50, 58], shoulderL: [43, 34], shoulderR: [57, 34],
        hipL: [46, 57], hipR: [54, 57], kneeL: [45, 70], kneeR: [55, 70], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [38, 26], handL: [34, 16], elbowR: [62, 26], handR: [66, 16] },
      { head: [50, 22], neck: [50, 30], pelvis: [50, 58], shoulderL: [43, 34], shoulderR: [57, 34],
        hipL: [46, 57], hipR: [54, 57], kneeL: [45, 70], kneeR: [55, 70], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [38, 44], handL: [41, 33], elbowR: [62, 44], handR: [59, 33] },
    ],
    chains: [['neck', 'pelvis'], ['shoulderL', 'neck', 'shoulderR'],
             ['ankleL', 'kneeL', 'hipL', 'pelvis'], ['ankleR', 'kneeR', 'hipR', 'pelvis'],
             ['shoulderL', 'elbowL', 'handL'], ['shoulderR', 'elbowR', 'handR']],
    head: 'head', floor: true, barlink: ['handL', 'handR'],
  },
  pullup_front: {
    poses: [
      { head: [50, 26], neck: [50, 33], pelvis: [50, 58], shoulderL: [44, 34], shoulderR: [56, 34],
        hipL: [47, 57], hipR: [53, 57], kneeL: [46, 72], kneeR: [54, 72], ankleL: [45, 84], ankleR: [55, 84],
        elbowL: [41, 23], handL: [40, 13], elbowR: [59, 23], handR: [60, 13] },
      { head: [50, 15], neck: [50, 22], pelvis: [50, 46], shoulderL: [44, 24], shoulderR: [56, 24],
        hipL: [47, 45], hipR: [53, 45], kneeL: [46, 58], kneeR: [54, 58], ankleL: [47, 68], ankleR: [53, 68],
        elbowL: [41, 18], handL: [40, 13], elbowR: [59, 18], handR: [60, 13] },
    ],
    chains: [['neck', 'pelvis'], ['shoulderL', 'neck', 'shoulderR'],
             ['ankleL', 'kneeL', 'hipL', 'pelvis'], ['ankleR', 'kneeR', 'hipR', 'pelvis'],
             ['shoulderL', 'elbowL', 'handL'], ['shoulderR', 'elbowR', 'handR']],
    head: 'head', barline: [[30, 12], [70, 12]],
  },
  pecdeck_front: {
    poses: [
      { head: [50, 16], neck: [50, 24], pelvis: [50, 52], shoulderL: [43, 28], shoulderR: [57, 28],
        hipL: [46, 51], hipR: [54, 51], kneeL: [45, 67], kneeR: [55, 67], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [34, 30], handL: [27, 27], elbowR: [66, 30], handR: [73, 27] },
      { head: [50, 16], neck: [50, 24], pelvis: [50, 52], shoulderL: [43, 28], shoulderR: [57, 28],
        hipL: [46, 51], hipR: [54, 51], kneeL: [45, 67], kneeR: [55, 67], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [42, 31], handL: [47, 27], elbowR: [58, 31], handR: [53, 27] },
    ],
    chains: [['neck', 'pelvis'], ['shoulderL', 'neck', 'shoulderR'],
             ['ankleL', 'kneeL', 'hipL', 'pelvis'], ['ankleR', 'kneeR', 'hipR', 'pelvis'],
             ['shoulderL', 'elbowL', 'handL'], ['shoulderR', 'elbowR', 'handR']],
    head: 'head', floor: true,
  },
  crossover_front: {
    poses: [
      { head: [50, 16], neck: [50, 24], pelvis: [50, 52], shoulderL: [43, 28], shoulderR: [57, 28],
        hipL: [46, 51], hipR: [54, 51], kneeL: [45, 67], kneeR: [55, 67], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [34, 28], handL: [27, 24], elbowR: [66, 28], handR: [73, 24] },
      { head: [50, 16], neck: [50, 24], pelvis: [50, 52], shoulderL: [43, 28], shoulderR: [57, 28],
        hipL: [46, 51], hipR: [54, 51], kneeL: [45, 67], kneeR: [55, 67], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [42, 34], handL: [47, 38], elbowR: [58, 34], handR: [53, 38] },
    ],
    chains: [['neck', 'pelvis'], ['shoulderL', 'neck', 'shoulderR'],
             ['ankleL', 'kneeL', 'hipL', 'pelvis'], ['ankleR', 'kneeR', 'hipR', 'pelvis'],
             ['shoulderL', 'elbowL', 'handL'], ['shoulderR', 'elbowR', 'handR']],
    head: 'head', floor: true,
    cables: [{ from: 'handL', to: [8, 10] }, { from: 'handR', to: [92, 10] }],
  },
  sumo_front: {
    poses: [
      { head: [50, 16], neck: [50, 26], pelvis: [50, 50], shoulderL: [43, 28], shoulderR: [57, 28],
        hipL: [46, 50], hipR: [54, 50], kneeL: [38, 66], kneeR: [62, 66], ankleL: [36, 84], ankleR: [64, 84],
        elbowL: [44, 38], handL: [45, 48], elbowR: [56, 38], handR: [55, 48] },
      { head: [50, 29], neck: [50, 39], pelvis: [50, 61], shoulderL: [44, 41], shoulderR: [56, 41],
        hipL: [46, 61], hipR: [54, 61], kneeL: [37, 68], kneeR: [63, 68], ankleL: [36, 84], ankleR: [64, 84],
        elbowL: [44, 55], handL: [45, 71], elbowR: [56, 55], handR: [55, 71] },
    ],
    chains: [['neck', 'pelvis'], ['shoulderL', 'neck', 'shoulderR'],
             ['ankleL', 'kneeL', 'hipL', 'pelvis'], ['ankleR', 'kneeR', 'hipR', 'pelvis'],
             ['shoulderL', 'elbowL', 'handL'], ['shoulderR', 'elbowR', 'handR']],
    head: 'head', floor: true, barlink: ['handL', 'handR'],
    chips: [['KNEE', 'ankleL', 'kneeL', 'hipL']],
  },
  shrug_front: {
    poses: [
      { head: [50, 17], neck: [50, 25], pelvis: [50, 52], shoulderL: [43, 29], shoulderR: [57, 29],
        hipL: [46, 51], hipR: [54, 51], kneeL: [45, 67], kneeR: [55, 67], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [42, 38], handL: [42, 47], elbowR: [58, 38], handR: [58, 47] },
      { head: [50, 15], neck: [50, 23], pelvis: [50, 52], shoulderL: [43, 26], shoulderR: [57, 26],
        hipL: [46, 51], hipR: [54, 51], kneeL: [45, 67], kneeR: [55, 67], ankleL: [44, 84], ankleR: [56, 84],
        elbowL: [42, 36], handL: [42, 45.5], elbowR: [58, 36], handR: [58, 45.5] },
    ],
    chains: [['neck', 'pelvis'], ['shoulderL', 'neck', 'shoulderR'],
             ['ankleL', 'kneeL', 'hipL', 'pelvis'], ['ankleR', 'kneeR', 'hipR', 'pelvis'],
             ['shoulderL', 'elbowL', 'handL'], ['shoulderR', 'elbowR', 'handR']],
    head: 'head', floor: true, barlink: ['handL', 'handR'], period: 1100,
  },
  twist_front: {
    poses: [
      { head: [50, 42], neck: [50, 50], pelvis: [50, 72], shoulderL: [44, 52], shoulderR: [56, 52],
        hipL: [47, 72], hipR: [53, 72], kneeL: [45, 62], kneeR: [55, 62], ankleL: [44, 70], ankleR: [56, 70],
        hands: [36, 60] },
      { head: [50, 42], neck: [50, 50], pelvis: [50, 72], shoulderL: [44, 52], shoulderR: [56, 52],
        hipL: [47, 72], hipR: [53, 72], kneeL: [45, 62], kneeR: [55, 62], ankleL: [44, 70], ankleR: [56, 70],
        hands: [64, 60] },
    ],
    chains: [['neck', 'pelvis'], ['shoulderL', 'neck', 'shoulderR'],
             ['pelvis', 'hipL', 'kneeL', 'ankleL'], ['pelvis', 'hipR', 'kneeR', 'ankleR'],
             ['shoulderL', 'hands'], ['shoulderR', 'hands']],
    head: 'head', floor: true, period: 900,
    prop: { type: 'kb', at: 'hands' },
  },
  sideplank: {
    poses: [
      { hand: [41, 82], elbow: [33, 81], shoulder: [35, 68], head: [30, 62], hip: [49, 73],
        ankle: [67, 80], topHand: [33, 54] },
      { hand: [41, 82], elbow: [33, 81], shoulder: [35, 68], head: [30, 62], hip: [49, 70],
        ankle: [67, 80], topHand: [33, 54] },
    ],
    chains: [['hand', 'elbow'], ['elbow', 'shoulder'], ['shoulder', 'hip', 'ankle'], ['shoulder', 'topHand']],
    head: 'head', floor: true, period: 1600,
    chips: [['HIP', 'shoulder', 'hip', 'ankle']],
  },
  walk: {
    poses: [
      { ankleF: [60, 84], kneeF: [56, 68], hip: [50, 50], kneeR: [47, 69], ankleR: [43, 82],
        shoulder: [50, 28], head: [50, 19], elbow: [46, 38], hand: [45, 46] },
      { ankleF: [44, 83], kneeF: [48, 69], hip: [50, 50], kneeR: [55, 68], ankleR: [59, 84],
        shoulder: [50, 28], head: [50, 19], elbow: [55, 38], hand: [57, 46] },
    ],
    chains: [['ankleF', 'kneeF', 'hip', 'shoulder'], ['ankleR', 'kneeR', 'hip'], ['shoulder', 'elbow', 'hand']],
    head: 'head', floor: true, period: 800,
  },
};

/** slug → template (+ optional prop swap). Anything unlisted renders nothing. */
export const CFG: Record<string, { t: string; prop?: Template['prop'] }> = {
  'back-squat': { t: 'squat_back' },
  'front-squat': { t: 'squat_front' },
  'goblet-squat': { t: 'squat_front', prop: { type: 'kb', at: 'bar' } },
  'leg-press': { t: 'legpress' },
  'deadlift': { t: 'hinge_dl' },
  'sumo-deadlift': { t: 'sumo_front' },
  'romanian-deadlift': { t: 'hinge_rdl' },
  'db-romanian-deadlift': { t: 'hinge_rdl', prop: { type: 'db', at: 'bar' } },
  'good-morning': { t: 'goodmorning' },
  'kettlebell-swing': { t: 'kbswing' },
  'hip-thrust': { t: 'bridge' },
  'glute-bridge': { t: 'bridge' },
  'back-extension': { t: 'stretch_hinge' },
  'split-squat': { t: 'lunge' },
  'bulgarian-split-squat': { t: 'lunge' },
  'walking-lunge': { t: 'lunge' },
  'reverse-lunge': { t: 'lunge' },
  'step-up': { t: 'lunge' },
  'leg-curl': { t: 'legcurl' },
  'leg-extension': { t: 'legext' },
  'standing-calf-raise': { t: 'calfraise' },
  'bench-press': { t: 'bench' },
  'close-grip-bench': { t: 'bench' },
  'incline-bench-press': { t: 'bench' },
  'db-bench-press': { t: 'bench', prop: { type: 'db', at: 'bar' } },
  'incline-db-press': { t: 'bench', prop: { type: 'db', at: 'bar' } },
  'machine-chest-press': { t: 'row_seated' },
  'push-up': { t: 'pushup' },
  'dips': { t: 'dip' },
  'overhead-press': { t: 'ohp_front' },
  'db-shoulder-press': { t: 'dbpress_front' },
  'landmine-press': { t: 'ohp' },
  'lateral-raise': { t: 'latraise_front' },
  'pec-deck': { t: 'pecdeck_front' },
  'cable-crossover': { t: 'crossover_front' },
  'barbell-row': { t: 'row_bent' },
  'db-row': { t: 'row_bent', prop: { type: 'db', at: 'bar' } },
  'seated-row': { t: 'row_seated' },
  'face-pull': { t: 'row_seated' },
  'lat-pulldown': { t: 'pulldown_front' },
  'straight-arm-pulldown': { t: 'pushdown' },
  'pull-up': { t: 'pullup_front' },
  'chin-up': { t: 'pullup_front' },
  'rear-delt-fly': { t: 'rearfly' },
  'shrug': { t: 'shrug_front' },
  'barbell-curl': { t: 'curl', prop: { type: 'plate', at: 'db' } },
  'db-curl': { t: 'curl' },
  'hammer-curl': { t: 'curl' },
  'cable-curl': { t: 'curl' },
  'triceps-pushdown': { t: 'pushdown' },
  'overhead-triceps-extension': { t: 'oh_ext' },
  'skullcrusher': { t: 'skull' },
  'hanging-leg-raise': { t: 'hangraise' },
  'cable-crunch': { t: 'cablecrunch' },
  'crunch': { t: 'crunch' },
  'russian-twist': { t: 'twist_front' },
  'ab-wheel': { t: 'abwheel' },
  'plank': { t: 'plank' },
  'side-plank': { t: 'sideplank' },
  'dead-bug': { t: 'deadbug' },
  'quad-hip-flexor-stretch': { t: 'stretch_kneel' },
  'hamstring-stretch': { t: 'stretch_hinge' },
  'ninety-ninety-hip': { t: 'stretch_sit' },
  'chest-doorway-stretch': { t: 'stretch_door' },
  'walk-easy': { t: 'walk' },
};

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function angleAt(a: Pt, b: Pt, c: Pt): number {
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const dot = v1[0] * v2[0] + v1[1] * v2[1];
  const m = Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]);
  return m ? Math.round((Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI) : 0;
}

/** 0→1→0 with a dwell at each end. */
function cycleT(now: number, period: number): number {
  const phase = (now % (period * 2)) / period; // 0..2
  const p = phase < 1 ? phase : 2 - phase;
  const q = Math.max(0, Math.min(1, (p - 0.12) / 0.76));
  return q < 0.5 ? 2 * q * q : 1 - ((-2 * q + 2) ** 2) / 2; // easeInOutQuad
}

export function FormFig({ slug, name, cues }: { slug: string; name: string; cues: string[] }) {
  const cfg = CFG[slug];
  const [, force] = useState(0);
  const start = useRef(performance.now());
  const loops = useRef(0);
  useEffect(() => {
    if (!cfg) return;
    let raf = 0;
    const tick = () => { force((n) => n + 1); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cfg]);
  if (!cfg) return null;
  const tpl = T[cfg.t];
  const period = tpl.period ?? 1400;
  const now = performance.now() - start.current;
  const t = cycleT(now, period);
  loops.current = Math.floor(now / (period * 2));
  const cue = cues.length ? cues[loops.current % cues.length] : '';

  const pts: Pose = {};
  for (const k of Object.keys(tpl.poses[0])) pts[k] = lerp(tpl.poses[0][k], tpl.poses[1][k], t);
  const single = cfg.prop ?? tpl.prop;
  const propList = [...(single ? [single] : []), ...(tpl.props || [])];
  const P = (n: string) => pts[n];
  const chips = (tpl.chips || []).map(([label, a, b, c]) => [label, angleAt(P(a), P(b), P(c))] as const);

  return (
    // padding-bottom ratio box: guarantees square height in every engine —
    // iOS Safari won't derive svg height from viewBox alone in a flex column.
    <div className="card" style={{ padding: 0, overflow: 'hidden', position: 'relative', paddingBottom: '100%' }}>
      <svg viewBox="0 0 100 100"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: 'var(--bg)' }}>
        <defs>
          <pattern id="ffdots" width="8" height="8" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.45" fill="var(--hair)" />
          </pattern>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill="url(#ffdots)" />
        <text x="5" y="8" fill="var(--mut)" fontSize="3.4" letterSpacing="0.4"
          style={{ textTransform: 'uppercase', fontWeight: 600 }}>
          {chips.length > 1 ? name.toUpperCase() : `${name.toUpperCase()} · CORRECT FORM`}
        </text>
        {chips.length > 0 && (
          <g fontSize="3.2" fontWeight="700" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <rect x={96 - chips.length * 19} y="3.6" rx="2.6" width={chips.length * 19 - 1} height="6"
              fill="var(--raised)" />
            {chips.map(([label, deg], i) => (
              <text key={label} x={96 - (chips.length - i) * 19 + 2.5} y="8" fill="var(--volt)">
                {label} {deg}°
              </text>
            ))}
          </g>
        )}
        {tpl.floor && <rect x="8" y="84" width="84" height="5" rx="1" fill="var(--fig-floor)" />}
        {tpl.bench && (
          <g fill="var(--fig-rack)">
            <rect x={tpl.bench[0]} y={tpl.bench[1]} width={tpl.bench[2]} height={tpl.bench[3]} rx="1.5" />
            <rect x={tpl.bench[0] + 4} y={tpl.bench[1] + tpl.bench[3]} width="3" height={84 - tpl.bench[1] - tpl.bench[3]} />
            <rect x={tpl.bench[0] + tpl.bench[2] - 7} y={tpl.bench[1] + tpl.bench[3]} width="3" height={84 - tpl.bench[1] - tpl.bench[3]} />
          </g>
        )}
        {tpl.barline && (
          <line x1={tpl.barline[0][0]} y1={tpl.barline[0][1]} x2={tpl.barline[1][0]} y2={tpl.barline[1][1]}
            stroke="var(--fig-edge2)" strokeWidth="1.6" strokeLinecap="round" />
        )}
        {[...(tpl.cable ? [tpl.cable] : []), ...(tpl.cables || [])].map((c, i) => (
          <line key={'c' + i} x1={P(c.from)[0]} y1={P(c.from)[1]} x2={c.to[0]} y2={c.to[1]}
            stroke="var(--hair)" strokeWidth="0.8" strokeDasharray="1.6 1.6" />
        ))}
        {tpl.barlink && (() => {
          const a = P(tpl.barlink[0]), b = P(tpl.barlink[1]);
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
          const e1: Pt = [a[0] - u[0] * 6, a[1] - u[1] * 6];
          const e2: Pt = [b[0] + u[0] * 6, b[1] + u[1] * 6];
          return (
            <g>
              <line x1={e1[0]} y1={e1[1]} x2={e2[0]} y2={e2[1]} stroke="var(--fig-edge)" strokeWidth="2"
                strokeLinecap="round" />
              <circle cx={e1[0]} cy={e1[1]} r="2.6" fill="var(--fig-fill)" stroke="var(--fig-edge)" strokeWidth="0.8" />
              <circle cx={e2[0]} cy={e2[1]} r="2.6" fill="var(--fig-fill)" stroke="var(--fig-edge)" strokeWidth="0.8" />
            </g>
          );
        })()}
        {tpl.chains.map((chain, i) => (
          <polyline key={i} fill="none" stroke="var(--volt)" strokeWidth="6"
            strokeLinecap="round" strokeLinejoin="round"
            points={chain.map((n) => P(n).join(',')).join(' ')} />
        ))}
        <circle cx={P(tpl.head)[0]} cy={P(tpl.head)[1]} r="4.6" fill="var(--volt)" />
        {propList.map((prop, pi) => {
          const [px, py] = P(prop.at);
          if (prop.type === 'plate') return (
            <g key={pi}>
              <circle cx={px} cy={py} r="7.5" fill="var(--fig-fill)" stroke="var(--fig-edge)" strokeWidth="1" />
              <circle cx={px} cy={py} r="4.2" fill="none" stroke="var(--fig-edge)" strokeWidth="0.8" />
              <circle cx={px} cy={py} r="1.4" fill="var(--fig-dot)" />
            </g>
          );
          if (prop.type === 'db') return (
            <g key={pi}>
              <rect x={px - 3.4} y={py - 1.4} width="6.8" height="2.8" rx="1.2" fill="var(--fig-edge)" />
              <rect x={px - 4.4} y={py - 2.4} width="2" height="4.8" rx="0.8" fill="var(--fig-fill)" />
              <rect x={px + 2.4} y={py - 2.4} width="2" height="4.8" rx="0.8" fill="var(--fig-fill)" />
            </g>
          );
          if (prop.type === 'kb') return (
            <g key={pi}>
              <circle cx={px} cy={py + 1} r="3.2" fill="var(--fig-fill)" stroke="var(--fig-edge)" strokeWidth="0.9" />
              <path d={`M${px - 1.8},${py - 1.4} a1.8,1.8 0 0 1 3.6,0`}
                fill="none" stroke="var(--fig-edge)" strokeWidth="1.1" />
            </g>
          );
          return <circle key={pi} cx={px} cy={py} r="3.4" fill="var(--fig-fill)" stroke="var(--fig-edge)" strokeWidth="1" />;
        })}
        {cue && (
          <g>
            <rect x="14" y="92" width="72" height="6.4" rx="3.2" fill="var(--raised)" />
            <text x="50" y="96.3" textAnchor="middle" fill="var(--volt)" fontSize="3.1" fontWeight="600">
              {cue.length > 46 ? cue.slice(0, 44) + '…' : cue}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
