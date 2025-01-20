import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

if (!process.env.AWS_ACCESS_KEY_ID) throw new Error('AWS_ACCESS_KEY_ID is required');
if (!process.env.AWS_SECRET_ACCESS_KEY) throw new Error('AWS_SECRET_ACCESS_KEY is required');
if (!process.env.AWS_REGION) throw new Error('AWS_REGION is required');
if (!process.env.AWS_BUCKET_NAME) throw new Error('AWS_BUCKET_NAME is required');

export const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

export async function createPresignedUploadUrl(key: string, contentType: string) {
  try {
    const { url, fields } = await createPresignedPost(s3Client, {
      Bucket: BUCKET_NAME,
      Key: key,
      Conditions: [
        ['content-length-range', 0, 52428800], // 50MB max
        ['starts-with', '$Content-Type', contentType],
      ],
      Fields: {
        'Content-Type': contentType,
      },
      Expires: 600, // URL expires in 10 minutes
    });

    return {
      url,
      fields,
    };
  } catch (error) {
    console.error('Error creating presigned URL:', error);
    throw error;
  }
} 