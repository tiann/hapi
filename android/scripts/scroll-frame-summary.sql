-- Perfetto trace_processor: -q android/scripts/scroll-frame-summary.sql TRACE
-- Present cadence only during real drags; never divide frame count by idle time.
-- FrameTimeline Prediction Error / SurfaceFlinger Scheduling classifications in
-- an emulator are not a reliable app-jank score. Report app deadlines separately.
WITH phases AS (
    SELECT id, name, ts, dur FROM slice WHERE name GLOB 'HapiScroll:*'
), gestures AS (
    SELECT p.name AS phase, g.id, g.ts, g.dur
    FROM phases p JOIN slice g
      ON g.name = 'HapiGesture' AND g.ts >= p.ts AND g.ts + g.dur <= p.ts + p.dur
), frames AS (
    SELECT g.phase, g.id AS gesture, a.ts + a.dur AS presented,
           a.jank_type, a.on_time_finish
    FROM gestures g JOIN actual_frame_timeline_slice a
      ON a.ts + a.dur BETWEEN g.ts AND g.ts + g.dur
    WHERE a.layer_name GLOB '*run.hapi.companion*'
      AND a.dur > 0 AND a.present_type != 'Dropped Frame'
), intervals AS (
    SELECT *, (presented - LAG(presented) OVER (PARTITION BY gesture ORDER BY presented)) / 1e6 AS gap_ms
    FROM frames
)
SELECT phase,
       COUNT(DISTINCT gesture) AS gestures,
       COUNT(*) AS presented_frames,
       ROUND(1000 * COUNT(gap_ms) / SUM(gap_ms), 2) AS present_cadence_fps,
       ROUND(PERCENTILE(gap_ms, 50), 2) AS present_p50_ms,
       ROUND(PERCENTILE(gap_ms, 95), 2) AS present_p95_ms,
       ROUND(PERCENTILE(gap_ms, 99), 2) AS present_p99_ms,
       SUM(CASE WHEN on_time_finish = 0 THEN 1 ELSE 0 END) AS app_late_finish,
       SUM(CASE WHEN jank_type LIKE '%App Deadline Missed%' THEN 1 ELSE 0 END) AS app_deadline_missed
FROM intervals GROUP BY phase ORDER BY phase;

-- Must have all requested phases: a too-small ring buffer silently loses setup
-- and early scrolls even though the trace is otherwise parseable.
SELECT name FROM slice WHERE name GLOB 'HapiScroll:*' ORDER BY ts;

SELECT name, value, description FROM stats WHERE severity != 'info' AND value != 0;
