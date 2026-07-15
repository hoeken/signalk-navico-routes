#!/usr/bin/env node
/**
 * Hardware smoke test against a live Navico MFD. Not run in CI.
 *
 *   node scripts/smoke-test.js <mfd-ip>            read-only checks
 *   node scripts/smoke-test.js <mfd-ip> --upload   full round trip (DESTROYS TRAILS)
 *
 * Steps: download → parse → serialize → re-parse verify, then optionally
 * upload the regenerated database, re-download and diff semantically.
 * A copy of every downloaded file is written to ./smoke-archive/.
 */

/* eslint-disable no-console */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { MfdClient } = require('../dist/mfd-client');
const { parseUsr, serializeUsr } = require('../dist/usr/codec');

async function main() {
  const [address, flag] = process.argv.slice(2);
  if (!address) {
    console.error('usage: smoke-test.js <mfd-ip> [--upload]');
    process.exit(2);
  }
  const doUpload = flag === '--upload';
  const client = new MfdClient(address);
  const archiveDir = join(process.cwd(), 'smoke-archive');
  mkdirSync(archiveDir, { recursive: true });

  console.log(`downloading user database from ${address} …`);
  const buf = await client.download();
  const backup = join(archiveDir, `smoke-${Date.now()}.usr`);
  writeFileSync(backup, buf);
  console.log(`  ${buf.length} bytes (backup: ${backup})`);

  const db = parseUsr(buf);
  console.log(
    `  parsed: ${db.waypoints.length} waypoints, ${db.routes.length} routes, ` +
      `${db.trails.length} trails (serial ${db.serialNumber})`,
  );

  const out = serializeUsr(db);
  const again = parseUsr(out);
  assertEqual(dumpRecords(again), dumpRecords(db), 'serialize→parse round trip');
  console.log(`  serialized ${out.length} bytes; round-trip OK`);

  const preserved = out.length - 8;
  if (out.subarray(0, preserved).equals(buf.subarray(0, preserved))) {
    console.log('  byte-identical up to the (dropped) trails section ✔');
  } else {
    console.warn('  WARNING: serialized bytes differ from the original before the trails section');
  }

  if (!doUpload) {
    console.log('read-only smoke test passed. Re-run with --upload for the full round trip.');
    return;
  }

  console.warn('UPLOADING regenerated database in 5 s — this erases trails! Ctrl-C to abort.');
  await new Promise((r) => setTimeout(r, 5000));
  await client.upload(out);
  console.log('uploaded. waiting 10 s for the MFD to settle …');
  await new Promise((r) => setTimeout(r, 10_000));

  const after = parseUsr(await client.download());
  assertEqual(dumpRecords(after), dumpRecords(db), 'post-upload re-download diff');
  console.log('MFD preserved all waypoint and route records ✔');
  console.log(`restore trails by re-uploading ${backup} via http://${address}/`);
}

function dumpRecords(db) {
  const sorted = (arr) => [...arr].sort((a, b) => a.uuid.localeCompare(b.uuid));
  return JSON.stringify({ waypoints: sorted(db.waypoints), routes: sorted(db.routes) }, null, 1);
}

function assertEqual(a, b, what) {
  if (a !== b) {
    const fs = require('node:fs');
    fs.writeFileSync('/tmp/smoke-a.json', a);
    fs.writeFileSync('/tmp/smoke-b.json', b);
    console.error(`${what} FAILED — inspect /tmp/smoke-a.json vs /tmp/smoke-b.json`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
