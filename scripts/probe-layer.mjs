import puppeteer from "puppeteer";
const URL = process.env.PROBE_URL || "http://localhost:5173/";
const b = await puppeteer.launch({ headless:"new", args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"] });
const p = await b.newPage();
await p.setViewport({ width:1200, height:800, deviceScaleFactor:2 });
await p.emulateMediaFeatures([{ name:"prefers-color-scheme", value:"dark" }]);
const logs=[]; p.on("pageerror",e=>logs.push(e.message));
await p.goto(URL,{waitUntil:"networkidle0",timeout:20000}).catch(()=>{});
await new Promise(r=>setTimeout(r,600));
// Auf den "Ebenen"-Tab wechseln (TabStrip braucht Pointer-Events).
await p.evaluate(()=>{ const t=[...document.querySelectorAll(".tab")].find(e=>e.textContent.trim()==="Ebenen"); ["pointerdown","pointerup","click"].forEach(ev=>t.dispatchEvent(new MouseEvent(ev,{bubbles:true}))); });
await new Promise(r=>setTimeout(r,250));
const initialActive = await p.evaluate(()=>document.querySelector(".cat-row.active .cat-name")?.textContent ?? null);
// "Türen/Fenster" anklicken.
await p.evaluate(()=>{ const r=[...document.querySelectorAll(".cat-name")].find(e=>e.textContent.includes("Türen"))?.closest(".cat-row"); r?.click(); });
await new Promise(r=>setTimeout(r,250));
const afterActive = await p.evaluate(()=>document.querySelector(".cat-row.active .cat-name")?.textContent ?? null);
const statusLayer = await p.evaluate(()=>{ const f=[...document.querySelectorAll(".sb-field")].find(x=>x.textContent.trim().startsWith("EBENE")||x.textContent.includes("Ebene")); return f?.querySelector(".sb-val")?.textContent; });
// Jetzt eine Linie zeichnen → sollte auf Kategorie 21 (blau #5080c8) landen.
await p.evaluate(()=>[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="Linie")?.click());
await new Promise(r=>setTimeout(r,80));
const box = await p.evaluate(()=>{const r=document.querySelector(".plan-svg").getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};});
const cx=box.x+box.w/2, cy=box.y+box.h/2;
for(const [x,y] of [[cx-120,cy-30],[cx+120,cy+30]]){ await p.mouse.move(x,y); await p.mouse.click(x,y); await new Promise(r=>setTimeout(r,60)); }
await p.evaluate(()=>[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="Auswahl")?.click());
await new Promise(r=>setTimeout(r,80));
const lineColor = await p.evaluate(()=>document.querySelector(".plan-svg line.draw2d")?.getAttribute("stroke"));
await p.screenshot({ path:"scripts/probe-layer.png" });
console.log("initialActive:", initialActive, "afterActive:", afterActive, "statusLayer:", statusLayer, "lineColor(expect #5080c8):", lineColor, logs.length?logs.join("|"):"(no err)");
await b.close();
