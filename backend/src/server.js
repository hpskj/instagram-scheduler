import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 8080;

const IG_USER_ID = process.env.INSTAGRAM_ACCOUNT_ID || process.env.IG_USER_ID;
const ACCESS_TOKEN =
  process.env.INSTAGRAM_ACCESS_TOKEN ||
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "post-media";

const DAILY_PUBLISH_HOUR = Number(process.env.DAILY_PUBLISH_HOUR || 9);
const DAILY_PUBLISH_MINUTE = Number(process.env.DAILY_PUBLISH_MINUTE || 0);
const CHECK_EVERY_MINUTE = String(process.env.CHECK_EVERY_MINUTE || "true") === "true";

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
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
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/quicktime",
    ];

    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Only image files and MP4/MOV videos are allowed"));
  },
});

function readPosts() {
  if (!fs.existsSync(dbFile)) return [];
  try {
    return JSON.parse(fs.readFileSync(dbFile, "utf8"));
  } catch {
    return [];
  }
}

function writePosts(posts) {
  fs.writeFileSync(dbFile, JSON.stringify(posts, null, 2));
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getMediaType(file) {
  return file.mimetype.startsWith("video/") ? "video" : "image";
}

function getFileExtension(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (ext) return ext;
  if (file.mimetype === "video/mp4") return ".mp4";
  if (file.mimetype === "video/quicktime") return ".mov";
  if (file.mimetype === "image/png") return ".png";
  if (file.mimetype === "image/webp") return ".webp";
  return ".jpg";
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
    .filter((x) => x.status === "queued" && x.scheduledAt)
    .sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));

  if (posts.length === 0) return nextDailyDate();

  const next = new Date(posts[0].scheduledAt);
  next.setDate(next.getDate() + 1);
  next.setHours(DAILY_PUBLISH_HOUR, DAILY_PUBLISH_MINUTE, 0, 0);
  return next;
}

async function uploadToSupabase(file) {
  if (!supabase) {
    throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY is missing in Railway Variables");
  }

  const mediaType = getMediaType(file);
  const ext = getFileExtension(file);
  const safeName = (file.originalname || "upload")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 80);

  const fileName = `${mediaType}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeName}${safeName.endsWith(ext) ? "" : ext}`;
  const fileBuffer = fs.readFileSync(file.path);

  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(fileName, fileBuffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  fs.unlink(file.path, () => {});

  if (error) throw new Error(`Supabase upload failed: ${error.message}`);

  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(fileName);

  return {
    url: data.publicUrl,
    mediaType,
    storagePath: fileName,
  };
}

async function savePostToSupabase(post) {
  if (!supabase) return;

  const { error } = await supabase.from("scheduled_posts").insert({
    caption: post.caption,
    media_url: post.mediaUrl,
    media_type: post.mediaType,
    video_url: post.mediaType === "video" ? post.mediaUrl : null,
    thumbnail_url: post.thumbnailUrl || null,
    scheduled_for: post.scheduledAt,
    status: post.status,
    instagram_post_id: post.instagramPostId || null,
  });

  if (error) {
    console.error("SUPABASE DB INSERT ERROR:", error.message);
  }
}

