import { createUploadthing, type FileRouter } from "uploadthing/next";
import { authenticateUser } from "./auth";
import { db } from "./db";
import type { FileStatus } from "@prisma/client";

console.log("UploadThing configuration module loaded");

const f = createUploadthing();

console.log("Creating file router with allowed types: pdf, image, text");

export const ourFileRouter = {
  fileUploader: f({
    pdf: { maxFileSize: "32MB" },
    image: { maxFileSize: "16MB" },
    text: { maxFileSize: "16MB" }
  })
    .middleware(async ({ req }) => {
      console.log("\n--- UPLOAD REQUEST STARTED ---");
      console.log("Middleware triggered at:", new Date().toISOString());
      console.log("Raw headers:", req.headers);
      console.log("Content type:", req.headers.get("content-type"));
      console.log("Authorization present:", !!req.headers.get("authorization"));

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
        console.log("Token validation starting...");

        const userId = await authenticateUser(token);
        if (!userId) {
          console.error("Invalid token - auth failed");
          throw new Error("Invalid token");
        }
        console.log("Authentication successful for user:", userId);

        return { userId };
      } catch (error) {
        console.error("\n--- UPLOAD ERROR IN MIDDLEWARE ---");
        console.error("Error details:", {
          message: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          time: new Date().toISOString()
        });
        throw error;
      }
    })
    .onUploadComplete(async ({ metadata, file }) => {
      console.log("\n--- UPLOAD COMPLETE TRIGGERED ---");
      console.log("File details:", {
        name: file.name,
        type: file.type,
        size: file.size,
        userId: metadata.userId,
        time: new Date().toISOString()
      });

      try {
        await db.$transaction(async (prisma) => {
          console.log("Starting database transaction for file:", file.name);
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
          console.log("File record created:", newFile.id);
        });
        
        console.log("\n--- UPLOAD PROCESS COMPLETED ---");
        console.log("Success details:", {
          name: file.name,
          type: file.type,
          size: file.size,
          url: file.url,
          time: new Date().toISOString()
        });
      } catch (error) {
        console.error("\n--- UPLOAD ERROR IN COMPLETION ---");
        console.error("Error details:", {
          message: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          file: {
            name: file.name,
            type: file.type,
            size: file.size
          },
          time: new Date().toISOString()
        });
        throw error;
      }
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter; 