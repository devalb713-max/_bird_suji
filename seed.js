import "dotenv/config";
import mongoose from "mongoose";
import { connectDB, Keyword } from "./models/db.js";
import { SEED_KEYWORDS } from "./models/keywords.js";

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in env.");
  }

  await connectDB();

  const docs = SEED_KEYWORDS.map((w) => ({ word: w.toLowerCase() }));
  try {
    const res = await Keyword.insertMany(docs, { ordered: false });
    console.log(`✅ Seeded keywords: inserted ${res?.length || 0}/${docs.length}`);
  } catch (err) {
    const inserted =
      err?.insertedDocs?.length ||
      err?.result?.result?.nInserted ||
      err?.result?.nInserted ||
      err?.insertedCount ||
      0;
    console.log(`✅ Seeded keywords: inserted ${inserted}/${docs.length}`);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

(() => {
  void (async () => {
    try {
      await main();
    } catch (err) {
      console.error(err?.message || err);
      process.exitCode = 1;
    }
  })();
})();
