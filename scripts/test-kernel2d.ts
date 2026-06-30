// Numerische Verifikation des 2D-Kernels (esbuild → node). Kein UI nötig.
import {
  segmentIntersect,
  offsetPolyline,
  offsetSegment,
  trimSegment,
  extendSegment,
  filletCorner,
  pointSegmentDistance,
  lineCircleIntersect,
  circleCircleIntersect,
  signedArea,
  isCCW,
  joinChains,
  removeSegment,
  splitAtIntersections,
  splitClosedByChord,
  splitPolylineAtParam,
  vecEqual,
} from "../src/geometry/kernel2d.ts";

let pass = 0;
let fail = 0;
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name, JSON.stringify(detail)); }
}

// 1) Strecken-Schnitt: X durch (1,1)
{
  const h = segmentIntersect({x:0,y:0},{x:2,y:2},{x:0,y:2},{x:2,y:0});
  check("segmentIntersect cross at (1,1)", !!h && approx(h!.point.x,1) && approx(h!.point.y,1) && approx(h!.t,0.5), h);
}
// 2) parallele Strecken → null
{
  const h = segmentIntersect({x:0,y:0},{x:2,y:0},{x:0,y:1},{x:2,y:1});
  check("segmentIntersect parallel -> null", h === null);
}
// 3) kein Schnitt innerhalb der Segmente → null
{
  const h = segmentIntersect({x:0,y:0},{x:1,y:0},{x:2,y:-1},{x:2,y:1});
  check("segmentIntersect outside -> null", h === null);
}
// 4) Offset einer Strecke nach links (d>0): +y
{
  const [a,b] = offsetSegment({x:0,y:0},{x:1,y:0},0.5);
  check("offsetSegment left +0.5y", approx(a.y,0.5) && approx(b.y,0.5) && approx(a.x,0) && approx(b.x,1), {a,b});
}
// 5) Offset geschlossenes Quadrat: Konvention +leftNormal zeigt bei CCW NACH
//    INNEN (CONVENTIONS.md), also d>0 = innen → (1,1)..(3,3); d<0 = außen → (-1,-1)..(5,5).
{
  const sq = [{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}]; // CCW
  const inn = offsetPolyline(sq, 1, true);
  const okIn = inn.length===4 &&
    approx(inn[0].x,1)&&approx(inn[0].y,1)&&
    approx(inn[1].x,3)&&approx(inn[1].y,1)&&
    approx(inn[2].x,3)&&approx(inn[2].y,3)&&
    approx(inn[3].x,1)&&approx(inn[3].y,3);
  check("offsetPolyline square inward by 1 (CCW +n=inside)", okIn, inn);
  const out = offsetPolyline(sq, -1, true);
  const okOut = out.length===4 && approx(out[0].x,-1)&&approx(out[0].y,-1)&&approx(out[2].x,5)&&approx(out[2].y,5);
  check("offsetPolyline square outward by 1 (d<0)", okOut, out);
}
// 6) Offset offene L-Polylinie (Gehrung am Innenknick)
{
  const L = [{x:0,y:0},{x:4,y:0},{x:4,y:4}];
  const off = offsetPolyline(L, 1, false); // links
  // Endkanten verschoben; mittlerer Punkt = Gehrung bei (3,1) für links-offset
  check("offsetPolyline open L mitre", off.length===3 && approx(off[1].x,3) && approx(off[1].y,1), off);
}
// 7) Trim: Strecke 0..4 von Cutter bei x=1 und x=3, Pick im Mittelstück → 2 Reststücke
{
  const cutters = [
    {pts:[{x:1,y:-1},{x:1,y:1}], closed:false},
    {pts:[{x:3,y:-1},{x:3,y:1}], closed:false},
  ];
  const rem = trimSegment({x:0,y:0},{x:4,y:0},cutters,{x:2,y:0});
  const ok = rem.length===2 &&
    approx(rem[0][0].x,0)&&approx(rem[0][1].x,1)&&
    approx(rem[1][0].x,3)&&approx(rem[1][1].x,4);
  check("trimSegment removes middle piece", ok, rem);
}
// 8) Extend: Strecke 0..1 auf x-Achse, Ende bis Cutter bei x=3
{
  const cutters=[{pts:[{x:3,y:-1},{x:3,y:1}],closed:false}];
  const ex = extendSegment({x:0,y:0},{x:1,y:0},"end",cutters);
  check("extendSegment to x=3", !!ex && approx(ex![1].x,3) && approx(ex![1].y,0), ex);
}
// 9) Extend start-Ende rückwärts bis x=-2
{
  const cutters=[{pts:[{x:-2,y:-1},{x:-2,y:1}],closed:false}];
  const ex = extendSegment({x:0,y:0},{x:1,y:0},"start",cutters);
  check("extendSegment start to x=-2", !!ex && approx(ex![0].x,-2), ex);
}
// 10) Fillet 90°-Ecke, r=1 → setback 1, center (1,1)
{
  const f = filletCorner({x:0,y:0},{x:5,y:0},{x:0,y:5},1);
  const ok = !!f && approx(f!.tangentA.x,1)&&approx(f!.tangentA.y,0)&&
    approx(f!.tangentB.x,0)&&approx(f!.tangentB.y,1)&&
    approx(f!.center.x,1)&&approx(f!.center.y,1)&&approx(f!.radius,1);
  check("filletCorner 90deg r1", ok, f);
}
// 11) Fillet kollinear → null
{
  const f = filletCorner({x:0,y:0},{x:1,y:0},{x:-1,y:0},1);
  check("filletCorner collinear -> null", f === null);
}
// 12) pointSegmentDistance
{
  check("pointSegmentDistance perpendicular", approx(pointSegmentDistance({x:1,y:2},{x:0,y:0},{x:4,y:0}),2));
}

