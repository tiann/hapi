export type HttpRecording = {
    method: string
    path: string
    request: {
        headers: Record<string, string>
        body?: unknown
    }
    response: {
        status: number
        headers: Record<string, string>
        body: unknown
    }
}

export const httpRecordings: HttpRecording[] = [
    {
        "method": "GET",
        "path": "/health",
        "request": {
            "headers": {
                "content-type": "application/json"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/auth",
        "request": {
            "headers": {
                "content-type": "application/json"
            },
            "body": {
                "initData": "string"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/auth",
        "request": {
            "headers": {
                "content-type": "application/json"
            },
            "body": {
                "accessToken": "string"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/bind",
        "request": {
            "headers": {
                "content-type": "application/json"
            },
            "body": {
                "initData": "string",
                "accessToken": "string"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/sessions",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/resume",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/abort",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/archive",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/switch",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "PATCH",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            },
            "body": {
                "name": "string"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "DELETE",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/permission-mode",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            },
            "body": {
                "mode": "string"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/model",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            },
            "body": {
                "model": "string"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/slash-commands",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/skills",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/upload",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            },
            "body": {
                "filename": "string",
                "content": "base64",
                "mimeType": "string"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/upload/delete",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            },
            "body": {
                "path": "string"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/messages?limit=50&beforeSeq=0",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/messages",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            },
            "body": {
                "text": "string",
                "attachments": []
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/machines",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/machines/f741aba2-fbfa-4abb-8118-28bea58b4cd7/spawn",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            },
            "body": {
                "directory": "string"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/machines/f741aba2-fbfa-4abb-8118-28bea58b4cd7/paths/exists",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            },
            "body": {
                "paths": []
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/git-status",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/git-diff-numstat?staged=false",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/git-diff-file?path=string&staged=false",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/file?path=string",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/files?query=string&limit=200",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/push/vapid-public-key",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/push/subscribe",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            },
            "body": {
                "endpoint": "string",
                "keys": {
                    "p256dh": "string",
                    "auth": "string"
                }
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "DELETE",
        "path": "/api/push/subscribe",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            },
            "body": {
                "endpoint": "string"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/voice/token",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            },
            "body": {
                "customAgentId": "string",
                "customApiKey": "string"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/api/events?all=true&sessionId=f741aba2-fbfa-4abb-8118-28bea58b4cd7&machineId=machine-contract-1770342968363&visibility=visible&token=eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/api/visibility",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEsIm5zIjoiZGVmYXVsdCIsImlhdCI6MTc3MDM0MzAyNCwiZXhwIjoxNzcwMzQzOTI0fQ.5WWecHlKCp4RcjohqenRFhPxdRuEdqJK53UVqVbsQuU"
            },
            "body": {
                "subscriptionId": "string",
                "visibility": "visible"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/cli/sessions",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer T840-mOvSjeDgHevd9WOh_dWKjrzOY1JIZIdJmolswQ"
            },
            "body": {
                "tag": "string",
                "metadata": {},
                "agentState": null
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/cli/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer T840-mOvSjeDgHevd9WOh_dWKjrzOY1JIZIdJmolswQ"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/cli/sessions/f741aba2-fbfa-4abb-8118-28bea58b4cd7/messages?afterSeq=0&limit=200",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer T840-mOvSjeDgHevd9WOh_dWKjrzOY1JIZIdJmolswQ"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "POST",
        "path": "/cli/machines",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer T840-mOvSjeDgHevd9WOh_dWKjrzOY1JIZIdJmolswQ"
            },
            "body": {
                "id": "string",
                "metadata": {},
                "runnerState": null
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    },
    {
        "method": "GET",
        "path": "/cli/machines/f741aba2-fbfa-4abb-8118-28bea58b4cd7",
        "request": {
            "headers": {
                "content-type": "application/json",
                "authorization": "Bearer T840-mOvSjeDgHevd9WOh_dWKjrzOY1JIZIdJmolswQ"
            }
        },
        "response": {
            "status": 0,
            "headers": {},
            "body": {
                "error": "Was there a typo in the url or port?"
            }
        }
    }
]
