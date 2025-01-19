import { createUploadthing, type FileRouter } from "uploadthing/next";
import { authenticateUser } from "./auth";
import { db } from "./db";
import type { FileStatus } from "@prisma/client";

const f = createUploadthing();

export const ourFileRouter = {
  fileUploader: f({
    pdf: { maxFileSize: "32MB" },
    image: { maxFileSize: "16MB" },
    text: { maxFileSize: "16MB" }
  })
    .middleware(async ({ req }) => {
      console.log("UploadThing middleware started");
      console.log("Request headers:", {
        auth: req.headers.get("authorization")?.substring(0, 20) + "...",
        contentType: req.headers.get("content-type"),
      });

      try {
        const authHeader = req.headers.get("authorization");
        if (!authHeader) {
          console.error("Missing authorization header");
          throw new Error("Missing authorization header");
        }

        const token = authHeader.split(' ')[1];
        if (!token) {
          console.error("Invalid authorization format");
          throw new Error("Invalid authorization format");
        }
        console.log("Token extracted successfully");

        const userId = await authenticateUser(token);
        if (!userId) {
          console.error("Invalid token - auth failed");
          throw new Error("Invalid token");
        }
        console.log("User authenticated successfully:", { userId });

        return { userId };
      } catch (error) {
        console.error("UploadThing middleware error:", {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
      }
    })
    .onUploadComplete(async ({ metadata, file }) => {
      console.log("Upload complete handler started", {
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        userId: metadata.userId
      });

      try {
        await db.$transaction(async (prisma) => {
          console.log("Starting database transaction");
          const newFile = await prisma.file.create({
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
          console.log("File record created in database:", { fileId: newFile.id });
        });
        
        console.log("File upload process completed successfully:", {
          name: file.name,
          type: file.type,
          size: file.size,
          url: file.url
        });
      } catch (error) {
        console.error("Error in onUploadComplete:", {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          file: {
            name: file.name,
            type: file.type,
            size: file.size
          }
        });
        throw error;
      }
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter; 