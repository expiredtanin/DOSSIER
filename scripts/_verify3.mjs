import puppeteer from "puppeteer";
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
const p=await b.newPage(); await p.setViewport({width:1500,height:950,deviceScaleFactor:2});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
try{await p.goto("http://localhost:5173/",{waitUntil:"networkidle0",timeout:15000});}catch{}
await new Promise(r=>setTimeout(r,1000));
// Browser-Kontextmenü unterdrückt?
const ctxPrevented=await p.evaluate(()=>{const e=new MouseEvent("contextmenu",{bubbles:true,cancelable:true});return !document.body.dispatchEvent(e);});
// Marquee: Links-Drag über den Plan
const svg=await p.$(".plan-svg"); const box=await svg.boundingBox();
await p.mouse.move(box.x+box.width*0.25,box.y+box.height*0.25);
await p.mouse.down(); await p.mouse.move(box.x+box.width*0.85,box.y+box.height*0.85,{steps:8}); await p.mouse.up();
await new Promise(r=>setTimeout(r,300));
const sel=await p.evaluate(()=>{const m=document.body.innerText.match(/Auswahl:?\s*(\d+)?\s*W\w*/i);return m?m[0]:"(keine)";});
await p.screenshot({path:"scripts/verify-de.png"});
// Englisch
const langOk=await p.evaluate(()=>{if(window.__i18n){window.__i18n.setLanguage("en");return true;}return false;});
await new Promise(r=>setTimeout(r,400));
await p.screenshot({path:"scripts/verify-en.png"});
console.log("ctxmenu unterdrückt:",ctxPrevented,"| Marquee-Auswahl:",sel,"| lang-switch:",langOk,"| errs:",errs.slice(0,2).join(" | ")||"keine");
await b.close();
