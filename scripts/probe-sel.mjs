import puppeteer from "puppeteer";
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
const p=await b.newPage(); await p.setViewport({width:1280,height:820,deviceScaleFactor:1});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto("http://localhost:5187/",{waitUntil:"networkidle0",timeout:20000}).catch(()=>{});
await new Promise(r=>setTimeout(r,700));
const focusCmd=async()=>{const el=await p.$(".cmdline-input");const bx=await el.boundingBox();await p.mouse.click(bx.x+bx.width/2,bx.y+bx.height/2);await new Promise(r=>setTimeout(r,60));};
const typeLine=async t=>{await p.type(".cmdline-input",t,{delay:6});await p.keyboard.press("Enter");await new Promise(r=>setTimeout(r,80));};
const lineCount=()=>p.$$eval(".plan-svg line.draw2d",ls=>ls.length).catch(()=>-1);
// zwei Linien zeichnen
await focusCmd(); await typeLine("line"); await typeLine("1,2.2"); await typeLine("r3,0");
await focusCmd(); await typeLine("line"); await typeLine("1,2.8"); await typeLine("r3,0");
const drawn=await lineCount();
// Screen-bbox der draw2d-Linien
const bb=await p.evaluate(()=>{const ls=[...document.querySelectorAll(".plan-svg line.draw2d")];const svg=ls[0].ownerSVGElement,ctm=svg.getScreenCTM();const pt=(x,y)=>{const q=svg.createSVGPoint();q.x=x;q.y=y;const s=q.matrixTransform(ctm);return[s.x,s.y];};let xs=[],ys=[];for(const l of ls){const a=pt(+l.getAttribute("x1"),+l.getAttribute("y1")),c=pt(+l.getAttribute("x2"),+l.getAttribute("y2"));xs.push(a[0],c[0]);ys.push(a[1],c[1]);}return{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};});
// Marquee links→rechts (window) um beide Linien
await p.mouse.move(bb.minX-20, bb.minY-20); await p.mouse.down();
await p.mouse.move(bb.maxX+20, bb.maxY+20, {steps:6}); await new Promise(r=>setTimeout(r,60));
await p.mouse.up(); await new Promise(r=>setTimeout(r,200));
const selHi=await p.$$eval(".plan-svg .plan-sel-draw",e=>e.length).catch(()=>0);
const statusSel=await p.evaluate(()=>document.querySelector("footer,.statusbar")?.textContent?.match(/Auswahl[^|]*/)?.[0]||"");
// Löschen
await p.keyboard.press("Delete"); await new Promise(r=>setTimeout(r,200));
const afterDel=await lineCount();
await p.screenshot({path:"scripts/probe-sel.png"});
console.log(JSON.stringify({drawnLines:drawn, selHighlightPrims:selHi, statusSel, linesAfterDelete:afterDel, errs},null,2));
await b.close();
