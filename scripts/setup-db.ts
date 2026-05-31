import { initDb } from '../src/database';
import { Database } from '../src/sqlite';
import { config } from '../src/config';

async function setupDatabase() {
  try {
    console.log('Setting up database...');
    initDb();

    // Get database instance to add default rules
    const db = new Database(config.databasePath);

    // Add default rules
    db.prepare(`
      INSERT OR IGNORE INTO rules (type, description, severity) VALUES
      ('restriction', 'Sending stickers', 2),
      ('restriction', 'Sending URLs', 3),
      ('restriction', 'Regex pattern violation', 2),
      ('restriction', 'Media sharing', 2),
      ('restriction', 'GIF sharing', 1),
      ('restriction', 'Voice messages', 1),
      ('restriction', 'Message forwarding', 1),
      ('blacklist', 'Blacklisted user activity', 5)
    `).run();

    db.close();

    console.log(' Database setup complete!');
    process.exit(0);
  } catch (error) {
    console.error(' Database setup failed:', error);
    process.exit(1);
  }
}

setupDatabase();
