// Rasterize the checkmark from public/icon.svg onto an opaque, square background.
// Home-screen launchers apply their own corner/circle mask. No runtime dependency.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const crc32 = data => { let crc=0xffffffff; for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0; };
const chunk=(type,data)=>{const label=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([label,data])));return Buffer.concat([size,label,data,crc]);};
function distance(x,y,ax,ay,bx,by){const t=Math.max(0,Math.min(1,((x-ax)*(bx-ax)+(y-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2)));return Math.hypot(x-ax-t*(bx-ax),y-ay-t*(by-ay));}
for(const [name,size] of [['apple-touch-icon.png',180],['icon-192.png',192],['icon-512.png',512]]){
  const raw=Buffer.alloc(size*(1+size*3));
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let coverage=0;
    for(let sy=0;sy<4;sy++)for(let sx=0;sx<4;sx++){
      const px=(x+(sx+.5)/4)*48/size,py=(y+(sy+.5)/4)*48/size;
      if(Math.min(distance(px,py,13,25,20,32),distance(px,py,20,32,36,15))<=2)coverage++;
    }
    [204,91,56].forEach((color,c)=>raw[y*(1+size*3)+1+x*3+c]=Math.round(color+(255-color)*coverage/16));
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=2;
  writeFileSync(new URL(`../public/${name}`,import.meta.url),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
}
