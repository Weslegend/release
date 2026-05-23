import { unzip } from 'unzipit';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const downloadUrl = url.searchParams.get("url");

    if (!downloadUrl) {
      return new Response(JSON.stringify({ error: "Missing url parameter" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    try {
      // 1. Stream the zip and find the plist
      const { entries } = await unzip(downloadUrl);
      const plistEntry = Object.keys(entries).find(name => name.endsWith('.app/Info.plist'));
      
      if (!plistEntry) {
        throw new Error("Info.plist not found in IPA");
      }

      // 2. Decode the binary plist
      const buffer = await entries[plistEntry].arrayBuffer();
      const plistData = parseBinaryPlist(buffer);
      
      // Fallbacks just in case the app is missing a key
      const bundleId = plistData.CFBundleIdentifier || "com.unknown.app";
      const version = plistData.CFBundleShortVersionString || "1.0";
      const appName = plistData.CFBundleDisplayName || plistData.CFBundleName || "Sideloaded App";

      // 3. THE NEW ENDPOINT: /install
      if (url.pathname === '/install') {
        const xmlManifest = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>items</key>
    <array>
        <dict>
            <key>assets</key>
            <array>
                <dict>
                    <key>kind</key>
                    <string>software-package</string>
                    <key>url</key>
                    <string>${downloadUrl}</string>
                </dict>
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>${bundleId}</string>
                <key>bundle-version</key>
                <string>${version}</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>${appName}</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>`;
        
        // Serve the raw XML straight to the iOS installer
        return new Response(xmlManifest, {
          headers: {
            "Content-Type": "text/xml",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      // 4. THE DEFAULT ENDPOINT: / (Returns raw JSON metadata)
      return new Response(JSON.stringify(plistData), {
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};

// Lightweight bplist parser
function parseBinaryPlist(buffer) {
  const view = new DataView(buffer);
  const len = buffer.byteLength;
  if (len < 32) throw new Error("Invalid binary plist");
  
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 8));
  if (magic !== "bplist00") throw new Error("Not a binary plist");

  const offsetSize = view.getUint8(len - 26);
  const objectRefSize = view.getUint8(len - 25);
  const numObjects = Number(view.getBigUint64(len - 24));
  const topObject = Number(view.getBigUint64(len - 16));
  const offsetTableOffset = Number(view.getBigUint64(len - 8));

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
      let intSize = 1 << (countByte & 0x0F);
      bytesRead += 1 + intSize;
      count = 0;
      for (let j = 0; j < intSize; j++) {
        count = (count << 8) | view.getUint8(offset + 2 + j);
      }
    }

    const dataOffset = offset + bytesRead;

    if (type === 0x50) {
      return String.fromCharCode(...new Uint8Array(buffer, dataOffset, count));
    }
    if (type === 0x60) {
      let str = "";
      for (let i = 0; i < count; i++) {
        str += String.fromCharCode(view.getUint16(dataOffset + i * 2));
      }
      return str;
    }
    if (type === 0xD0) {
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
    if (type === 0xA0) {
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
