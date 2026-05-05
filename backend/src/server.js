import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import axios from 'axios';
import { v2 as cloudinary } from 'cloudinary';
import cron from 'node-cron';

 dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// جدول مؤقت داخل الذاكرة - يختفي إذا سكرت السيرفر
const scheduledPosts = [];

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log('REQUEST:', req.method, req.url);
  next();
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const PORT = process.env.PORT || 5000;

const IG_ACCOUNT_ID =
  process.env.INSTAGRAM_BUSINESS_ID ||
  process.env.INSTAGRAM_ACCOUNT_ID ||
  process.env.IG_ACCOUNT_ID ||
  process.env.IG_USER_ID;

const IG_TOKEN =
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
  process.env.INSTAGRAM_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN ||
  process.env.IG_ACCESS_TOKEN;

function getMetaError(error) {
  return error.response?.data || { message: error.message };
}

function validateEnv({ requireCloudinary = true } = {}) {
  const missing = [];

  if (requireCloudinary) {
    if (!process.env.CLOUDINARY_CLOUD_NAME) missing.push('CLOUDINARY_CLOUD_NAME');
    if (!process.env.CLOUDINARY_API_KEY) missing.push('CLOUDINARY_API_KEY');
    if (!process.env.CLOUDINARY_API_SECRET) missing.push('CLOUDINARY_API_SECRET');
  }

  if (!IG_ACCOUNT_ID) missing.push('INSTAGRAM_BUSINESS_ID');
  if (!IG_TOKEN) missing.push('FACEBOOK_PAGE_ACCESS_TOKEN');

  return missing;
}

async function uploadToCloudinary(fileBuffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: process.env.CLOUDINARY_FOLDER || 'instagram-scheduler',
        resource_type: 'image',
        format: 'jpg',
        transformation: [{ quality: 'auto', fetch_format: 'jpg' }],
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    stream.end(fileBuffer);
  });
}

async function publishToInstagram({ imageUrl, caption }) {
  console.log('IMAGE URL:', imageUrl);

  const mediaRes = await axios.post(
    `https://graph.facebook.com/v19.0/${IG_ACCOUNT_ID}/media`,
    null,
    {
      params: {
        image_url: imageUrl,
        caption: caption || '',
        access_token: IG_TOKEN,
      },
    }
  );

  console.log('CREATION ID:', mediaRes.data.id);

  const publishRes = await axios.post(
    `https://graph.facebook.com/v19.0/${IG_ACCOUNT_ID}/media_publish`,
    null,
    {
      params: {
        creation_id: mediaRes.data.id,
        access_token: IG_TOKEN,
      },
    }
  );

  console.log('PUBLISHED:', publishRes.data);
  return publishRes.data;
}

app.get('/', (req, res) => {
  res.send('Instagram Scheduler backend is running ✅');
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    port: PORT,
    hasInstagramAccountId: Boolean(IG_ACCOUNT_ID),
    hasInstagramToken: Boolean(IG_TOKEN),
    hasCloudinary: Boolean(
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
    ),
    queuedPosts: scheduledPosts.filter((p) => p.status === 'queued').length,
  });
});

async function handlePublishNow(req, res) {
  try {
    console.log('PUBLISH NOW BODY:', req.body);
    console.log(
      'PUBLISH NOW FILE:',
      req.file
        ? {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
          }
        : null
    );

    const missing = validateEnv({ requireCloudinary: true });
    if (missing.length) {
      return res.status(400).json({
        ok: false,
        message: 'Missing environment variables',
        missing,
      });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'No image uploaded' });
    }

    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({
        ok: false,
        message: 'Uploaded file must be an image',
        mimetype: req.file.mimetype,
      });
    }

    const caption = req.body.caption || '';
    const uploaded = await uploadToCloudinary(req.file.buffer);
    const imageUrl = uploaded.secure_url.replace('/upload/', '/upload/f_jpg,q_auto/');

    console.log('Cloudinary uploaded:', imageUrl);

    const result = await publishToInstagram({ imageUrl, caption });

    return res.json({
      ok: true,
      message: 'Published successfully',
      cloudinaryUrl: imageUrl,
      instagram: result,
    });
  } catch (error) {
    const metaError = getMetaError(error);
    console.log('FULL ERROR:', JSON.stringify(metaError, null, 2));
    return res.status(400).json({ ok: false, error: metaError });
  }
}

app.post('/api/publish-now', upload.single('image'), handlePublishNow);
app.post('/publish-now', upload.single('image'), handlePublishNow);

