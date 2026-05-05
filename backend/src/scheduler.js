const cron = require('node-cron');
const { get, run } = require('./db');
const { publishInstagramImage } = require('./instagram');
require('dotenv').config();

function publicImageUrl(post) {
  if (post.image_url) return post.image_url;

  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!base) {
    throw new Error('PUBLIC_BASE_URL is required when Cloudinary is not configured. الأفضل تضيف Cloudinary في ملف .env.');
  }

  return `${base}/uploads/${encodeURIComponent(post.filename)}`;
}

async function publishPost(post) {
  try {
    await run('UPDATE posts SET status = ?, error_message = NULL WHERE id = ?', ['publishing', post.id]);

    const imageUrl = publicImageUrl(post);
    const result = await publishInstagramImage({ imageUrl, caption: post.caption });

    await run(
      `UPDATE posts
       SET status = ?, instagram_creation_id = ?, instagram_media_id = ?, published_at = CURRENT_TIMESTAMP, error_message = NULL
       WHERE id = ?`,
      ['published', result.creationId, result.mediaId, post.id]
    );

    return { ok: true, postId: post.id, mediaId: result.mediaId };
  } catch (error) {
    await run('UPDATE posts SET status = ?, error_message = ? WHERE id = ?', ['failed', error.message, post.id]);
    return { ok: false, postId: post.id, error: error.message };
  }
}

async function publishNextQueuedPost() {
  const post = await get(
    `SELECT * FROM posts
     WHERE status = 'queued'
       AND (scheduled_for IS NULL OR datetime(scheduled_for) <= datetime('now'))
     ORDER BY COALESCE(scheduled_for, created_at), id
     LIMIT 1`
  );

  if (!post) return { ok: true, message: 'No queued posts ready.' };
  return publishPost(post);
}

function startScheduler() {
  // يفحص كل دقيقة وينشر أي صورة وصل موعدها.
  // إذا تريد نشر صورة واحدة يوميًا فقط، غيّر CHECK_EVERY_MINUTE=false في .env.
  const checkEveryMinute = String(process.env.CHECK_EVERY_MINUTE || 'true') === 'true';
  const expression = checkEveryMinute
    ? '* * * * *'
    : `${Number(process.env.DAILY_PUBLISH_MINUTE || 0)} ${Number(process.env.DAILY_PUBLISH_HOUR || 9)} * * *`;

  cron.schedule(expression, async () => {
    console.log(`[scheduler] Running publish job at ${new Date().toISOString()}`);
    const result = await publishNextQueuedPost();
    console.log('[scheduler] Result:', result);
  });

  console.log(`[scheduler] Scheduled job: ${expression}`);
}

module.exports = { startScheduler, publishNextQueuedPost, publishPost };
