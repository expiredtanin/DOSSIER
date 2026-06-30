import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless:"new", args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"] });
const p = await b.newPage(); await p.setViewport({width:1400,height:900,deviceScaleFactor:2});
const logs=[]; p.on("pageerror",e=>logs.push(e.message));
await p.goto("http://localhost:5174/",{waitUntil:"networkidle0",timeout:20000}).catch(()=>{});
await new Promise(r=>setTimeout(r,800));
// Default = Display (Haarlinien). Screenshot.
await p.screenshot({ path:"scripts/probe-display.png" });
// Auf Print umschalten.
await p.evaluate(()=>[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="Print")?.click());
await new Promise(r=>setTimeout(r,400));
await p.screenshot({ path:"scripts/probe-print.png" });
const dispActive = await p.evaluate(()=>!![...document.querySelectorAll(".view-btn.active")].find(b=>b.textContent.trim()==="Print"));
console.log("printActive:", dispActive, logs.length?logs.join("|"):"(no err)");
await b.close();
