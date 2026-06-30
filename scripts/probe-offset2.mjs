import puppeteer from "puppeteer";
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
const p=await b.newPage(); await p.setViewport({width:1280,height:820,deviceScaleFactor:1});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto("http://localhost:5173/",{waitUntil:"networkidle0",timeout:20000}).catch(()=>{});
await new Promise(r=>setTimeout(r,700));
const focusCmd=async()=>{ const el=await p.$(".cmdline-input"); const bx=await el.boundingBox(); await p.mouse.click(bx.x+bx.width/2, bx.y+bx.height/2); await new Promise(r=>setTimeout(r,60)); };
const typeLine=async t=>{ await p.type(".cmdline-input",t,{delay:8}); await p.keyboard.press("Enter"); await new Promise(r=>setTimeout(r,90)); };
// 1) Linie zeichnen (1,4)->(4,4)
await focusCmd(); await typeLine("line"); await typeLine("1,2.5"); await typeLine("r3,0");
// 2) gerenderte draw2d-Linie finden, Mittelpunkt klicken (selektieren)
const mid=await p.evaluate(()=>{
  const l=[...document.querySelectorAll(".plan-svg line.draw2d")][0]; if(!l) return null;
  const svg=l.ownerSVGElement, ctm=svg.getScreenCTM();
  const pt=(x,y)=>{const q=svg.createSVGPoint();q.x=x;q.y=y;const s=q.matrixTransform(ctm);return[s.x,s.y];};
  const a=pt(+l.getAttribute("x1"),+l.getAttribute("y1")), b=pt(+l.getAttribute("x2"),+l.getAttribute("y2"));
  return {x:(a[0]+b[0])/2, y:(a[1]+b[1])/2};
});
if(mid){ await p.mouse.click(mid.x, mid.y); await new Promise(r=>setTimeout(r,150)); }
const selKind=await p.evaluate(()=>document.querySelector(".objinfo-kind")?.textContent||"none");
// 3) offset 0.5
await focusCmd(); await typeLine("offset"); await typeLine("0.5");
// 4) Linien (Modellkoordinaten) auslesen
const segs=await p.evaluate(()=>[...document.querySelectorAll(".plan-svg line.draw2d")].map(l=>{
  // toScreen: x*90, -y*90 → invert: model = (vbx/90, -vby/90)
  return {x1:+l.getAttribute("x1")/90, y1:-l.getAttribute("y1")/90, x2:+l.getAttribute("x2")/90, y2:-l.getAttribute("y2")/90};
}));
await p.screenshot({path:"scripts/probe-offset2.png"});
console.log(JSON.stringify({selKind, segCount:segs.length, segs, errs},null,2));
await b.close();
