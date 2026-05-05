const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

const dbPath = process.env.DATABASE_PATH || './data/database.sqlite';
const absoluteDbPath = path.resolve(process.cwd(), dbPath);
const db = new sqlite3.Database(absoluteDbPath);

function addColumnIfMissing(tableName, columnDefinition) {
  db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error(`DB migration error: ${err.message}`);
    }
  });
}

function initDb() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT,
      image_url TEXT,
      cloudinary_public_id TEXT,
      caption TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      scheduled_for TEXT,
      published_at TEXT,
      instagram_creation_id TEXT,
      instagram_media_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    // For older databases created before Cloudinary support.
    addColumnIfMissing('posts', 'image_url TEXT');
    addColumnIfMissing('posts', 'cloudinary_public_id TEXT');
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

module.exports = { db, initDb, all, get, run };
