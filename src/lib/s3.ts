import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

const validRegions = [
  // Americas
  'us-east-1',      // US East (N. Virginia)
  'us-east-2',      // US East (Ohio)
  'us-west-1',      // US West (N. California)
  'us-west-2',      // US West (Oregon)
  'ca-central-1',   // Canada (Central)
  'sa-east-1',      // South America (São Paulo)
  // Europe
  'eu-west-1',      // Europe (Ireland)
  'eu-west-2',      // Europe (London)
  'eu-west-3',      // Europe (Paris)
  'eu-central-1',   // Europe (Frankfurt)
  'eu-central-2',   // Europe (Zurich)
  'eu-south-1',     // Europe (Milan)
  'eu-south-2',     // Europe (Spain)
  'eu-north-1',     // Europe (Stockholm)
  // Asia Pacific
  'ap-east-1',      // Asia Pacific (Hong Kong)
  'ap-south-1',     // Asia Pacific (Mumbai)
  'ap-south-2',     // Asia Pacific (Hyderabad)
  'ap-southeast-1', // Asia Pacific (Singapore)
  'ap-southeast-2', // Asia Pacific (Sydney)
  'ap-southeast-3', // Asia Pacific (Jakarta)
  'ap-southeast-4', // Asia Pacific (Melbourne)
  'ap-northeast-1', // Asia Pacific (Tokyo)
  'ap-northeast-2', // Asia Pacific (Seoul)
  'ap-northeast-3', // Asia Pacific (Osaka)
  // Middle East
  'me-south-1',     // Middle East (Bahrain)
  'me-central-1',   // Middle East (UAE)
  // Africa
  'af-south-1'      // Africa (Cape Town)
];

function validateConfig() {
  if (!process.env.AWS_ACCESS_KEY_ID) throw new Error('AWS_ACCESS_KEY_ID is required');
  if (!process.env.AWS_SECRET_ACCESS_KEY) throw new Error('AWS_SECRET_ACCESS_KEY is required');
  if (!process.env.AWS_BUCKET_NAME) throw new Error('AWS_BUCKET_NAME is required');
  
  const region = process.env.AWS_REGION?.toLowerCase();
  if (!region || !validRegions.includes(region)) {
    throw new Error(`Invalid AWS_REGION. Must be one of: ${validRegions.join(', ')}`);
  }
  
  return {
    region,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    bucketName: process.env.AWS_BUCKET_NAME
  };
}

let s3Client: S3Client | null = null;
let config: ReturnType<typeof validateConfig> | null = null;

export function getS3Client() {
  if (!s3Client) {
    config = validateConfig();
    s3Client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }
  return s3Client;
}

export async function createPresignedUploadUrl(key: string, contentType: string) {
  try {
    if (!config) {
      config = validateConfig();
    }
    
    // Validate content type
    if (!contentType.match(/^(application\/pdf|image\/.*|text\/.*)$/)) {
      throw new Error('Invalid content type. Must be PDF, image, or text.');
    }

    const s3 = getS3Client();
    const { url, fields } = await createPresignedPost(s3, {
      Bucket: config.bucketName,
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
      bucket: config.bucketName,
      key,
      region: config.region
    };
  } catch (error) {
    console.error('Error creating presigned URL:', error);
    throw error;
  }
} 