// Run locally from frontend. Never import this administrative script in the app.
// SUPABASE_SECRET_KEY is a server-only secret/service_role key. Do not prefix it VITE_.
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("Set SUPABASE_URL and server-only SUPABASE_SECRET_KEY locally.");
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const root = resolve("../.scratch/backups", new Date().toISOString().replaceAll(":", "-"));
await mkdir(root, { recursive: true });
function check({ data, error }) { if (error) throw error; return data; }
// Application row backup. Full database + Auth backup additionally needs pg_dump.
for (const table of ["profiles", "analyses"]) {
  const rows = [];
  for (let offset=0;;offset+=500) {
    const page = check(await client.from(table).select("*").order("id").range(offset,offset+499));
    rows.push(...page); if (page.length<500) break;
  }
  await writeFile(resolve(root, `${table}.json`), JSON.stringify(rows, null, 2));
}
const bucket = client.storage.from("depth-wizard");
async function copyFolder(prefix = "") {
  for (let offset=0;;offset+=100) {
    const page = check(await bucket.list(prefix, { limit:100, offset, sortBy:{ column:"name", order:"asc" } }));
    for (const item of page) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (!item.id) { await copyFolder(path); continue; }
      // A database object name cannot escape the backup directory.
      const destination = resolve(root, "storage", path);
      if (!destination.startsWith(resolve(root,"storage") + sep)) throw new Error("Unsafe object name");
      await mkdir(resolve(destination,".."), { recursive:true });
      const blob = check(await bucket.download(path));
      await writeFile(destination, Buffer.from(await blob.arrayBuffer()));
    }
    if (page.length<100) break;
  }
}
await copyFolder();
console.log("Backup written to " + root + ". Check counts and protect this directory; it contains private data.");
