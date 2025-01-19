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
      try {
        const authHeader = req.headers.get("authorization");
        if (!authHeader) throw new Error("Missing authorization header");

        const token = authHeader.split(' ')[1];
        if (!token) throw new Error("Invalid authorization format");

        const userId = await authenticateUser(token);
        if (!userId) throw new Error("Invalid token");

        return { userId };
      } catch (error) {
        console.error("UploadThing middleware error:", error);
        throw error;
      }
    })
    .onUploadComplete(async ({ metadata, file }) => {
      try {
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
        
        console.log("File uploaded successfully:", {
          name: file.name,
          type: file.type,
          size: file.size
        });
      } catch (error) {
        console.error("Error saving file to database:", error);
        throw error;
      }
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter; 