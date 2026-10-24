import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createImageMasterService, isImageMasterKey } from "./image-master-service.js";
import { imageMasterSuffix, imageMasterDetectedMime } from "./image-master-key.js";

test("master suffix derives animation and format from bytes independently of filenames", async () => {
 const image=()=>sharp({create:{width:2,height:2,channels:4,background:"#12345678"}});
 for(const [format,extension] of [["png",".png"],["jpeg",".jpg"],["webp",".webp"],["gif",".gif"]] as const){const bytes=await image()[format]().toBuffer();assert.equal(imageMasterSuffix(bytes),extension);}
 const pixels=Buffer.from([255,0,0,255,0,0,255,255]);
 const animated=await sharp(pixels,{raw:{width:1,height:2,channels:4,pageHeight:1}}).webp({loop:3,delay:[100,200]}).toBuffer();
 assert.equal(imageMasterSuffix(animated),".anim.webp");
 const png=await image().png().toBuffer(),control=Buffer.alloc(20);control.writeUInt32BE(8);control.write("acTL",4);control.writeUInt32BE(2,8);
 assert.equal(imageMasterSuffix(Buffer.concat([png.subarray(0,33),control,png.subarray(33)])),".anim.png");
 assert.equal(imageMasterSuffix(Buffer.from("unknown original container")),".bin");
});

test("bounded incomplete PNG and WebP headers conservatively retain animation behavior",()=>{
 const png=Buffer.from("89504e470d0a1a0a0001000074455874","hex");assert.equal(imageMasterSuffix(png,false),".anim.png");
 const webp=Buffer.from("5249464600010000574542504558494600000100","hex");assert.equal(imageMasterSuffix(webp,false),".anim.webp");
});

test("canonical key guard recognizes suffixed masters without accepting traversal or foreign shapes",()=>{
 const prefix="users/owner/image-masters/public/"+"a".repeat(64);
 for(const suffix of ["", ".png",".jpg",".gif",".webp",".anim.png",".anim.webp",".avif",".heif",".bin"])assert.equal(isImageMasterKey(prefix+suffix),true);
 for(const suffix of [".svg","/file.png",".png/../other",".png?query"])assert.equal(isImageMasterKey(prefix+suffix),false);
 assert.equal(typeof createImageMasterService,"function");
});


test("AVIF and HEIF detection reads declared ftyp brands without guessing from later metadata",()=>{
 const container=(major:string,compatible:string[])=>{const bytes=Buffer.alloc(16+compatible.length*4);bytes.writeUInt32BE(bytes.length);bytes.write("ftyp",4);bytes.write(major,8);compatible.forEach((brand,i)=>bytes.write(brand,16+i*4));return bytes;};
 assert.equal(imageMasterDetectedMime(container("avif",["mif1","miaf"])),"image/avif");
 assert.equal(imageMasterDetectedMime(container("heic",["mif1"])),"image/heif");
 const heif=Buffer.concat([container("mif1",[]),Buffer.from("avif text outside the file-type box")]);
 assert.equal(imageMasterDetectedMime(heif),"image/heif");assert.equal(imageMasterSuffix(heif),".heif");
 assert.equal(imageMasterDetectedMime(Buffer.from("opaque unsupported original")),undefined);
});
