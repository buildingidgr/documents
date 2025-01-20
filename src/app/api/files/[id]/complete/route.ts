import { NextRequest, NextResponse } from 'next/server';
import { authenticateUser } from '@/server/auth';
import { db } from '@/server/db';

export const POST = async (
  req: NextRequest,
  { params }: { params: { id: string } }
) => {
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

    const fileId = params.id;

    // Find the file and verify ownership
    const file = await db.file.findFirst({
      where: {
        id: fileId,
        userId
      }
    });

    if (!file) {
      return NextResponse.json({
        error: "File not found",
        code: "FILE_NOT_FOUND",
        message: "The requested file does not exist"
      }, { status: 404 });
    }

    // Update file status to approved
    const updatedFile = await db.file.update({
      where: { id: fileId },
      data: {
        status: "approved"
      }
    });

    return NextResponse.json(updatedFile);
  } catch (error) {
    console.error("Error completing file upload:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
} 