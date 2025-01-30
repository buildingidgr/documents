# Document API Documentation

This documentation describes how to interact with the Document API endpoints using tRPC.

## Creating a Document

### Endpoint
```typescript
document.create
```

### Authentication
- **Required**: Yes
- **Type**: Bearer token authentication

### Request Body
```typescript
{
  title: string,
  content: any  // Can be any valid JSON data
}
```

### Example Request using tRPC Client

```typescript
import { createTRPCProxyClient } from '@trpc/client';
import type { AppRouter } from './path-to-your-router';

// Initialize the tRPC client
const trpc = createTRPCProxyClient<AppRouter>({
  url: 'YOUR_API_URL',
  headers: {
    Authorization: 'Bearer YOUR_AUTH_TOKEN'
  }
});

// Create a new document
try {
  const newDocument = await trpc.document.create.mutate({
    title: "My New Document",
    content: {
      // Your document content here
      text: "Hello World",
      // Add any other fields as needed
    }
  });

  console.log('Document created:', newDocument);
} catch (error) {
  console.error('Error creating document:', error);
}
```

### Response
On success, the API will return the created document object:
```typescript
{
  id: string;
  title: string;
  content: any;
  createdAt: Date;
  updatedAt: Date;
  // ... other document fields
}
```

### Error Responses

The API may return the following errors:

1. **400 Bad Request**
   - When title or content is missing
   ```typescript
   {
     code: 'BAD_REQUEST',
     message: 'Invalid input: title and content are required'
   }
   ```

2. **401 Unauthorized**
   - When authentication token is missing or invalid

3. **500 Internal Server Error**
   - When there's a server-side error processing the request

### Best Practices

1. **Error Handling**
   - Always implement proper error handling in your client code
   - Check for specific error codes and messages to provide appropriate feedback to users

2. **Content Structure**
   - While the content field accepts any valid JSON data, maintain a consistent structure for your documents
   - Consider implementing a schema for your content based on your application's needs

3. **Authentication**
   - Store authentication tokens securely
   - Implement token refresh mechanisms if required
   - Never expose tokens in client-side code or version control

## Deleting a Document

### Endpoint
```typescript
document.delete
```

### Authentication
- **Required**: Yes
- **Type**: Bearer token authentication

### Request Body
```typescript
{
  id: string  // The ID of the document to delete
}
```

### Example Request using tRPC Client

```typescript
try {
  const result = await trpc.document.delete.mutate({
    id: "document-id-here"
  });

  console.log('Document deleted:', result);
} catch (error) {
  console.error('Error deleting document:', error);
}
```

### Response
On success, the API will return:
```typescript
{
  success: true,
  id: string  // The ID of the deleted document
}
```

### Error Responses

1. **404 Not Found**
   - When the document doesn't exist or user doesn't have access
   ```typescript
   {
     code: 'NOT_FOUND',
     message: 'Document not found or you do not have permission to delete it'
   }
   ```

2. **401 Unauthorized**
   - When authentication token is missing or invalid

3. **500 Internal Server Error**
   - When there's a server-side error processing the request

### Security Considerations

1. **Access Control**
   - Only users with access to the document can delete it
   - The API performs authorization checks before deletion
   - Deletion is permanent and cannot be undone

2. **Cascading Deletion**
   - Deleting a document will also delete all associated versions and data
   - Ensure users understand the implications of document deletion

## Rate Limiting and Performance

- Implement appropriate rate limiting in your client code
- Consider implementing retry mechanisms with exponential backoff for failed requests
- Cache document data where appropriate to reduce API calls 