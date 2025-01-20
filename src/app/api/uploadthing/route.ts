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
  console.log("\n=== UPLOAD REQUEST STARTED ===");
  console.log("POST request received at /api/uploadthing");
  console.log("Request headers:", Object.fromEntries(req.headers.entries()));
  
  // Clone the request to read the body
  const clone = req.clone();
  try {
    const body = await clone.json();
    console.log("Request body:", JSON.stringify(body, null, 2));
  } catch (e) {
    try {
      const formData = await clone.formData();
      console.log("Form data keys:", Array.from(formData.keys()));
      for (const [key, value] of formData.entries()) {
        if (value instanceof File) {
          console.log(`Form data ${key}:`, {
            name: value.name,
            type: value.type,
            size: value.size
          });
        } else {
          console.log(`Form data ${key}:`, value);
        }
      }
    } catch (e2) {
      console.log("Could not parse request body");
    }
  }

  try {
    const response = await handler.POST(req);
    console.log("Response status:", response.status);
    const responseClone = response.clone();
    try {
      const responseBody = await responseClone.json();
      console.log("Response body:", JSON.stringify(responseBody, null, 2));
    } catch (e) {
      console.log("Could not parse response body");
    }
    console.log("=== UPLOAD REQUEST COMPLETED ===\n");
    return response;
  } catch (error) {
    console.error("Error in upload:", error);
    throw error;
  }
}; 