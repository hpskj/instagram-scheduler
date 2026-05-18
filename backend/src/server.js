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
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "post-media";

const DAILY_PUBLISH_HOUR = Number(process.env.DAILY_PUBLISH_HOUR || 9);
const DAILY_PUBLISH_MINUTE = Number(process.env.DAILY_PUBLISH_MINUTE || 0);
const CHECK_EVERY_MINUTE = String(process.env.CHECK_EVERY_MINUTE || "true") === "true";

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
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
  limits: { fileSize: 200 * 1024 * 1024 },
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

function getMediaType(file) {
  if (file.mimetype && file.mimetype.startsWith("video/")) return "video";
  return "image";
}

function getMediaUrlFromPost(post) {
  return post.mediaUrl || post.imageUrl || post.videoUrl;
}

function getMediaTypeFromPost(post) {
  if (post.mediaType) return post.mediaType;
  if (post.videoUrl) return "video";
  return "image";
}

function getScheduleStart(req) {
  const publishTime = req.body.publishTime || "";
  const startDate = req.body.startDate || "";

  if (startDate && publishTime) {
    return new Date(`${startDate}T${publishTime}:00+03:00`);
  }

  if (publishTime && publishTime.includes("T")) {
    return new Date(publishTime);
  }

  return getNextQueuedDate();
}

async function uploadToSupabase(file) {
  if (!supabase) {
    throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY is missing in Railway Variables");
  }

  const mediaType = getMediaType(file);
  const folder = mediaType === "video" ? "videos" : "images";
  const ext = path.extname(file.originalname || "");
  const fileName = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;

  const buffer = fs.readFileSync(file.path);

  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(fileName, buffer, {
      contentType: file.mimetype || "application/octet-stream",
      upsert: false,
    });

  if (error) {
    throw new Error(error.message);
  }

  const { data } = supabase.storage
    .from(SUPABASE_BUCKET)
    .getPublicUrl(fileName);

  return data.publicUrl;
}

async function publishImageToInstagram(imageUrl, caption = "") {
  if (!IG_USER_ID) throw new Error("INSTAGRAM_ACCOUNT_ID is missing");
  if (!ACCESS_TOKEN) throw new Error("INSTAGRAM_ACCESS_TOKEN is missing");

  const createBody = new URLSearchParams({
    image_url: imageUrl,
    caption,
    access_token: ACCESS_TOKEN,
  });

  const createRes = await fetch(`https://graph.facebook.com/v20.0/${IG_USER_ID}/media`, {
    method: "POST",
    body: createBody,
  });

  const createJson = await createRes.json();
  if (!createRes.ok || !createJson.id) throw new Error(JSON.stringify(createJson));

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

async function waitForVideoContainer(containerId) {
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const statusRes = await fetch(
      `https://graph.facebook.com/v20.0/${containerId}?fields=status_code&access_token=${ACCESS_TOKEN}`
    );

    const statusJson = await statusRes.json();

    if (statusJson.status_code === "FINISHED") return true;
    if (statusJson.status_code === "ERROR") {
      throw new Error(JSON.stringify(statusJson));
    }
  }

  return true;
}

