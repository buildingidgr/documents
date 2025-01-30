# Document HTTP API Documentation

## Create Document

Creates a new document in the system with the specified title and content.

### HTTP Request

```http
POST /api/document/create
```

### Headers

```http
Content-Type: application/json
Authorization: Bearer YOUR_AUTH_TOKEN
```

### Request Body Schema

```json
{
  "title": "string",
  "content": {
    "type": "doc",
    "content": [
      {
        "type": "string",
        "content": [
          {
            "type": "string",
            "text": "string",
            "content": []
          }
        ]
      }
    ]
  }
}
```

#### Request Body Parameters

| Parameter | Type   | Required | Description                                      |
|-----------|--------|----------|--------------------------------------------------|
| title     | string | Yes      | The title of the document                        |
| content   | object | Yes      | The document content in Plate.js format          |

### Example Request

```bash
curl -X POST 'baseURL/api/document/create' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer YOUR_AUTH_TOKEN' \
-d '{
  "title": "My New Document",
  "content": {
    "type": "doc",
    "content": [
      {
        "type": "paragraph",
        "content": [
          {
            "type": "text",
            "text": "Hello World"
          }
        ]
      }
    ]
  }
}'
```

### Success Response

**Status Code:** 201 Created

```json
{
  "id": "string",
  "title": "string",
  "content": {
    "type": "doc",
    "content": []
  },
  "users": [
    {
      "id": "string",
      "name": "string"
    }
  ],
  "versions": [
    {
      "id": "string",
      "content": {
        "type": "doc",
        "content": []
      },
      "createdAt": "string",
      "userId": "string",
      "user": {
        "id": "string",
        "name": "string"
      }
    }
  ]
}
```

### Error Responses

#### 400 Bad Request
When the request body format is invalid:

```json
{
  "error": "Invalid document format",
  "code": "INVALID_FORMAT",
  "message": "The document format is invalid",
  "details": [
    {
      "code": "invalid_type",
      "message": "Expected string, received null",
      "path": ["title"]
    }
  ]
}
```

#### 401 Unauthorized
When authentication fails:

```json
{
  "error": "Authentication required",
  "code": "AUTH_REQUIRED",
  "message": "No authorization header provided"
}
```

Or when token is invalid:

```json
{
  "error": "Invalid token",
  "code": "INVALID_TOKEN",
  "message": "Authentication token is invalid"
}
```

Or when token has expired:

```json
{
  "error": "Token expired",
  "code": "TOKEN_EXPIRED",
  "message": "Authentication token has expired"
}
```

#### 405 Method Not Allowed
When using an unsupported HTTP method:

```json
{
  "error": "Method not allowed",
  "code": "METHOD_NOT_ALLOWED",
  "message": "Only POST method is allowed for this endpoint"
}
```

#### 409 Conflict
When the document already exists:

```json
{
  "error": "Document already exists",
  "code": "DOCUMENT_EXISTS",
  "message": "A document with this identifier already exists"
}
```

#### 503 Service Unavailable
When the service is temporarily unavailable:

```json
{
  "error": "Service temporarily unavailable",
  "code": "SERVICE_UNAVAILABLE",
  "message": "Please try again later",
  "retryAfter": 2
}
```

### Notes

1. **Authentication**
   - The endpoint requires a valid JWT token in the Authorization header
   - The token must be prefixed with "Bearer "
   - Invalid or expired tokens will result in 401 responses

2. **Content Format**
   - The content must follow the Plate.js document structure
   - All content must be properly nested with correct types
   - The content structure is validated before processing

3. **Transactions**
   - Document creation is wrapped in a transaction
   - Includes automatic retries for certain types of failures
   - Maximum transaction wait time: 5 seconds
   - Transaction timeout: 10 seconds

4. **Rate Limiting**
   - The API implements retry mechanisms for certain errors
   - Pay attention to `retryAfter` values in error responses
   - Implement exponential backoff for retries

### Example Implementation (JavaScript/Fetch)

```javascript
async function createDocument(title, content, authToken) {
  try {
    const response = await fetch('baseURL/api/document/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        title,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: content
                }
              ]
            }
          ]
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      if (errorData.retryAfter) {
        // Implement retry logic
        console.log(`Retry after ${errorData.retryAfter} seconds`);
      }
      throw new Error(errorData.message);
    }

    return await response.json();
  } catch (error) {
    console.error('Error creating document:', error);
    throw error;
  }
}

// Usage example
try {
  const newDocument = await createDocument(
    'My New Document',
    'Hello World',
    'your-auth-token'
  );
  console.log('Document created:', newDocument);
} catch (error) {
  console.error('Failed to create document:', error);
}
``` 