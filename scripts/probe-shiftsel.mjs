import puppeteer from "puppeteer";
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
const p=await b.newPage(); await p.setViewport({width:1280,height:820,deviceScaleFactor:1});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto("http://localhost:5187/",{waitUntil:"networkidle0",timeout:20000}).catch(()=>{});
await new Promise(r=>setTimeout(r,800));
const focus=async()=>{const el=await p.$(".cmdline-input");const bx=await el.boundingBox();await p.mouse.click(bx.x+bx.width/2,bx.y+bx.height/2);await new Promise(r=>setTimeout(r,50));};
const cmd=async t=>{await p.type(".cmdline-input",t,{delay:5});await p.keyboard.press("Enter");await new Promise(r=>setTimeout(r,70));};
await focus();await cmd("line");await cmd("1,2.2");await cmd("4,2.2");
await focus();await cmd("line");await cmd("1,2.8");await cmd("4,2.8");
// Bildschirmkoordinaten der zwei Linien
const mids=await p.evaluate(()=>{const ls=[...document.querySelectorAll(".plan-svg line.draw2d")];const svg=ls[0].ownerSVGElement,ctm=svg.getScreenCTM();const pt=(x,y)=>{const q=svg.createSVGPoint();q.x=x;q.y=y;const s=q.matrixTransform(ctm);return[s.x,s.y];};return ls.map(l=>{const a=pt(+l.getAttribute("x1"),+l.getAttribute("y1")),c=pt(+l.getAttribute("x2"),+l.getAttribute("y2"));return[(a[0]+c[0])/2,(a[1]+c[1])/2];});});
const selCount=()=>p.$$eval(".plan-svg .plan-sel-draw",e=>e.length).catch(()=>0);
// Linie A klicken
await p.mouse.click(mids[0][0],mids[0][1]); await new Promise(r=>setTimeout(r,150));
const after1=await selCount();
// Linie B shift-klicken
await p.keyboard.down("Shift"); await p.mouse.click(mids[1][0],mids[1][1]); await p.keyboard.up("Shift");
await new Promise(r=>setTimeout(r,150));
const after2=await selCount();
await p.screenshot({path:"scripts/probe-shiftsel.png"});
console.log(JSON.stringify({afterClickA:after1, afterShiftClickB:after2, errs:errs.slice(0,2)}));
await b.close();
