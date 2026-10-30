# Native 聊天滚动：模拟器实测

日期：2026-09-10。业务代码基线：`5194271f`。

## 结论

1. **优先优化 iOS 的差量刷新与复杂内容测量，不继续盲目优化列表索引。**
   普通文本接近 60 Hz；复杂 Markdown 稳定出现约 33 ms 的帧回调间隔。
   叠加消息更新后进一步恶化。单变量实验已验证“刷新未变可见行”的额外成本。
2. **Android 必须区分应用工作与模拟器噪声。** 多数轮次接近 60 Hz，
   但完整复测也出现过 47–52 FPS 和超过 600 ms 的长帧；不能只展示好看的轮次。
   长帧调用链包含主线程等待 RenderThread 的 `postAndWait`，不应直接归因于
   Compose 列表重组。保留原始异常数据，增加离线、调度记录的控制实验。
3. 定位轮的**诊断用简化优化已回滚**。后续落地了保留 hosting roots、桥接实时
   renderer/environment 的差量刷新；见下文“iOS 优化落地”。没有冻结行高或
   为跑分停止传递主题、字体、内容、交互环境。

## 测量边界

- 主机：Apple M4 Pro，14 核，48 GiB；macOS 26.6.2，Xcode 26.6。
- iOS：专用 iPhone 15 / iOS 26.5 Simulator，Release `-O` / whole-module
  optimization，`ENABLE_TESTABILITY=YES`，显示回调请求 60 Hz。
- Android：专用 API 35 ARM64 模拟器，1080 × 1920 / 420 dpi，4 vCPU / 4 GiB；
  `-gpu host`，日志确认 Apple M4 Pro / Metal，而不是旧脚本的 SwiftShader。
  `profile` 构建：非 debuggable，未混淆，调试签名；不是商店分发 APK。
- 两个平台顺序运行，不同时压测。800 条合成消息，使用实际聊天行渲染器、
  Markdown 缓存及原生列表，不是几何占位方块；每种场景重复 3 次。
- 普通文本；复杂 Markdown（标题、列表、14 行代码、10 行 × 3 列表格、引用）；
  复杂 Markdown + 每秒 10 次离屏尾消息更新。AST 在开始前预热。
- iOS：真实 CADisplayLink 驱动 1,800 pt/s、每轮 6 秒的连续滚动。
  Android：真实 MotionEvent 拖动和自然减速，每轮 8 次；**不用 Compose 测试虚拟时钟**。
- 不包含 Hub/网络/消息归约耗时；没有覆盖分页到达、图片解码、键盘、120 Hz、
  极长代码、真实用户会话或低端真机。不能跨平台直接比较数字，也不代表发行版验收。

### “FPS”分别指什么

- iOS 的 Instruments `Animation Hitches` 明确返回 **“Hitches is not supported
  on this platform”**。因此下面是 **CADisplayLink 实际回调频率**，不是合成器
  最终呈现 FPS。P95/P99 来自墙钟回调间隔；`>25 ms` 是诊断阈值，不是 Apple hitch 指标。
- Time Profiler attach 在本环境无响应，已终止；CPU 证据来自另一次独立的
  macOS `sample` 1 ms 调用栈采样。带采样开销的运行不用于帧率基线。
- Android 同时记录 Choreographer 回调、Window.FrameMetrics、gfxinfo 和
  Perfetto FrameTimeline。呈现频率仅计算 **HapiGesture 拖动区间内** 连续呈现的
  间隔；不能拿整个测试时长（含停顿）除帧数。
- FrameTimeline 在此模拟器有大量 `Prediction Error` / `Early Present`，
  不能把所有 `jank_type != None` 统计成应用掉帧。应用 deadline miss 单独报告。
  各字段来自不同时间边界，FrameMetrics 超预算数不应等同 FrameTimeline missed 数。

## iOS 基线与单变量实验

