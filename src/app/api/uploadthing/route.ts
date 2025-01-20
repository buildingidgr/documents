import { createRouteHandler } from "uploadthing/next";
import { ourFileRouter } from "./core";
import { NextRequest } from "next/server";

console.log("UploadThing route handler module loaded");

// Create the route handler
const handler = createRouteHandler({
  router: ourFileRouter,
});

// Export the route handlers with logging wrappers
export const GET = async (req: NextRequest) => {
  console.log("GET request received at /api/uploadthing");
  return handler.GET(req);
};

export const POST = async (req: NextRequest) => {
  console.log("POST request received at /api/uploadthing");
  console.log("Request headers:", Object.fromEntries(req.headers.entries()));
  return handler.POST(req);
}; 