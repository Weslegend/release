import { unzip } from 'unzipit';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const downloadUrl = url.searchParams.get("url");

    if (!downloadUrl) {
      return new Response("Missing URL", { status: 400 });
    }

    try {
      const { entries } = await unzip(downloadUrl);
      // Find the Info.plist within the Payload/Appname.app directory
      const plistEntry = Object.keys(entries).find(name => name.includes('.app/Info.plist'));
      
      if (!plistEntry) throw new Error("Info.plist not found in IPA");

      const buffer = await entries[plistEntry].arrayBuffer();
      const plistData = parseBinaryPlist(buffer);
      
      const bundleId = plistData.CFBundleIdentifier;
      const version = plistData.CFBundleShortVersionString || "1.0";
      const appName = plistData.CFBundleDisplayName || plistData.CFBundleName || "App";

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
      
      return new Response(xmlManifest, {
        headers: { "Content-Type": "text/xml" }
      });

    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  }
};

// Binary Plist Parser for iOS App metadata
function parseBinaryPlist(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 8));
  if (magic !== "bplist00") throw new Error("Not a binary plist");
  
  const len = buffer.byteLength;
  const numObjects = Number(view.getBigUint64(len - 24));
  const offsetTableOffset = Number(view.getBigUint64(len - 8));
  const offsetSize = view.getUint8(len - 26);
  const objectRefSize = view.getUint8(len - 25);
  const topObject = Number(view.getBigUint64(len - 16));

  const offsets = [];
  for (let i = 0; i < numObjects; i++) {
    let off = 0;
    for (let j = 0; j < offsetSize; j++) off = (off << 8) | view.getUint8(offsetTableOffset + i * offsetSize + j);
    offsets.push(off);
  }

  function parse(ref) {
    const offset = offsets[ref];
    const byte = view.getUint8(offset);
    const type = byte & 0xF0;
    let count = byte & 0x0F;
    let bytesRead = 1;
    if (count === 15) {
      const size = 1 << (view.getUint8(offset + 1) & 0x0F);
      count = 0;
      for (let j = 0; j < size; j++) count = (count << 8) | view.getUint8(offset + 2 + j);
      bytesRead += 1 + size;
    }
    const dataOffset = offset + bytesRead;
    if (type === 0x50) return String.fromCharCode(...new Uint8Array(buffer, dataOffset, count));
    if (type === 0x60) {
      let str = "";
      for (let i = 0; i < count; i++) str += String.fromCharCode(view.getUint16(dataOffset + i * 2));
      return str;
    }
    if (type === 0xD0) {
      const obj = {}, keys = [], vals = [];
      for (let i = 0; i < count; i++) {
        let k = 0; for(let j=0; j<objectRefSize; j++) k = (k << 8) | view.getUint8(dataOffset + i * objectRefSize + j);
        keys.push(k);
      }
      for (let i = 0; i < count; i++) {
        let v = 0; for(let j=0; j<objectRefSize; j++) v = (v << 8) | view.getUint8(dataOffset + count * objectRefSize + i * objectRefSize + j);
        vals.push(v);
      }
      for (let i = 0; i < count; i++) obj[parse(keys[i])] = parse(vals[i]);
      return obj;
    }
    return null;
  }
  return parse(topObject);
}
