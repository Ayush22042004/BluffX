// Rebuild the multi-resolution Windows/browser icon from its editable SVG.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../client/node_modules/playwright');
(async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../client/public/bluffx.svg'), 'utf8');
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({deviceScaleFactor:1});
    const sizes = [16,32,48,64,128,256];
    const frames = [];
    for (const size of sizes) {
      await page.setViewportSize({width:size,height:size});
      await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${source}`);
      frames.push(await page.screenshot({type:'png',omitBackground:true}));
    }
    const header = Buffer.alloc(6+16*sizes.length);
    header.writeUInt16LE(1,2);
    header.writeUInt16LE(sizes.length,4);
    let offset = header.length;
    sizes.forEach((size,index) => {
      const pos=6+index*16;
      header[pos]=size===256?0:size;
      header[pos+1]=size===256?0:size;
      header.writeUInt16LE(1,pos+4);
      header.writeUInt16LE(32,pos+6);
      header.writeUInt32LE(frames[index].length,pos+8);
      header.writeUInt32LE(offset,pos+12);
      offset+=frames[index].length;
    });
    const destination=path.resolve(__dirname,'../client/public/bluffx.ico');
    fs.writeFileSync(destination,Buffer.concat([header,...frames]));
    console.log(`Created ${destination} (${sizes.join(', ')} px)`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