| 场景 | 回调频率，三轮范围 | 回调间隔 P95 | >25 ms 间隔 / 全部间隔 |
| --- | ---: | ---: | ---: |
| 普通文本 | 59.83–59.84 /s | 16.72–16.73 ms | 3 / 1,079（0.28%） |
| 复杂 Markdown | 55.83–56.66 /s | 27.58–32.56 ms | 68 / 1,013（6.71%） |
| 复杂 Markdown + 10 Hz 更新 | 53.86–54.83 /s | 33.26–33.27 ms | 103 / 979（10.52%） |

独立 CPU 栈采样：32,440 个主线程样本，其中排除明确等待叶节点后 6,014 个。
路径占比可重叠，不是可相加的 CPU 分账，也不是精确耗时：

- `_UIHosting…` 路径：40.2%；`sizeThatFits`：32.8%；
  `preferredLayoutAttributesFitting`：27.6%；富文本布局 `StyledText`：16.9%。
- `TranscriptCollectionController.drain()` 路径：19.9%。
- `TranscriptLayout`：2.3%。主线程未采到 `MarkdownBlockTree` 或 Highlightr 路径。

源码对应：`AnchoredTranscriptList.swift` 的 `drain()` 在任何配置更新时，把
**所有可见 ID** 加入 `reconfigureItems`，即使变化只有离屏尾消息。原意是刷新
SwiftUI 环境快照；代价是重复配置 hosting roots、自适应测量和富文本布局。

诊断实验只删除 `|| visibleIDs.contains($0.id)`，其他代码与输入不变，重新启动进程
重复三轮，然后恢复原文件：

| 场景 | 原均值 → 实验均值 | >25 ms 间隔数 |
| --- | ---: | ---: |
| 普通文本 | 59.84 → 59.84 /s | 3 → 3 |
| 复杂 Markdown | 56.22 → 56.11 /s | 68 → 70 |
| 复杂 Markdown + 更新 | **54.29 → 55.62 /s** | **103 → 79** |

证据支持“小而明确的更新路径收益”，不是消除所有卡顿。实验没有改复杂内容本身，
静态复杂列表也没有改善。**不能直接发布这一删行方案**：主题、Dynamic Type、
locale、basePath、链接/交互环境变化仍必须传递到已有 hosting cells。

## iOS 优化落地：保留 hosting roots

改动限于列表与聊天入口，无 Markdown/协议重写：

- `reconfigureItems` 只处理内容或宽度变化，不再无条件加入所有可见 ID。
- 每个 hosting root 保留轻量 SwiftUI wrapper，读取共享的 observable renderer。
  最新 builder、basePath 等普通值捕获和 action captures 继续传入；SwiftUI 自己
  比较返回的视图，而非让 UIKit 每次重新安装 hosting 配置。
- 在 `updateUIViewController` 读取 `context.environment`，统一桥接到已有与新建行。
  不枚举可比较的环境键；主题、Dynamic Type、locale、方向、自定义服务都保留。
  试验中发现：仅在逃逸 builder 中读取父视图的 `@Environment(\.self)`，可能漏掉
  环境更新依赖。因此去掉聊天入口的手工快照，由列表负责传播。
- 快照串行化、锚点补偿、异步 self-sizing、隐藏页布局确认、重复 ID 防御不变。
  **仍会更新轻量 wrapper；不是宣称 SwiftUI 零工作或跳过所有测量。**

新增回归覆盖：离屏更新的零可见 cell 重配置预算、可见行增高与锚点、回收后最新
内容、相同 Item 下的主题/basePath/链接 action 更新、语言/方向/字号变化及重新测量。
UIKit 自身可能在方向 trait 改变时重新请求 cell；这不属于无条件消息刷新。

复测使用相同 Release 场景，按“新实现 → 旧实现复跑 → 新实现复跑”顺序，均独立
进程、专用模拟器。本轮新增计时前的渲染截图和可见复杂行高度断言，已本地查看截图；
旧/新实现初始行高一致。截图在计时区间外，但可能影响暖机，**收益只与本轮同一
测试器的旧实现复跑比较，不用上一轮 54.29 /s 直接计算提升。**

