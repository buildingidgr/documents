import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

// Validate AWS credentials
if (!process.env.AWS_ACCESS_KEY_ID) throw new Error('AWS_ACCESS_KEY_ID is required');
if (!process.env.AWS_SECRET_ACCESS_KEY) throw new Error('AWS_SECRET_ACCESS_KEY is required');
if (!process.env.AWS_BUCKET_NAME) throw new Error('AWS_BUCKET_NAME is required');

// Validate and normalize AWS region
const validRegions = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3',
  'eu-central-1',
  'ap-northeast-1', 'ap-northeast-2', 'ap-southeast-1', 'ap-southeast-2',
  'sa-east-1'
];

const region = process.env.AWS_REGION?.toLowerCase();
if (!region || !validRegions.includes(region)) {
  throw new Error(`Invalid AWS_REGION. Must be one of: ${validRegions.join(', ')}`);
}

export const s3Client = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

export async function createPresignedUploadUrl(key: string, contentType: string) {
  try {
    // Validate content type
    if (!contentType.match(/^(application\/pdf|image\/.*|text\/.*)$/)) {
      throw new Error('Invalid content type. Must be PDF, image, or text.');
    }

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
      bucket: BUCKET_NAME,
      key,
      region
    };
  } catch (error) {
    console.error('Error creating presigned URL:', error);
    throw error;
  }
} 