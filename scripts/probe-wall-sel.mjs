import puppeteer from "puppeteer";
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
const p=await b.newPage(); await p.setViewport({width:1400,height:880,deviceScaleFactor:1.25});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto("http://localhost:5187/",{waitUntil:"networkidle0",timeout:20000}).catch(()=>{});
await new Promise(r=>setTimeout(r,1200));
// auf eine Wandkante des Rechtecks klicken (linke Wand)
const hit=await p.evaluate(()=>{const polys=[...document.querySelectorAll(".plan-svg polygon, .plan-svg path")];if(!polys.length)return null;const svg=document.querySelector(".plan-svg");const r=svg.getBoundingClientRect();return{x:r.x+r.width*0.34,y:r.y+r.height*0.5};});
if(hit){await p.mouse.click(hit.x,hit.y);await new Promise(r=>setTimeout(r,400));}
const hasWallSec=await p.evaluate(()=>!!document.querySelector(".objinfo-panel")&&/Aufbau|Referenz|UK|OK/.test(document.querySelector(".objinfo-panel")?.textContent||""));
await p.screenshot({path:"scripts/probe-wall-sel.png"});
console.log("wallSection:",hasWallSec,"errs:",errs.slice(0,2));
await b.close();
