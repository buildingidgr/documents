# PUT Document API

## Endpoint

```
PUT /api/document/:id
```

## Description

Updates an existing document's title and/or content. When content is updated, a new version is automatically created.

## Authentication

Requires Bearer token authentication.

```
Authorization: Bearer <token>
```

## Request Parameters

### Path Parameters

| Parameter | Type   | Description         |
|-----------|--------|---------------------|
| id        | string | The document's ID   |

### Request Body

```typescript
{
  title?: string;           // Optional: New title for the document
  content?: {              // Optional: New content for the document
    type: 'doc';
    content: Array<{
      type: string;
      children: Array<{
        type: string;
        text?: string;
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
        [key: string]: any;  // Other formatting attributes
      }>;
      [key: string]: any;   // Other element attributes
    }>;
  };
}
```

## Responses

### 200 OK

Successfully updated the document.

```json
{
  "id": "string",
  "title": "string",
  "content": {
    "type": "doc",
    "content": [...]
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
      "content": {...},
      "createdAt": "string"
    }
  ]
}
```

### 400 Bad Request

Invalid request data.

```json
{
  "error": "Invalid content structure"
}
```

### 401 Unauthorized

Authentication issues.

```json
{
  "error": "Authentication required",
  "code": "AUTH_REQUIRED",
  "message": "No authorization header provided"
}
```

### 403 Forbidden

User doesn't have permission to modify the document.

```json
{
  "error": "Access denied",
  "code": "ACCESS_DENIED",
  "message": "You do not have permission to modify this document"
}
```

### 404 Not Found

Document doesn't exist.

```json
{
  "error": "Document not found",
  "code": "DOCUMENT_NOT_FOUND",
  "message": "The requested document does not exist"
}
```

### 500 Internal Server Error

Server-side error occurred.

```json
{
  "error": "Failed to update document"
}
```

## Notes

- At least one of `title` or `content` must be provided in the request body
- When content is updated, a new version is automatically created and linked to the document
- The content structure follows the Plate.js editor format
- All existing user associations are preserved during the update 