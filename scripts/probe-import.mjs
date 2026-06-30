import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless:"new", args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"] });
const p = await b.newPage(); await p.setViewport({width:1300,height:850,deviceScaleFactor:2});
const logs=[]; p.on("pageerror",e=>logs.push(e.message));
await p.goto("http://localhost:5174/",{waitUntil:"networkidle0",timeout:20000}).catch(()=>{});
await new Promise(r=>setTimeout(r,700));
// Ressourcen öffnen.
await p.evaluate(()=>[...document.querySelectorAll("button")].find(x=>x.textContent.trim().toLowerCase().includes("ressourc"))?.click());
await new Promise(r=>setTimeout(r,300));
// Tab "Linien".
await p.evaluate(()=>[...document.querySelectorAll(".res-tab-btn")].find(x=>/Linien|Lines/.test(x.textContent))?.click());
await new Promise(r=>setTimeout(r,200));
const before = await p.evaluate(()=>document.querySelectorAll(".res-line-preview").length);
const input = await p.$('.res-tab input[type=file]');
await input.uploadFile("/tmp/sample.lin");
await new Promise(r=>setTimeout(r,400));
const after = await p.evaluate(()=>document.querySelectorAll(".res-line-preview").length);
await p.screenshot({ path:"scripts/probe-import.png" });
console.log("lineStyles before:", before, "after:", after, "(expect +3)", logs.length?logs.join("|"):"(no err)");
await b.close();