| 场景 | 旧实现复跑，均值 | 新实现第 1 / 第 2 批，均值 | >25 ms：旧 / 新第 1 批 / 新第 2 批 |
| --- | ---: | ---: | ---: |
| 普通文本 | 59.83 /s | 59.84 / 59.84 /s | 3/1,078 / 3/1,079 / 3/1,080 |
| 复杂 Markdown | 59.73 /s | 59.34 / 59.45 /s | 5/1,078 / 12/1,070 / 10/1,073 |
| 复杂 Markdown + 更新 | 57.89 /s | 59.12 / 59.06 /s | 38/1,044 / 16/1,066 / 17/1,064 |

每批每场景三轮。合并新实现两批：更新场景均值 59.09 /s，较本轮旧实现约 +2.1%，
长间隔比例 3.64% → 1.55%。静态复杂场景没有改善，且略有回落；旧实现更新场景
也有 58.84、58.84、56.00 /s 的轮次差异。
因此主要确定性收益是**消除无关 cell 重配置**，不能据此承诺真机满帧。
本轮不增加复杂行高缓存、不改代码块/表格排版；继续保留动态测量正确性，后续用
真机长帧调用栈决定是否值得进一步优化复杂行。

最终校验：Debug **14 项通过**（含工作量断言）；Release 两批各 **13 项通过**
（含 opt-in 帧测试）。Debug 有一项因主机休眠耗时约 650 秒：`pmset` 确认
13:16–13:27 的系统休眠，非应用长帧数据；Release 对应回归约 0.33 秒。
全部计时场景每轮约 6 秒，不把普通测试耗时作为帧性能证据。

原始记录：`/tmp/hapi-scroll-live-environment*`、`/tmp/hapi-scroll-baseline-control*`；
渲染预览和逐轮 JSON 留在各自 xcresult attachments，仅本地校验，未上传。

## Android：完整结果而非挑选最好轮次

初次运行，多数暖机轮的 FrameMetrics P95 为 4–7 ms，Choreographer 约 59.9 /s；
普通文本第一轮 P95 21.20 ms。此轮 64 MiB trace 环形缓冲只保留后五个场景；
应用 JSON/gfxinfo 九轮完整，但不把这份 trace 当成九轮完整证据。

扩大为 256 MiB，并加入真实拖动标记后的复测：

| 场景 / 轮次 | 拖动区间呈现频率 | 呈现间隔 P95 | 应用 deadline miss |
| --- | ---: | ---: | ---: |
| 普通文本 1 / 2 / 3 | 59.39 / 59.95 / 60.12 FPS | 24.90 / 19.21 / 18.10 ms | 3 / 0 / 0 |
| 复杂内容 1 / 2 / 3 | 51.66 / 49.55 / 60.13 FPS | 19.02 / 40.23 / 19.45 ms | 1 / 37 / 1 |
| 复杂内容 + 更新 1 / 2 / 3 | 59.78 / 59.60 / 47.58 FPS | 19.41 / 18.38 / 21.21 ms | 0 / 0 / 4 |

短采样窗口边界/时间戳抖动可让估计值略高于 60，不意味着设备超过刷新率。
最后一轮更新场景的 FrameMetrics 最大值 688.15 ms，不能用一个平均 FPS 隐藏它。
Trace 中有约 609 / 625 ms 的 `draw-VRI → postAndWait`，主线程等渲染线程；
也有长重组段。仅有 view/gfx 的 trace 无法判断这些段究竟在运行还是被抢占。
同期新模拟器的 GMS/Play Store 后台工作仍活跃；这只是环境竞争线索，不是定论。

控制实验：专用模拟器启用飞行模式、禁用 Play Store 自更新、等待 30 秒；
增加 `sched_switch` / `sched_waking` 和 process metadata。采到 495,548 条调度片段，
九个测试段均完整；**不修改应用业务代码**的结果：