async function publishToInstagram(mediaUrl, caption = "", mediaType = "image") {
  if (!IG_USER_ID) throw new Error("INSTAGRAM_ACCOUNT_ID is missing");
  if (!ACCESS_TOKEN) throw new Error("INSTAGRAM_ACCESS_TOKEN is missing");

  const createBody = new URLSearchParams({
    caption,
    access_token: ACCESS_TOKEN,
  });

  if (mediaType === "video") {
    createBody.append("media_type", "REELS");
    createBody.append("video_url", mediaUrl);
  } else {
    createBody.append("image_url", mediaUrl);
  }

  const createRes = await fetch(`https://graph.facebook.com/v20.0/${IG_USER_ID}/media`, {
    method: "POST",
    body: createBody,
  });

  const createJson = await createRes.json();
  if (!createRes.ok || !createJson.id) throw new Error(JSON.stringify(createJson));

  // Instagram videos may need processing time before publishing.
  if (mediaType === "video") {
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }

  const publishBody = new URLSearchParams({
    creation_id: createJson.id,
    access_token: ACCESS_TOKEN,
  });

  const publishRes = await fetch(`https://graph.facebook.com/v20.0/${IG_USER_ID}/media_publish`, {
    method: "POST",
    body: publishBody,
  });

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
    supabaseUrl: SUPABASE_URL ? "Present ✅" : "Missing ❌",
    supabaseKey: SUPABASE_ANON_KEY ? "Present ✅" : "Missing ❌",
    supabaseBucket: SUPABASE_BUCKET,
  });
});

app.get("/api/posts", (req, res) => {
  const posts = readPosts().sort((a, b) => new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0));
  res.json(posts);
});

app.delete("/api/posts/:id", (req, res) => {
  const posts = readPosts();
  const post = posts.find((p) => p.id === req.params.id);

  if (!post) {
    return res.status(404).json({ ok: false, message: "Post not found" });
  }

  if (post.status === "published") {
    return res.status(400).json({
      ok: false,
      message: "Cannot delete already published post from this scheduler",
    });
  }

  const updated = posts.filter((p) => p.id !== req.params.id);
  writePosts(updated);

  res.json({ ok: true, message: "Post deleted successfully ✅" });
});

app.post("/api/schedule", upload.array("images", 50), async (req, res) => {
  try {
    const caption = req.body.caption || "";
    const publishTime = req.body.publishTime || "";
    const mode = req.body.mode || "daily";

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ ok: false, message: "No media uploaded" });
    }

    const posts = readPosts();
    let nextDate = publishTime ? new Date(publishTime) : getNextQueuedDate();

    for (const file of req.files) {
      const uploaded = await uploadToSupabase(file);

      const scheduledAt = mode === "now"
        ? new Date()
        : new Date(nextDate + "+03:00");

      const post = {
        id: makeId(),
        originalName: file.originalname,
        mediaUrl: uploaded.url,
        imageUrl: uploaded.mediaType === "image" ? uploaded.url : null,
        videoUrl: uploaded.mediaType === "video" ? uploaded.url : null,
        mediaType: uploaded.mediaType,
        storagePath: uploaded.storagePath,
        thumbnailUrl: null,
        caption,
        status: mode === "now" ? "ready_now" : "queued",
        scheduledAt: scheduledAt.toISOString(),
        createdAt: new Date().toISOString(),
        publishedAt: null,
        instagramPostId: null,
        error: null,
      };

      posts.push(post);
      await savePostToSupabase(post);

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

    res.json({ ok: true, message: "Media scheduled successfully", count: req.files.length });
  } catch (err) {
    console.error("SCHEDULE ERROR:", err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

async function publishReadyNow() {
  const posts = readPosts();
  const ready = posts.filter((p) => p.status === "ready_now");
  const results = [];

  for (const post of ready) {
    try {
      const ig = await publishToInstagram(post.mediaUrl || post.imageUrl || post.videoUrl, post.caption, post.mediaType || "image");
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
      const ig = await publishToInstagram(post.mediaUrl || post.imageUrl || post.videoUrl, post.caption, post.mediaType || "image");
      post.status = "published";
      post.publishedAt = new Date().toISOString();
      post.instagramPostId = ig.id;
      post.error = null;
    } catch (err) {
      post.status = "failed";
      post.error = err.message;
      console.error("[scheduler] Failed:", err.message);
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
  console.log(`Supabase URL: ${SUPABASE_URL ? "Present ✅" : "Missing ❌"}`);
  console.log(`Supabase Key: ${SUPABASE_ANON_KEY ? "Present ✅" : "Missing ❌"}`);
  console.log(`Supabase Bucket: ${SUPABASE_BUCKET}`);
});