// 13) Linie durch Kreis (Mittelpunkt-Sekante) → 2 Punkte ±r
{
  const ps = lineCircleIntersect({x:-5,y:0},{x:5,y:0},{x:0,y:0},2);
  const xs = ps.map(p=>p.x).sort((a,b)=>a-b);
  check("lineCircleIntersect secant", ps.length===2 && approx(xs[0],-2) && approx(xs[1],2), ps);
}
// 14) Zwei Kreise (Abstand 2, r=√2 je) schneiden sich bei (1,±1)
{
  const ps = circleCircleIntersect({x:0,y:0},Math.SQRT2,{x:2,y:0},Math.SQRT2);
  const ok = ps.length===2 && ps.every(p=>approx(Math.abs(p.x),1)&&approx(Math.abs(p.y),1)) && approx(ps[0].x,1);
  check("circleCircleIntersect at (1,±1)", ok, ps);
}
// 15) Wicklung
{
  const ccw = [{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}];
  check("signedArea/isCCW", approx(signedArea(ccw),16) && isCCW(ccw) && !isCCW([...ccw].reverse()));
}

// ── Split / Join / Segment-Löschen ───────────────────────────────────────────
const V = (x: number, y: number) => ({ x, y });

// 16) splitPolylineAtParam: offene Linie → 2 Stücke an (5,0)
{
  const parts = splitPolylineAtParam([V(0,0),V(10,0)], false, 0, 0.5);
  check("splitPolyline open -> 2 pieces", parts.length===2 && approx(parts[0][1].x,5) && approx(parts[1][0].x,5), parts);
}
// 17) splitPolylineAtParam: geschlossenes Quadrat → eine offene Kette von/bis Schnitt
{
  const sq=[V(0,0),V(4,0),V(4,4),V(0,4)];
  const parts = splitPolylineAtParam(sq, true, 0, 0.5);
  const c = parts[0];
  check("splitPolyline closed -> 1 open chain", parts.length===1 && vecEqual(c[0],V(2,0)) && vecEqual(c[c.length-1],V(2,0)), c);
}
// 18) splitClosedByChord: Quadrat unten/oben → 2 geschlossene Hälften
{
  const sq=[V(0,0),V(4,0),V(4,4),V(0,4)];
  const res = splitClosedByChord(sq, 0, 0.5, 2, 0.5);
  const has=(p:{x:number;y:number}[],q:{x:number;y:number})=>p.some(r=>vecEqual(r,q));
  const ok = !!res && res[0].length>=3 && res[1].length>=3 &&
    has(res![0],V(2,0)) && has(res![0],V(2,4)) && has(res![1],V(2,0)) && has(res![1],V(2,4));
  check("splitClosedByChord -> 2 closed halves", ok, res);
  check("splitClosedByChord same edge -> null", splitClosedByChord(sq,1,0.5,1,0.7)===null);
}
// 19) removeSegment: geschlossenes Quadrat → offen, Start nach Kante
{
  const sq=[V(0,0),V(4,0),V(4,4),V(0,4)];
  const r = removeSegment(sq, true, 0);
  check("removeSegment closed -> open chain", r.closed===false && r.pts.length===4 && vecEqual(r.pts[0],V(4,0)), r);
}
// 20) splitAtIntersections: Rechteck × querende Linie → 2 geschlossene Hälften
{
  const rect=[V(0,0),V(4,0),V(4,4),V(0,4)];
  const cutter=[V(2,-1),V(2,5)];
  const pieces = splitAtIntersections(rect, true, [cutter]);
  check("splitAtIntersections rect×line -> 2 closed", pieces.length===2 && pieces[0].length>=3 && pieces[1].length>=3, pieces);
}
// 21) splitAtIntersections: offene Linie × Cutter → 2 Stücke an (5,0)
{
  const pieces = splitAtIntersections([V(0,0),V(10,0)], false, [[V(5,-2),V(5,2)]]);
  check("splitAtIntersections open line -> 2 pieces", pieces.length===2 && approx(pieces[0][pieces[0].length-1].x,5), pieces);
}
// 22) joinChains: zwei Linien mit gemeinsamem Endpunkt → eine Polylinie
{
  const out = joinChains([{pts:[V(0,0),V(5,0)],closed:false},{pts:[V(5,0),V(5,5)],closed:false}]);
  check("joinChains 2 chains -> 1 polyline (3 pts)", out.length===1 && out[0].pts.length===3 && out[0].closed===false, out);
}
// 23) joinChains: vier Kanten schließen sich → eine geschlossene Schleife
{
  const out = joinChains([
    {pts:[V(0,0),V(4,0)],closed:false},
    {pts:[V(4,0),V(4,4)],closed:false},
    {pts:[V(4,4),V(0,4)],closed:false},
    {pts:[V(0,4),V(0,0)],closed:false},
  ]);
  check("joinChains loop -> closed ring (4 pts)", out.length===1 && out[0].closed===true && out[0].pts.length===4, out);
}

console.log(`\nKERNEL2D: ${pass} ok, ${fail} fail`);
if (fail > 0) process.exit(1);
