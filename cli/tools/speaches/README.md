# Speaches (Docker, CPU)

Start:

```bash
docker compose -f tools/speaches/compose.cpu.yaml up -d
```

Health:

```bash
curl http://localhost:8000/health
```

Test transcription endpoint:

```bash
curl -sS http://localhost:8000/v1/audio/transcriptions \
  -F "model=Systran/faster-distil-whisper-small.en" \
  -F "file=@/path/to/audio.wav"
```

Hook into HAPI hub env:

```bash
LOCAL_WHISPER_URL=http://127.0.0.1:8000
LOCAL_WHISPER_MODEL=Systran/faster-distil-whisper-small.en
# if API_KEY enabled in Speaches:
# LOCAL_WHISPER_API_KEY=change-me
```

Then restart hub.
