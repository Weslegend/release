import { unzip } from 'unzipit'; // Lightweight streaming zip library

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
      // unzipit streams the EOCD footer over HTTP using range requests!
      const { entries } = await unzip(downloadUrl);
      
      // Find the Info.plist file inside the Payload folder
      const plistEntry = Object.keys(entries).find(name => name.endsWith('.app/Info.plist'));
      
      if (!plistEntry) {
        throw new Error("Info.plist not found in IPA");
      }

      // Read the plist as an array buffer
      const buffer = await entries[plistEntry].arrayBuffer();
      
      // Send the raw binary plist data back to Shortcuts
      return new Response(buffer, {
        headers: { "Content-Type": "application/octet-stream" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};
