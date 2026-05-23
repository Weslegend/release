import { unzip } from 'unzipit';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const downloadUrl = url.searchParams.get("url");

    if (!downloadUrl) {
      return new Response(JSON.stringify({ error: "Missing url parameter" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    try {
      // Stream the zip footer via range requests
      const { entries } = await unzip(downloadUrl);
      const plistEntry = Object.keys(entries).find(name => name.endsWith('.app/Info.plist'));
      
      if (!plistEntry) {
        throw new Error("Info.plist not found in IPA");
      }

      const buffer = await entries[plistEntry].arrayBuffer();
      
      // Parse the raw binary plist data into standard JSON
      const plistData = parseBinaryPlist(buffer);
      
      // Send clean JSON straight back to Apple Shortcuts
      return new Response(JSON.stringify(plistData), {
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};

// Lightweight bplist parser for Cloudflare Workers
function parseBinaryPlist(buffer) {
  const view = new DataView(buffer);
  const len = buffer.byteLength;
  if (len < 32) throw new Error("Invalid binary plist");
  
  // Verify magic number "bplist00"
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 8));
  if (magic !== "bplist00") throw new Error("Not a binary plist");

  // Read trailer info at the very end of the file
  const offsetSize = view.getUint8(len - 26);
  const objectRefSize = view.getUint8(len - 25);
  const numObjects = Number(view.getBigUint64(len - 24));
  const topObject = Number(view.getBigUint64(len - 16));
  const offsetTableOffset = Number(view.getBigUint64(len - 8));

  // Build the offset table array
  const offsets = [];
  for (let i = 0; i < numObjects; i++) {
    let off = 0;
    const tablePos = offsetTableOffset + i * offsetSize;
    for (let j = 0; j < offsetSize; j++) {
      off = (off << 8) | view.getUint8(tablePos + j);
    }
    offsets.push(off);
  }

  function parseObject(objRef) {
    const offset = offsets[objRef];
    const byte = view.getUint8(offset);
    const type = byte & 0xF0;
    let count = byte & 0x0F;
    let bytesRead = 1;

    if (count === 15) {
      const countByte = view.getUint8(offset + 1);
      const intType = countByte & 0xF0;
      let intSize = 1 << (countByte & 0x0F);
      bytesRead += 1 + intSize;
      count = 0;
      for (let j = 0; j < intSize; j++) {
        count = (count << 8) | view.getUint8(offset + 2 + j);
      }
    }

    const dataOffset = offset + bytesRead;

    if (type === 0x50) { // ASCII String
      return String.fromCharCode(...new Uint8Array(buffer, dataOffset, count));
    }
    if (type === 0x60) { // UTF-16 String
      let str = "";
      for (let i = 0; i < count; i++) {
        str += String.fromCharCode(view.getUint16(dataOffset + i * 2));
      }
      return str;
    }
    if (type === 0xD0) { // Dictionary map
      const obj = {};
      const keyRefs = [];
      const valRefs = [];
      for (let i = 0; i < count; i++) {
        let kRef = 0;
        for (let j = 0; j < objectRefSize; j++) {
          kRef = (kRef << 8) | view.getUint8(dataOffset + i * objectRefSize + j);
        }
        keyRefs.push(kRef);
      }
      const valOffset = dataOffset + count * objectRefSize;
      for (let i = 0; i < count; i++) {
        let vRef = 0;
        for (let j = 0; j < objectRefSize; j++) {
          vRef = (vRef << 8) | view.getUint8(valOffset + i * objectRefSize + j);
        }
        valRefs.push(vRef);
      }
      for (let i = 0; i < count; i++) {
        const key = parseObject(keyRefs[i]);
        obj[key] = parseObject(valRefs[i]);
      }
      return obj;
    }
    if (type === 0xA0) { // Array list
      const arr = [];
      for (let i = 0; i < count; i++) {
        let ref = 0;
        for (let j = 0; j < objectRefSize; j++) {
          ref = (ref << 8) | view.getUint8(dataOffset + i * objectRefSize + j);
        }
        arr.push(parseObject(ref));
      }
      return arr;
    }
    return null;
  }

  return parseObject(topObject);
}
