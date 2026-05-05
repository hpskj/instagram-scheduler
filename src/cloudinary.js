const { v2: cloudinary } = require('cloudinary');
require('dotenv').config();

function hasCloudinaryConfig() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function configureCloudinary() {
  if (!hasCloudinaryConfig()) return false;

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });

  return true;
}

async function uploadImageToCloudinary(filePath) {
  if (!configureCloudinary()) {
    return null;
  }

  const result = await cloudinary.uploader.upload(filePath, {
    folder: process.env.CLOUDINARY_FOLDER || 'instagram-scheduler',
    resource_type: 'image'
  });

  return {
    imageUrl: result.secure_url,
    publicId: result.public_id
  };
}

async function deleteImageFromCloudinary(publicId) {
  if (!publicId || !configureCloudinary()) return;
  await cloudinary.uploader.destroy(publicId);
}

module.exports = {
  hasCloudinaryConfig,
  uploadImageToCloudinary,
  deleteImageFromCloudinary
};