// رفع عدة صور وجدولتها: صورة واحدة يومياً بنفس الوقت
app.post('/api/schedule-bulk', upload.array('images'), async (req, res) => {
  try {
    const missing = validateEnv({ requireCloudinary: true });
    if (missing.length) {
      return res.status(400).json({
        ok: false,
        message: 'Missing environment variables',
        missing,
      });
    }

    const { caption = '', publishTime = '09:00', startDate } = req.body;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ ok: false, message: 'No images uploaded' });
    }

    const [hour, minute] = publishTime.split(':').map(Number);
    if (Number.isNaN(hour) || Number.isNaN(minute)) {
      return res.status(400).json({ ok: false, message: 'Invalid publishTime' });
    }

    const baseDate = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
    const created = [];

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];

      if (!file.mimetype.startsWith('image/')) {
        return res.status(400).json({
          ok: false,
          message: 'All uploaded files must be images',
          filename: file.originalname,
          mimetype: file.mimetype,
        });
      }

      const uploaded = await uploadToCloudinary(file.buffer);
      const imageUrl = uploaded.secure_url.replace('/upload/', '/upload/f_jpg,q_auto/');

      const publishAt = new Date(baseDate);
      publishAt.setDate(baseDate.getDate() + i);
      publishAt.setHours(hour, minute, 0, 0);

      // إذا وقت أول صورة فات اليوم، تبدأ من بكرة تلقائياً
      if (i === 0 && publishAt <= new Date()) {
        publishAt.setDate(publishAt.getDate() + 1);
      }

      const post = {
        id: `${Date.now()}-${i}`,
        originalName: file.originalname,
        imageUrl,
        caption,
        publishAt: publishAt.toISOString(),
        status: 'queued',
        instagram: null,
        error: null,
      };

      scheduledPosts.push(post);
      created.push(post);

      console.log('[schedule-bulk] Scheduled:', post.originalName, post.publishAt);
    }

    return res.json({
      ok: true,
      message: `Scheduled ${created.length} images successfully`,
      count: created.length,
      posts: created,
    });
  } catch (error) {
    const metaError = getMetaError(error);
    console.log('[schedule-bulk] FULL ERROR:', JSON.stringify(metaError, null, 2));
    return res.status(400).json({ ok: false, error: metaError });
  }
});

app.get('/api/scheduled-posts', (req, res) => {
  res.json({ ok: true, posts: scheduledPosts });
});

app.post('/api/clear-scheduled', (req, res) => {
  scheduledPosts.length = 0;
  res.json({ ok: true, message: 'Scheduled posts cleared' });
});

app.get('/publish-test', async (req, res) => {
  try {
    const imageUrl = req.query.imageUrl;
    const caption = req.query.caption || 'Test post from Instagram Scheduler 🚀';

    const missing = validateEnv({ requireCloudinary: false });
    if (missing.length) {
      return res.status(400).json({
        ok: false,
        message: 'Missing environment variables',
        missing,
      });
    }

    if (!imageUrl) {
      return res.status(400).json({
        ok: false,
        message: 'Add ?imageUrl=https://example.com/image.jpg',
      });
    }

    const result = await publishToInstagram({ imageUrl, caption });

    return res.json({
      ok: true,
      message: 'Published successfully',
      instagram: result,
    });
  } catch (error) {
    const metaError = getMetaError(error);
    console.log('FULL ERROR:', JSON.stringify(metaError, null, 2));
    return res.status(400).json({ ok: false, error: metaError });
  }
});

// يفحص كل دقيقة وينشر أي صورة وصل وقتها
cron.schedule('* * * * *', async () => {
  try {
    console.log('[scheduler] Running publish job at', new Date().toISOString());

    const now = new Date();
    const readyPosts = scheduledPosts.filter(
      (post) => post.status === 'queued' && new Date(post.publishAt) <= now
    );

    if (readyPosts.length === 0) {
      console.log('[scheduler] Result:', { ok: true, message: 'No queued posts ready.' });
      return;
    }

    // ينشر بالترتيب: صورة واحدة فقط في كل تشغيل
    const post = readyPosts.sort((a, b) => new Date(a.publishAt) - new Date(b.publishAt))[0];

    console.log('[scheduler] Publishing:', post.originalName, post.publishAt);

    try {
      const result = await publishToInstagram({
        imageUrl: post.imageUrl,
        caption: post.caption,
      });

      post.status = 'posted';
      post.instagram = result;
      post.postedAt = new Date().toISOString();
      console.log('[scheduler] Posted successfully ✅');
    } catch (error) {
      const metaError = getMetaError(error);
      post.status = 'failed';
      post.error = metaError;
      console.log('[scheduler] Publish failed:', JSON.stringify(metaError, null, 2));
    }
  } catch (error) {
    const metaError = getMetaError(error);
    console.log('[scheduler] FULL ERROR:', JSON.stringify(metaError, null, 2));
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Instagram Account ID:', IG_ACCOUNT_ID ? 'Loaded ✅' : 'Missing ❌');
  console.log('Instagram Token:', IG_TOKEN ? 'Loaded ✅' : 'Missing ❌');
});
