import { createUploadthing, type FileRouter } from "uploadthing/next";
import { authenticateUser } from "./auth";
import { db } from "./db";
import type { NextApiRequest } from "next";
import type { FileStatus } from "@prisma/client";

const f = createUploadthing();

// Define allowed file types
const allowedFileTypes = {
  pdf: { maxFileSize: "32MB" },
  image: { maxFileSize: "16MB" },
  spreadsheet: { maxFileSize: "16MB" },
  // Custom file types will be handled through mime type checks
} as const;

// Define middleware request type
type UploadThingRequest = {
  headers: {
    get(name: string): string | null;
  };
};

// Define completion type
type UploadThingComplete = {
  metadata: {
    userId: string;
  };
  file: {
    name: string;
    type: string;
    size: number;
    url: string;
    key: string;
  };
};

export const ourFileRouter = {
  fileUploader: f(allowedFileTypes)
    .middleware(async ({ req }) => {
      const authHeader = req.headers.get("authorization");
      if (!authHeader) throw new Error("Unauthorized");

      const token = authHeader.split(' ')[1];
      if (!token) throw new Error("Unauthorized");

      const userId = await authenticateUser(token);
      if (!userId) throw new Error("Unauthorized");

      return { userId };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      await db.$transaction(async (prisma) => {
        await prisma.file.create({
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
      });
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter; 