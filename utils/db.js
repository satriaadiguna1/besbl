// utils/db.js
import { MongoClient } from "mongodb";

let client;
let db;

export async function getDb() {
  if (db) return db;
  if (!process.env.MONGODB_URI || !process.env.DB_NAME) {
    throw new Error("MongoDB not configured");
  }
  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db(process.env.DB_NAME);
  return db;
}
