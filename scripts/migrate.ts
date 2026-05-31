import { Database } from '../src/sqlite';
import { config } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface Migration {
  id: number;
  name: string;
  applied_at: number;
}

function runMigrations() {
  const db = new Database(config.databasePath);

  // Create migrations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // Get applied migrations
  const applied = db.prepare('SELECT name FROM migrations').all() as Migration[];
  const appliedNames = new Set(applied.map(m => m.name));

  // Check if migrations directory exists
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log('No migrations directory found. Creating...');
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
    console.log(' Migrations directory created. No migrations to apply.');
    db.close();
    return;
  }

  // Get migration files
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migration files found.');
    db.close();
    return;
  }

  // Run new migrations
  for (const file of files) {
    if (!appliedNames.has(file)) {
      console.log(`Running migration: ${file}`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
      })();

      console.log(` Applied: ${file}`);
    }
  }

  console.log('All migrations complete!');
  db.close();
}

if (require.main === module) {
  runMigrations();
}

export { runMigrations };
