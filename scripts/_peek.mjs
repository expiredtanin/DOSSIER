import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless:"new", args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
const p = await b.newPage(); await p.setViewport({width:1500,height:950,deviceScaleFactor:2});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
try{ await p.goto("http://localhost:5173/",{waitUntil:"networkidle0",timeout:15000}); }catch{}
await new Promise(r=>setTimeout(r,1000));
const info = await p.evaluate(()=>({rootLen:document.getElementById("root")?.innerHTML.length??-1, viteOverlay: !!document.querySelector("vite-error-overlay"), bodyText: document.body.innerText.slice(0,80)}));
await p.screenshot({path:"scripts/probe-now.png"});
console.log(JSON.stringify(info), "errs:", errs.slice(0,2).join(" | ")||"none");
await b.close();
