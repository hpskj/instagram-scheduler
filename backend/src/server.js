import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { v2 as cloudinary } from "cloudinary";

const app = express();
const PORT = process.env.PORT || 8080;

const IG_USER_ID = process.env.INSTAGRAM_ACCOUNT_ID || process.env.IG_USER_ID;
const ACCESS_TOKEN =
  process.env.INSTAGRAM_ACCESS_TOKEN ||
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN;

const DAILY_PUBLISH_HOUR = Number(process.env.DAILY_PUBLISH_HOUR || 9);
const DAILY_PUBLISH_MINUTE = Number(process.env.DAILY_PUBLISH_MINUTE || 0);
const CHECK_EVERY_MINUTE = String(process.env.CHECK_EVERY_MINUTE || "true") === "true";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

const publicPath = path.join(process.cwd(), "public");
const dataDir = path.join(process.cwd(), "data");
const uploadsDir = path.join(process.cwd(), "uploads");
const dbFile = path.join(dataDir, "posts.json");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

app.use(express.static(publicPath));

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 25 * 1024 * 1024 },
});

function readPosts() {
  if (!fs.existsSync(dbFile)) return [];
  try { return JSON.parse(fs.readFileSync(dbFile, "utf8")); }
  catch { return []; }
}

function writePosts(posts) {
  fs.writeFileSync(dbFile, JSON.stringify(posts, null, 2));
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function nextDailyDate() {
  const now = new Date();
  const d = new Date(now);
  d.setHours(DAILY_PUBLISH_HOUR, DAILY_PUBLISH_MINUTE, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

function getNextQueuedDate() {
  const posts = readPosts()
    .filter((p) => p.status === "queued" && p.scheduledAt)
    .sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));
  if (posts.length === 0) return nextDailyDate();
  const next = new Date(posts[0].scheduledAt);
  next.setDate(next.getDate() + 1);
  next.setHours(DAILY_PUBLISH_HOUR, DAILY_PUBLISH_MINUTE, 0, 0);
  return next;
}

async function uploadToCloudinary(filePath) {
  const result = await cloudinary.uploader.upload(filePath, {
    folder: process.env.CLOUDINARY_FOLDER || "instagram-scheduler",
    resource_type: "image",
  });
  return result.secure_url;
}

async function publishToInstagram(imageUrl, caption = "") {
  if (!IG_USER_ID) throw new Error("INSTAGRAM_ACCOUNT_ID is missing");
  if (!ACCESS_TOKEN) throw new Error("INSTAGRAM_ACCESS_TOKEN is missing");

  const createUrl = `https://graph.facebook.com/v20.0/${IG_USER_ID}/media`;
  const createBody = new URLSearchParams({
    image_url: imageUrl,
    caption,
    access_token: ACCESS_TOKEN,
  });

  const createRes = await fetch(createUrl, { method: "POST", body: createBody });
  const createJson = await createRes.json();
  if (!createRes.ok || !createJson.id) throw new Error(JSON.stringify(createJson));

  const publishUrl = `https://graph.facebook.com/v20.0/${IG_USER_ID}/media_publish`;
  const publishBody = new URLSearchParams({
    creation_id: createJson.id,
    access_token: ACCESS_TOKEN,
  });

  const publishRes = await fetch(publishUrl, { method: "POST", body: publishBody });
  const publishJson = await publishRes.json();
  if (!publishRes.ok || !publishJson.id) throw new Error(JSON.stringify(publishJson));

  return publishJson;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "Instagram Scheduler backend is running ✅",
    instagramAccount: IG_USER_ID ? "Present ✅" : "Missing ❌",
    instagramToken: ACCESS_TOKEN ? "Present ✅" : "Missing ❌",
  });
});

app.get("/api/posts", (req, res) => {
  res.json(readPosts().sort((a, b) => new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0)));
});

app.post("/api/schedule", upload.array("images", 50), async (req, res) => {
  try {
    const caption = req.body.caption || "";
    const publishTime = req.body.publishTime || "";
    const mode = req.body.mode || "daily";

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ ok: false, message: "No images uploaded" });
    }

    const posts = readPosts();
    let nextDate = publishTime ? new Date(publishTime) : getNextQueuedDate();

    for (const file of req.files) {
      const imageUrl = await uploadToCloudinary(file.path);
      fs.unlink(file.path, () => {});

      const scheduledAt = mode === "now" ? new Date() : new Date(nextDate);

      posts.push({
        id: makeId(),
        originalName: file.originalname,
        imageUrl,
        caption,
        status: mode === "now" ? "ready_now" : "queued",
        scheduledAt: scheduledAt.toISOString(),
        createdAt: new Date().toISOString(),
        publishedAt: null,
        instagramPostId: null,
        error: null,
      });

      if (mode !== "now") {
        nextDate.setDate(nextDate.getDate() + 1);
        nextDate.setHours(DAILY_PUBLISH_HOUR, DAILY_PUBLISH_MINUTE, 0, 0);
      }
    }

    writePosts(posts);

    if (mode === "now") {
      const result = await publishReadyNow();
      return res.json({ ok: true, message: "Uploaded and published now", result });
    }

    res.json({ ok: true, message: "Images scheduled successfully", count: req.files.length });
  } catch (err) {
    console.error("SCHEDULE ERROR:", err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.post("/api/publish-now", upload.single("image"), async (req, res) => {
  try {
    const caption = req.body.caption || "";
    if (!req.file) return res.status(400).json({ ok: false, message: "No image uploaded" });
    const imageUrl = await uploadToCloudinary(req.file.path);
    fs.unlink(req.file.path, () => {});
    const ig = await publishToInstagram(imageUrl, caption);
    res.json({ ok: true, message: "Published successfully ✅", instagram: ig, imageUrl });
  } catch (err) {
    console.error("PUBLISH NOW ERROR:", err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

async function publishReadyNow() {
  const posts = readPosts();
  const ready = posts.filter((p) => p.status === "ready_now");
  const results = [];

  for (const post of ready) {
    try {
      const ig = await publishToInstagram(post.imageUrl, post.caption);
      post.status = "published";
      post.publishedAt = new Date().toISOString();
      post.instagramPostId = ig.id;
      post.error = null;
      results.push({ id: post.id, ok: true });
    } catch (err) {
      post.status = "failed";
      post.error = err.message;
      results.push({ id: post.id, ok: false, error: err.message });
    }
  }
  writePosts(posts);
  return results;
}

async function publishDuePosts() {
  const posts = readPosts();
  const now = new Date();
  const due = posts
    .filter((p) => p.status === "queued" && new Date(p.scheduledAt) <= now)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

  if (due.length === 0) {
    console.log("[scheduler] Result: { ok: true, message: 'No queued posts ready.' }");
    return;
  }

  for (const post of due) {
    try {
      console.log("[scheduler] Publishing:", post.id);
      const ig = await publishToInstagram(post.imageUrl, post.caption);
      post.status = "published";
      post.publishedAt = new Date().toISOString();
      post.instagramPostId = ig.id;
      post.error = null;
    } catch (err) {
      post.status = "failed";
      post.error = err.message;
      console.error("[scheduler] Failed:", post.id, err.message);
    }
  }
  writePosts(posts);
}

if (CHECK_EVERY_MINUTE) {
  setInterval(() => {
    console.log("[scheduler] Running publish job at", new Date().toISOString());
    publishDuePosts();
  }, 60 * 1000);
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Instagram Account ID: ${IG_USER_ID ? "Present ✅" : "Missing ❌"}`);
  console.log(`Instagram Token: ${ACCESS_TOKEN ? "Present ✅" : "Missing ❌"}`);
});
