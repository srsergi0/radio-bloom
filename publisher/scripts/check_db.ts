const { Database } = require('bun:sqlite');
const { join } = require('node:path');

try {
  const dbPath = join(__dirname, 'data', 'radio.db');
  const d = Database.open(dbPath, { readonly: true });
  const cols = d.query('PRAGMA table_info(downloads)').all();
  console.log('downloads cols:', cols.length, JSON.stringify(cols.map(c => c.name)));
  const cols2 = d.query('PRAGMA table_info(library_tracks)').all();
  console.log('library cols:', cols2.length, JSON.stringify(cols2.map(c => c.name)));
  d.close();
} catch(e) { console.log('Error:', e.message); }

