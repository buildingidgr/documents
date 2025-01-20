import { NextRequest, NextResponse } from 'next/server';
import { createPresignedUploadUrl } from '@/lib/s3';
import { authenticateUser } from '@/server/auth';
import { db } from '@/server/db';
import { randomUUID } from 'crypto';
import type { FileStatus } from '@prisma/client';

export async function POST(req: NextRequest) {
  console.log("\n=== UPLOAD REQUEST STARTED ===");
  
  try {
    // Authenticate request
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return NextResponse.json({ error: "Missing authorization header" }, { status: 401 });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return NextResponse.json({ error: "Invalid authorization format" }, { status: 401 });
    }

    const userId = await authenticateUser(token);
    if (!userId) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    // Parse request body
    const body = await req.json();
    const { fileName, fileType, fileSize } = body;

    if (!fileName || !fileType || !fileSize) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Generate unique key for S3
    const fileId = randomUUID();
    const key = `${userId}/${fileId}/${fileName}`;

    // Get presigned URL
    const { url, fields } = await createPresignedUploadUrl(key, fileType);

    // Construct the final S3 URL
    const s3Url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

    // Create file record in database
    const file = await db.file.create({
      data: {
        id: fileId,
        userId,
        name: fileName,
        type: fileType,
        size: fileSize,
        key,
        url: s3Url,
        status: "pending" as FileStatus,
        metadata: {
          fileType,
          description: '',
          version: 1
        }
      }
    });

    return NextResponse.json({
      fileId: file.id,
      uploadUrl: url,
      fields
    });

  } catch (error) {
    console.error("Error handling upload request:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
} 