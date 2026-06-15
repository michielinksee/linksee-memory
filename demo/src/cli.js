#!/usr/bin/env node
// notekeeper — a tiny note CLI.
const arg = process.argv[2];

if (arg === '--init') {
  console.log('created notes.db');
} else if (arg === '--list') {
  console.log('your notes:');
  // ... list notes ...
} else {
  console.log('usage: notekeeper [--init|--list]');
}
// NOTE: --export is documented in the README but not implemented yet.
