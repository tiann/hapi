export type SSERecording = {
    type?: string
    [key: string]: unknown
}

export const sseRecordings: SSERecording[] = [
    {
        "type": "connection-changed",
        "data": {
            "status": "connected",
            "subscriptionId": "369447e6-8f66-42a1-8811-1a68cf423771"
        }
    },
    {
        "type": "session-updated",
        "sessionId": "f741aba2-fbfa-4abb-8118-28bea58b4cd7",
        "data": {
            "id": "f741aba2-fbfa-4abb-8118-28bea58b4cd7",
            "namespace": "default",
            "seq": 1,
            "createdAt": 1770342968333,
            "updatedAt": 1770342968333,
            "active": false,
            "activeAt": 1770342968333,
            "metadata": {
                "path": "",
                "host": "",
                "name": "Contract Recording Updated"
            },
            "metadataVersion": 2,
            "agentState": null,
            "agentStateVersion": 1,
            "thinking": false,
            "thinkingAt": 0
        },
        "namespace": "default"
    },
    {
        "type": "machine-updated",
        "machineId": "machine-contract-1770342968363",
        "data": {
            "id": "machine-contract-1770342968363",
            "namespace": "default",
            "seq": 0,
            "createdAt": 1770342968376,
            "updatedAt": 1770342968376,
            "active": false,
            "activeAt": 1770342968376,
            "metadata": {
                "host": "recording-host",
                "platform": "unknown",
                "happyCliVersion": "unknown"
            },
            "metadataVersion": 1,
            "runnerState": null,
            "runnerStateVersion": 1
        },
        "namespace": "default"
    },
    {
        "type": "session-updated",
        "sessionId": "f741aba2-fbfa-4abb-8118-28bea58b4cd7",
        "data": {
            "activeAt": 1770342968495,
            "thinking": false
        },
        "namespace": "default"
    },
    {
        "type": "message-received",
        "sessionId": "f741aba2-fbfa-4abb-8118-28bea58b4cd7",
        "message": {
            "id": "ff83e26c-ab2b-470f-ae9b-0955f396e82a",
            "seq": 1,
            "localId": null,
            "content": {
                "role": "user",
                "content": "recording"
            },
            "createdAt": 1770342968497
        },
        "namespace": "default"
    },
    {
        "type": "message-received",
        "sessionId": "f741aba2-fbfa-4abb-8118-28bea58b4cd7",
        "message": {
            "id": "83f434dc-68bc-48f8-b742-157f88fbdf6a",
            "seq": 2,
            "localId": null,
            "content": {
                "role": "user",
                "content": {
                    "type": "text",
                    "text": "contract recording message",
                    "attachments": []
                },
                "meta": {
                    "sentFrom": "webapp"
                }
            },
            "createdAt": 1770342968524
        },
        "namespace": "default"
    }
]
