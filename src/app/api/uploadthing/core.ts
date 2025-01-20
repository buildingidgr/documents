import { createUploadthing, type FileRouter } from "uploadthing/next";
import { authenticateUser } from "@/server/auth";
import { db } from "@/server/db";
import type { FileStatus } from "@prisma/client";

const f = createUploadthing();

export const ourFileRouter = {
  fileUploader: f({
    pdf: { maxFileSize: "32MB", maxFileCount: 1 },
    image: { maxFileSize: "16MB", maxFileCount: 1 },
    text: { maxFileSize: "16MB", maxFileCount: 1 }
  })
    .middleware(async ({ req }) => {
      const authHeader = req.headers.get("authorization");
      if (!authHeader) throw new Error("Missing authorization header");

      const token = authHeader.split(' ')[1];
      if (!token) throw new Error("Invalid authorization format");

      const userId = await authenticateUser(token);
      if (!userId) throw new Error("Invalid token");

      return { userId };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      const newFile = await db.file.create({
        data: {
          userId: metadata.userId,
          name: file.name,
          type: file.type,
          size: file.size,
          url: file.url,
          key: file.key,
          status: "pending" as FileStatus,
          metadata: {
            fileType: file.type,
            description: '',
            version: 1
          }
        }
      });

      return {
        fileId: newFile.id,
        url: file.url
      };
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter; 