async function publishVideoToInstagram(videoUrl, caption = "") {
  if (!IG_USER_ID) throw new Error("INSTAGRAM_ACCOUNT_ID is missing");
  if (!ACCESS_TOKEN) throw new Error("INSTAGRAM_ACCESS_TOKEN is missing");

  const createBody = new URLSearchParams({
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    access_token: ACCESS_TOKEN,
  });

  const createRes = await fetch(`https://graph.facebook.com/v20.0/${IG_USER_ID}/media`, {
    method: "POST",
    body: createBody,
  });

  const createJson = await createRes.json();
  if (!createRes.ok || !createJson.id) throw new Error(JSON.stringify(createJson));

  await waitForVideoContainer(createJson.id);

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

async function publishToInstagram(mediaUrl, caption = "", mediaType = "image") {
  if (mediaType === "video") {
    return publishVideoToInstagram(mediaUrl, caption);
  }

  return publishImageToInstagram(mediaUrl, caption);
}

async function savePostToSupabaseTable(post) {
  if (!supabase) return;

  try {
    await supabase.from("scheduled_posts").insert({
      id: post.id,
      caption: post.caption,
      media_url: post.mediaUrl,
      media_type: post.mediaType,
      video_url: post.videoUrl,
      thumbnail_url: post.thumbnailUrl || null,
      scheduled_for: post.scheduledAt,
      status: post.status,
      instagram_post_id: post.instagramPostId,
      created_at: post.createdAt,
    });
  } catch (err) {
    console.warn("Could not save post to Supabase table:", err.message);
  }
}

async function updatePostInSupabaseTable(post) {
  if (!supabase) return;

  try {
    await supabase
      .from("scheduled_posts")
      .update({
        status: post.status,
        instagram_post_id: post.instagramPostId,
      })
      .eq("id", post.id);
  } catch (err) {
    console.warn("Could not update post in Supabase table:", err.message);
  }
}

async function handleSchedule(req, res, forcedMode = null) {
  try {
    const files = req.files || [];
    const caption = req.body.caption || "";
    const mode = forcedMode || req.body.mode || "daily";

    if (!files.length) {
      return res.status(400).json({
        ok: false,
        message: "No media uploaded",
      });
    }

    const posts = readPosts();
    let nextDate = getScheduleStart(req);
    const createdPosts = [];

    for (const file of files) {
      const mediaUrl = await uploadToSupabase(file);
      fs.unlink(file.path, () => {});

      const mediaType = getMediaType(file);

      const scheduledAt =
        mode === "now"
          ? new Date()
          : new Date(nextDate);

      const post = {
        id: makeId(),
        originalName: file.originalname,
        mediaUrl,
        imageUrl: mediaType === "image" ? mediaUrl : null,
        videoUrl: mediaType === "video" ? mediaUrl : null,
        thumbnailUrl: null,
        mediaType,
        caption,
        status: mode === "now" ? "ready_now" : "queued",
        scheduledAt: scheduledAt.toISOString(),
        publishAt: scheduledAt.toISOString(),
        createdAt: new Date().toISOString(),
        publishedAt: null,
        instagramPostId: null,
        error: null,
      };

      posts.push(post);
      createdPosts.push(post);
      // await savePostToSupabaseTable(post);

      if (mode !== "now") {
        nextDate.setDate(nextDate.getDate() + 1);
        nextDate.setHours(DAILY_PUBLISH_HOUR, DAILY_PUBLISH_MINUTE, 0, 0);
      }
    }

    writePosts(posts);

    if (mode === "now") {
      const result = await publishReadyNow();
      return res.json({
        ok: true,
        message: "Uploaded and publish attempted",
        count: createdPosts.length,
        result,
      });
    }

    res.json({
      ok: true,
      message: "Media scheduled successfully",
      count: createdPosts.length,
      posts: createdPosts,
    });
  } catch (err) {
    console.error("SCHEDULE ERROR:", err);
    res.status(500).json({ ok: false, message: err.message, error: err.message });
  }
}

async function publishReadyNow() {
  const posts = readPosts();
  const ready = posts.filter((p) => p.status === "ready_now");
  const results = [];

  for (const post of ready) {
    try {
      const ig = await publishToInstagram(
        getMediaUrlFromPost(post),
        post.caption,
        getMediaTypeFromPost(post)
      );

      post.status = "published";
      post.publishedAt = new Date().toISOString();
      post.instagramPostId = ig.id;
      post.error = null;

      // await updatePostInSupabaseTable(post);
      results.push({ id: post.id, ok: true, instagramPostId: ig.id });
    } catch (err) {
      post.status = "failed";
      post.error = err.message;

      // await updatePostInSupabaseTable(post);
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
      const ig = await publishToInstagram(
        getMediaUrlFromPost(post),
        post.caption,
        getMediaTypeFromPost(post)
      );

      post.status = "published";
      post.publishedAt = new Date().toISOString();
      post.instagramPostId = ig.id;
      post.error = null;

      // await updatePostInSupabaseTable(post);
    } catch (err) {
      post.status = "failed";
      post.error = err.message;

      // await updatePostInSupabaseTable(post);
      console.error("[scheduler] Failed:", err.message);
    }
  }

  writePosts(posts);
}

app.get("/", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "Instagram Scheduler backend is running ✅",
    supabaseUrl: SUPABASE_URL ? "Present ✅" : "Missing ❌",
    supabaseKey: SUPABASE_ANON_KEY ? "Present ✅" : "Missing ❌",
    supabaseBucket: SUPABASE_BUCKET,
    tableSaving: "Disabled temporarily",
    instagramAccount: IG_USER_ID ? "Present ✅" : "Missing ❌",
    instagramToken: ACCESS_TOKEN ? "Present ✅" : "Missing ❌",
  });
});

app.get("/api/posts", (req, res) => {
  const posts = readPosts().sort(
    (a, b) => new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0)
  );

  res.json(posts);
});

app.get("/api/scheduled-posts", (req, res) => {
  const posts = readPosts().sort(
    (a, b) => new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0)
  );

  res.json({ ok: true, posts });
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

app.post("/api/schedule", upload.any(), async (req, res) => {
  await handleSchedule(req, res);
});

app.post("/api/schedule-bulk", upload.any(), async (req, res) => {
  await handleSchedule(req, res, "daily");
});

app.post("/api/publish-now", upload.any(), async (req, res) => {
  await handleSchedule(req, res, "now");
});

app.post("/api/clear-scheduled", (req, res) => {
  const posts = readPosts();
  const keepPublished = posts.filter((p) => p.status === "published");
  writePosts(keepPublished);

  res.json({ ok: true, message: "Unpublished scheduled posts cleared" });
});

if (CHECK_EVERY_MINUTE) {
  setInterval(() => {
    console.log("[scheduler] Running publish job at", new Date().toISOString());
    publishDuePosts();
  }, 60 * 1000);
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Supabase URL: ${SUPABASE_URL ? "Present ✅" : "Missing ❌"}`);
  console.log(`Supabase Key: ${SUPABASE_ANON_KEY ? "Present ✅" : "Missing ❌"}`);
  console.log(`Supabase Bucket: ${SUPABASE_BUCKET}`);
  console.log(`Instagram Account ID: ${IG_USER_ID ? "Present ✅" : "Missing ❌"}`);
  console.log(`Instagram Token: ${ACCESS_TOKEN ? "Present ✅" : "Missing ❌"}`);
});
