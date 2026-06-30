import puppeteer from "puppeteer";
const URL = process.env.PROBE_URL || "http://localhost:5173/";
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"] });
const page = await b.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
const logs = []; page.on("pageerror", e => logs.push(e.message));
page.on("dialog", async d => { await d.accept("3"); });
await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 }).catch(()=>{});
await new Promise(r=>setTimeout(r,600));
const clickTool = l => page.evaluate(x => [...document.querySelectorAll("button")].find(b=>b.textContent.trim()===x)?.click(), l);
const click = async (x,y)=>{ await page.mouse.move(x,y); await page.mouse.click(x,y); await new Promise(r=>setTimeout(r,70)); };
const nLines = () => page.evaluate(()=>document.querySelectorAll(".plan-svg line.draw2d").length);
const box = await page.evaluate(()=>{const r=document.querySelector(".plan-svg").getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};});
const cx=box.x+box.w/2, cy=box.y+box.h/2;
await clickTool("Linie"); await new Promise(r=>setTimeout(r,80));
const A=[cx-120,cy-140], B=[cx+20,cy-140];
await click(...A); await click(...B);
await clickTool("Auswahl"); await new Promise(r=>setTimeout(r,60));
await click((A[0]+B[0])/2, A[1]); // select midpoint
const sel = await page.evaluate(()=>document.querySelectorAll(".plan-svg .plan-grip").length);
await page.keyboard.press("m"); await new Promise(r=>setTimeout(r,80));
await page.keyboard.press("o"); await new Promise(r=>setTimeout(r,200));
const mode = await page.evaluate(()=>document.querySelector(".transform-bar .tf-mode.active .tf-mode-label")?.textContent);
await click(A[0], A[1]); // base
await click(A[0], A[1]+70); // dest (down by ~70px each step)
await new Promise(r=>setTimeout(r,150));
const n = await nLines();
await page.screenshot({ path:"scripts/probe-array.png" });
console.log("selectedGrips:", sel, "activeMode:", mode, "lines(expect 4):", n, logs.length?logs.join("|"):"(no err)");
await b.close();