| 场景 | 拖动区间呈现频率，三轮范围 | Window.FrameMetrics P95 | 应用 deadline miss |
| --- | ---: | ---: | ---: |
| 普通文本 | 60.04–60.13 FPS | 首轮 18.34 ms，后两轮 4.23–5.02 ms | 首轮 1，后两轮 0 |
| 复杂 Markdown | 60.00–60.05 FPS | 4.68–5.02 ms | 0 |
| 复杂 Markdown + 更新 | 59.32–59.75 FPS | 4.53–5.34 ms | 0 |

控制轮没有重现数百毫秒长帧；呈现间隔 P95 为 17.87–18.97 ms。所有运行的
FrameMetrics dropped reports 均为 0。结果支持**环境控制对 Android 模拟器测量
影响显著**，但多个环境变量一起改变，不能认定某个 GMS 任务就是唯一根因，
更不能声称应用优化消除了先前长帧。原始异常轮次仍保留。

## 下一轮优化顺序

1. **iOS 差量刷新已实现。** 数据/宽度变化走 diffable；环境和普通值捕获通过
   live SwiftUI wrapper 传播，不再靠消息更新时重配所有可见行。继续保留新增回归。
2. **iOS：减少复杂行的重复测量。** 优先复用 renderer-ready 内容与 hosting 配置；
   评估基于内容版本、宽度、字体的测量缓存。异步图片、展开态、代码高亮改变高度时
   必须失效。更长 Markdown 可评估按块虚拟化；不要先重写已是二分查询的列表索引。
3. **Android：先归因首轮/偶发长帧。** 结合调度、RenderThread/GPU、冷/暖缓存，
   再决定 Baseline Profile、文本布局缓存或复杂行预取。现有结果不足以支持
   “把 LazyColumn 重写一遍”或“已稳定满帧”的结论。
4. 后续验收补真实手势 iOS / 快速 fling / 分页提交 / 图片 / 键盘，最后在真机
   release/profile 构建上比较 P95/P99、deadline misses、内存；不把模拟器 FPS 设为 CI gate。

## 复测

```sh
# iOS：opt-in；默认 CI 跳过帧率诊断。脚本创建并删除自己的模拟器。
TEST_RUNNER_HAPI_SCROLL_PROFILE=1 ios/scripts/test-transcript.sh \
    -configuration Release ENABLE_TESTABILITY=YES SWIFT_EMIT_LOC_STRINGS=NO \
    -only-testing:HapiTests/TranscriptFrameProfileTests
# 可选：TEST_RUNNER_HAPI_SCROLL_SCENARIOS=rich,rich-updates

# Android：要求已安装对应 system image；所有 adb 操作绑定专用 emulator-5584。
ANDROID_HOME=/path/to/sdk HAPI_PROFILE_TRACE=1 \
    HAPI_PROFILE_OUTPUT=/tmp/hapi-frame-run android/scripts/profile-transcript.sh
# Intel/Linux 主机替换为本机已安装的 x86_64 system image：
# HAPI_PROFILE_SYSTEM_IMAGE='system-images;android-35;google_apis;x86_64'

# 使用 Perfetto 官方 trace_processor 离线分析，不上传 trace：
trace_processor /tmp/hapi-frame-run/hapi-scroll.pftrace \
    -q android/scripts/scroll-frame-summary.sql
```

Android trace 必须包含全部 9 个 `HapiScroll` 段与每段 8 个 `HapiGesture`。
本机 `ftrace_setup_errors=36` 为部分系统类别/事件不可用；已采到的应用段、
FrameTimeline 仍可使用，不能把缺失事件推断成零工作。

配套摘要：`performance/native-scroll-2026-09-10.json`。原始 JSON 数组 / gfxinfo /
Perfetto / xcresult / sample 位于本机 `/tmp/hapi-scroll-frame-*`，未提交大型 trace。
